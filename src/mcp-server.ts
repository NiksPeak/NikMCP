import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { enqueueAndAwait, chooseContext, isAlive } from "./queue.js";
import { getDiag } from "./bridge.js";
import { gateToolCall } from "./settings.js";
import { rgbaToPng } from "./png-encoder.js";
import type { Context, CommandResult } from "./types.js";

// The Claude Code MCP client JSON-stringifies object-valued args for loosely-typed
// (z.any) fields, so serialized datatypes like {__t:"Color3",...} or a build object
// arrive as a JSON string instead of an object. Re-parse ONLY object/array-shaped
// strings back to objects; leave scalars (number/bool/plain string) and already-parsed
// objects untouched so the paths that already work keep working.
function objectArg() {
  return z.preprocess((v) => {
    if (typeof v === "string") {
      const s = v.trim();
      if (s.startsWith("{") || s.startsWith("[")) {
        try {
          return JSON.parse(s);
        } catch {
          return v;
        }
      }
    }
    return v;
  }, z.any());
}

function renderResult(r: CommandResult) {
  if (!r.ok) {
    // Studio handlers return the reason as `err`; the type calls it `error`.
    // Read both so clear "not supported (reason)" messages actually reach the client.
    const reason = r.error ?? (r as { err?: string }).err ?? "unknown error";
    return {
      isError: true,
      content: [{ type: "text" as const, text: reason }],
    };
  }
  // Image content (capture_viewport): the plugin sends RAW RGBA (base64) + dims;
  // the PNG is encoded here in Node so the heavy encode never blocks Studio's poll
  // loop. (Legacy { image } base64-PNG shape is still accepted as a fallback.)
  const res = r.result as
    | { image?: string; mimeType?: string; rgba?: string; width?: number; height?: number }
    | undefined;
  if (res && typeof res === "object") {
    if (typeof res.rgba === "string" && typeof res.width === "number" && typeof res.height === "number") {
      try {
        const png = rgbaToPng(Buffer.from(res.rgba, "base64"), res.width, res.height);
        return {
          content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `capture_viewport: PNG encode failed: ${String(e)}` }],
        };
      }
    }
    if (typeof res.image === "string") {
      return {
        content: [
          { type: "image" as const, data: res.image, mimeType: res.mimeType ?? "image/png" },
        ],
      };
    }
  }
  const text = [
    r.output,
    r.result !== undefined ? JSON.stringify(r.result, null, 2) : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { content: [{ type: "text" as const, text: text || "(no output)" }] };
}

function blocked(reason: string) {
  return { isError: true, content: [{ type: "text" as const, text: reason }] };
}

export async function startMcpServer(cfg: AppConfig): Promise<void> {
  const server = new McpServer({ name: "roblox-studio-mcp", version: "0.2.0" });

  const contextArg = z
    .enum(["auto", "edit", "server"])
    .default("auto")
    .describe(
      "Which Studio context to target. 'server' = the running F5 playtest server."
    );

  // Gate -> enqueue -> render. The server enforces the plugin's settings here so
  // a disabled (or read-only-blocked) tool never reaches Studio.
  async function call(name: string, ctx: Context, payload: unknown) {
    const reason = gateToolCall(name);
    if (reason) {
      return blocked(reason);
    }
    const r = await enqueueAndAwait(name, ctx, payload, cfg.commandTimeoutMs);
    return renderResult(r);
  }

  // Stop a playtest. EndTest is only legal from the run DataModel, so route stop to
  // the live server agent -- that is what actually ends the test. EndTest tears that
  // DM down, so the agent's /response POST may never arrive: if the server context
  // goes dead after we send stop, the test ended => SUCCESS (not a timeout). Falls
  // back to the edit-side warn+EndTest for manually-started tests with no live agent.
  async function stopPlaytest(payload: unknown) {
    const reason = gateToolCall("playtest_control");
    if (reason) return blocked(reason);
    if (isAlive("server")) {
      try {
        const r = await enqueueAndAwait("playtest_control", "server", payload, 6000);
        return renderResult(r);
      } catch {
        if (!isAlive("server")) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "playtest stopped: EndTest ran in the run DataModel and tore it " +
                  "down (server agent disconnected, as expected).",
              },
            ],
          };
        }
        // server still alive but no response -> fall through to the edit fallback
      }
    }
    return call("playtest_control", "edit", payload);
  }

  // ----- existing core tools ------------------------------------------------
  server.registerTool(
    "run_luau",
    {
      title: "Run Luau",
      description:
        "Execute Luau in Studio and return printed output and any returned value. " +
        "Use context='server' to run inside the live F5 playtest server.",
      inputSchema: { code: z.string(), context: contextArg },
    },
    async ({ code, context }) => call("run_luau", chooseContext(context), { code })
  );

  server.registerTool(
    "get_instance_tree",
    {
      title: "Get Instance Tree",
      description:
        "Return the DataModel tree from a root path (default game), depth-limited.",
      inputSchema: {
        path: z.string().default("game"),
        maxDepth: z.number().int().min(1).max(20).default(4),
        context: contextArg,
      },
    },
    async ({ path, maxDepth, context }) =>
      call("get_instance_tree", chooseContext(context), { path, maxDepth })
  );

  server.registerTool(
    "set_property",
    {
      title: "Set Property",
      description:
        "Set a property on an instance (edit context wraps it in undo history).",
      inputSchema: {
        path: z.string(),
        property: z.string(),
        value: objectArg(),
        context: contextArg,
      },
    },
    async ({ path, property, value, context }) =>
      call("set_property", chooseContext(context), { path, property, value })
  );

  server.registerTool(
    "write_script",
    {
      title: "Write Script Source",
      description:
        "Set a script's source via ScriptEditorService (edit context only). " +
        "Creates the script if missing when 'className' is provided.",
      inputSchema: {
        path: z.string(),
        source: z.string(),
        className: z.enum(["Script", "LocalScript", "ModuleScript"]).optional(),
      },
    },
    async ({ path, source, className }) =>
      call("write_script", "edit", { path, source, className })
  );

  server.registerTool(
    "enable_playtest_agent",
    {
      title: "Enable Playtest Agent",
      description:
        "Arm the runtime agent Script in ServerScriptService so the bridge stays " +
        "connected during F5 playtest. Idempotent; arming persists.",
      inputSchema: {},
    },
    async () => call("enable_playtest_agent", "edit", {})
  );

  // ----- Phase B: read / inspect tools --------------------------------------
  server.registerTool(
    "read_console",
    {
      title: "Read Console",
      description:
        "Return recent Studio Output (LogService history + a live ring buffer). " +
        "Highest-value tool for debugging.",
      inputSchema: {
        count: z.number().int().min(1).max(500).default(100),
        levelFilter: z.enum(["error", "warning", "output"]).optional(),
        context: contextArg,
      },
    },
    async ({ count, levelFilter, context }) =>
      call("read_console", chooseContext(context), { count, levelFilter })
  );

  server.registerTool(
    "get_selection",
    {
      title: "Get Selection",
      description: "Return the current Studio selection as instance paths (+ class/name).",
      inputSchema: { context: contextArg },
    },
    async ({ context }) => call("get_selection", chooseContext(context), {})
  );

  server.registerTool(
    "search_instances",
    {
      title: "Search Instances",
      description:
        "Find instances by name substring, className, and/or CollectionService tag.",
      inputSchema: {
        query: z.string().optional(),
        className: z.string().optional(),
        tag: z.string().optional(),
        root: z.string().default("game"),
        limit: z.number().int().min(1).max(1000).default(100),
        context: contextArg,
      },
    },
    async ({ query, className, tag, root, limit, context }) =>
      call("search_instances", chooseContext(context), {
        query,
        className,
        tag,
        root,
        limit,
      })
  );

  server.registerTool(
    "get_script_source",
    {
      title: "Get Script Source",
      description:
        "Read a script's source (ScriptEditorService:GetEditorSource, fallback .Source).",
      inputSchema: { path: z.string(), context: contextArg },
    },
    async ({ path, context }) =>
      call("get_script_source", chooseContext(context), { path })
  );

  server.registerTool(
    "list_scripts",
    {
      title: "List Scripts",
      description:
        "List paths + classNames of all Script/LocalScript/ModuleScript under a root.",
      inputSchema: { root: z.string().default("game"), context: contextArg },
    },
    async ({ root, context }) => call("list_scripts", chooseContext(context), { root })
  );

  server.registerTool(
    "get_place_info",
    {
      title: "Get Place Info",
      description:
        "Compact orientation: place/game id, key services, top-level child counts, " +
        "selection count, camera CFrame. One call to get bearings.",
      inputSchema: { context: contextArg },
    },
    async ({ context }) => call("get_place_info", chooseContext(context), {})
  );

  server.registerTool(
    "get_tagged",
    {
      title: "Get Tagged",
      description: "CollectionService:GetTagged(tag) -> instance paths.",
      inputSchema: { tag: z.string(), context: contextArg },
    },
    async ({ tag, context }) => call("get_tagged", chooseContext(context), { tag })
  );

  server.registerTool(
    "get_properties",
    {
      title: "Get Properties",
      description:
        "Curated common-property dump for an instance (not exhaustive; Luau has no " +
        "full reflection). Pass propertyNames for an explicit list.",
      inputSchema: {
        path: z.string(),
        propertyNames: z.array(z.string()).optional(),
        context: contextArg,
      },
    },
    async ({ path, propertyNames, context }) =>
      call("get_properties", chooseContext(context), { path, propertyNames })
  );

  // ----- Phase C: write / edit tools ----------------------------------------
  server.registerTool(
    "set_selection",
    {
      title: "Set Selection",
      description: "Set the Studio selection to the given instance paths.",
      inputSchema: { paths: z.array(z.string()), context: contextArg },
    },
    async ({ paths, context }) => call("set_selection", chooseContext(context), { paths })
  );

  server.registerTool(
    "create_instance",
    {
      title: "Create Instance",
      description: "Create an instance under parentPath, with optional name + properties.",
      inputSchema: {
        className: z.string(),
        parentPath: z.string(),
        name: z.string().optional(),
        properties: z.record(z.string(), z.any()).optional(),
        context: contextArg,
      },
    },
    async ({ className, parentPath, name, properties, context }) =>
      call("create_instance", chooseContext(context), {
        className,
        parentPath,
        name,
        properties,
      })
  );

  server.registerTool(
    "delete_instance",
    {
      title: "Delete Instance",
      description: "Destroy the instance at path.",
      inputSchema: { path: z.string(), context: contextArg },
    },
    async ({ path, context }) => call("delete_instance", chooseContext(context), { path })
  );

  server.registerTool(
    "clone_instance",
    {
      title: "Clone Instance",
      description: "Clone the instance at path into parentPath (default its own parent).",
      inputSchema: {
        path: z.string(),
        parentPath: z.string().optional(),
        context: contextArg,
      },
    },
    async ({ path, parentPath, context }) =>
      call("clone_instance", chooseContext(context), { path, parentPath })
  );

  server.registerTool(
    "rename_instance",
    {
      title: "Rename Instance",
      description: "Rename the instance at path.",
      inputSchema: { path: z.string(), name: z.string(), context: contextArg },
    },
    async ({ path, name, context }) =>
      call("rename_instance", chooseContext(context), { path, name })
  );

  server.registerTool(
    "set_parent",
    {
      title: "Set Parent",
      description: "Reparent the instance at path under parentPath.",
      inputSchema: { path: z.string(), parentPath: z.string(), context: contextArg },
    },
    async ({ path, parentPath, context }) =>
      call("set_parent", chooseContext(context), { path, parentPath })
  );

  server.registerTool(
    "move_instance",
    {
      title: "Move Instance",
      description:
        "Move a PVInstance to a CFrame or position (serialized datatype value).",
      inputSchema: {
        path: z.string(),
        cframe: objectArg().optional(),
        position: objectArg().optional(),
        context: contextArg,
      },
    },
    async ({ path, cframe, position, context }) =>
      call("move_instance", chooseContext(context), { path, cframe, position })
  );

  server.registerTool(
    "bulk_set_property",
    {
      title: "Bulk Set Property",
      description: "Set one property across many instances in a single undoable batch.",
      inputSchema: {
        paths: z.array(z.string()),
        property: z.string(),
        value: objectArg(),
        context: contextArg,
      },
    },
    async ({ paths, property, value, context }) =>
      call("bulk_set_property", chooseContext(context), { paths, property, value })
  );

  server.registerTool(
    "tag_instance",
    {
      title: "Tag Instance",
      description: "Add a CollectionService tag to the instance at path.",
      inputSchema: { path: z.string(), tag: z.string(), context: contextArg },
    },
    async ({ path, tag, context }) =>
      call("tag_instance", chooseContext(context), { path, tag })
  );

  server.registerTool(
    "untag_instance",
    {
      title: "Untag Instance",
      description: "Remove a CollectionService tag from the instance at path.",
      inputSchema: { path: z.string(), tag: z.string(), context: contextArg },
    },
    async ({ path, tag, context }) =>
      call("untag_instance", chooseContext(context), { path, tag })
  );

  server.registerTool(
    "insert_asset",
    {
      title: "Insert Asset",
      description:
        "InsertService:LoadAsset(assetId) then parent it (default Workspace). " +
        "Asset must be owned or public.",
      inputSchema: {
        assetId: z.number().int(),
        parentPath: z.string().optional(),
        context: contextArg,
      },
    },
    async ({ assetId, parentPath, context }) =>
      call("insert_asset", chooseContext(context), { assetId, parentPath })
  );

  // ----- Phase D / Batch 1: viewport + playtest -----------------------------
  server.registerTool(
    "capture_viewport",
    {
      title: "Capture Viewport",
      description:
        "Screenshot the Studio viewport and return it as a PNG image. ONLY works " +
        "in Edit mode with the Studio viewport visible and rendering (this is a " +
        "Roblox engine limit -- capture reads the rendered screen; playtest-view " +
        "capture is not supported). Requires Game Settings > Security > 'Allow " +
        "Mesh / Image APIs' (EditableImage); if off, returns a clear enable-this " +
        "message. Always runs in the edit context.",
      inputSchema: { context: contextArg },
    },
    // Pinned to edit (ignores the context arg): capture is render-bound and the
    // server agent has no viewport, so routing to it (the "auto" default during a
    // playtest) would hit "agent does not support command: capture_viewport".
    async ({ context: _context }) => call("capture_viewport", "edit", {})
  );

  server.registerTool(
    "playtest_control",
    {
      title: "Playtest Control",
      description:
        "Start a playtest via StudioTestService (mode='run' = F8/Run, mode='play' = " +
        "F5/Play Solo, optional numPlayers 1-8). It runs in a SEPARATE DataModel, so " +
        "confirm it is live with get_playtest_status (running/agentConnected) -- not the " +
        "start return alone. Do checks via get_playtest_output / run_luau context='server', " +
        "then call action='stop' when done -- DO NOT leave a playtest running. Use " +
        "get_playtest_status first to see if one is already live before starting another.",
      inputSchema: {
        action: z.enum(["start", "stop"]),
        mode: z.enum(["play", "run"]).default("run"),
        numPlayers: z.number().int().min(1).max(8).optional(),
        context: contextArg,
      },
    },
    async ({ action, mode, numPlayers, context: _context }) =>
      // start: StudioTestService start runs in the edit plugin. stop: route to the
      // live server agent so EndTest runs from the run DataModel (the only context
      // where EndTest is legal); stopPlaytest falls back to edit when no agent is up.
      action === "stop"
        ? stopPlaytest({ action, mode, numPlayers })
        : call("playtest_control", "edit", { action, mode, numPlayers })
  );

  server.registerTool(
    "get_playtest_output",
    {
      title: "Get Playtest Output",
      description:
        "Drain (or peek with drain:false) the playtest log buffer captured since " +
        "playtest_control start — print/warn/error lines from the run. Returns logs " +
        "since the playtest started; once you have what you need, stop the playtest " +
        "with playtest_control action='stop' so it doesn't keep running.",
      inputSchema: { drain: z.boolean().default(true), context: contextArg },
    },
    async ({ drain, context: _context }) =>
      // Always edit: the playtest log buffer lives in the edit plugin (it captures
      // the run's output). Routing to the live server agent yields "agent does not
      // support command: get_playtest_output" (same class as the playtest_control pin).
      call("get_playtest_output", "edit", { drain })
  );

  // ----- Batch 2: attributes ------------------------------------------------
  server.registerTool(
    "get_attribute",
    {
      title: "Get Attribute",
      description: "Get one attribute value from an instance (Instance:GetAttribute).",
      inputSchema: { path: z.string(), name: z.string(), context: contextArg },
    },
    async ({ path, name, context }) =>
      call("get_attribute", chooseContext(context), { path, name })
  );

  server.registerTool(
    "get_attributes",
    {
      title: "Get Attributes",
      description: "Get all attributes of an instance (Instance:GetAttributes).",
      inputSchema: { path: z.string(), context: contextArg },
    },
    async ({ path, context }) => call("get_attributes", chooseContext(context), { path })
  );

  server.registerTool(
    "set_attribute",
    {
      title: "Set Attribute",
      description: "Set one attribute on an instance (serialized value).",
      inputSchema: {
        path: z.string(),
        name: z.string(),
        value: objectArg(),
        context: contextArg,
      },
    },
    async ({ path, name, value, context }) =>
      call("set_attribute", chooseContext(context), { path, name, value })
  );

  server.registerTool(
    "set_attributes",
    {
      title: "Set Attributes",
      description: "Set many attributes on one instance in a single undoable batch.",
      inputSchema: {
        path: z.string(),
        attributes: z.record(z.string(), z.any()),
        context: contextArg,
      },
    },
    async ({ path, attributes, context }) =>
      call("set_attributes", chooseContext(context), { path, attributes })
  );

  server.registerTool(
    "delete_attribute",
    {
      title: "Delete Attribute",
      description: "Delete an attribute from an instance (SetAttribute(name, nil)).",
      inputSchema: { path: z.string(), name: z.string(), context: contextArg },
    },
    async ({ path, name, context }) =>
      call("delete_attribute", chooseContext(context), { path, name })
  );

  // ----- Batch 3: script editing depth --------------------------------------
  server.registerTool(
    "edit_script_lines",
    {
      title: "Edit Script Lines",
      description:
        "Replace an inclusive 1-based line range [startLine,endLine] in a script " +
        "with newText (may be multi-line). Edit context only.",
      inputSchema: {
        path: z.string(),
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1),
        newText: z.string(),
      },
    },
    async ({ path, startLine, endLine, newText }) =>
      call("edit_script_lines", "edit", { path, startLine, endLine, newText })
  );

  server.registerTool(
    "insert_script_lines",
    {
      title: "Insert Script Lines",
      description:
        "Insert newText before 1-based line (append if beyond end). Edit context only.",
      inputSchema: { path: z.string(), line: z.number().int().min(1), newText: z.string() },
    },
    async ({ path, line, newText }) =>
      call("insert_script_lines", "edit", { path, line, newText })
  );

  server.registerTool(
    "delete_script_lines",
    {
      title: "Delete Script Lines",
      description: "Delete an inclusive 1-based line range. Edit context only.",
      inputSchema: {
        path: z.string(),
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1),
      },
    },
    async ({ path, startLine, endLine }) =>
      call("delete_script_lines", "edit", { path, startLine, endLine })
  );

  server.registerTool(
    "find_and_replace_in_scripts",
    {
      title: "Find & Replace In Scripts",
      description:
        "Find/replace across every script under root (default game). regex:true uses " +
        "Luau string patterns; otherwise plain text. Edit context only.",
      inputSchema: {
        find: z.string(),
        replace: z.string().default(""),
        root: z.string().default("game"),
        regex: z.boolean().default(false),
      },
    },
    async ({ find, replace, root, regex }) =>
      call("find_and_replace_in_scripts", "edit", { find, replace, root, regex })
  );

  server.registerTool(
    "grep_scripts",
    {
      title: "Grep Scripts",
      description:
        "Search scripts under root for a pattern; returns { path, line, text } matches. " +
        "regex:true uses Luau patterns, else plain text.",
      inputSchema: {
        pattern: z.string(),
        root: z.string().default("game"),
        regex: z.boolean().default(false),
        limit: z.number().int().min(1).max(5000).default(500),
        context: contextArg,
      },
    },
    async ({ pattern, root, regex, limit, context }) =>
      call("grep_scripts", chooseContext(context), { pattern, root, regex, limit })
  );

  server.registerTool(
    "get_script_analysis",
    {
      title: "Get Script Analysis",
      description:
        "Compile-check a script (loadstring) and report syntax diagnostics. Luau has " +
        "no full static analysis from a plugin, so this is a compile pass.",
      inputSchema: { path: z.string(), context: contextArg },
    },
    async ({ path, context }) =>
      call("get_script_analysis", chooseContext(context), { path })
  );

  // ----- Batch 4: undo / redo + mass ops ------------------------------------
  server.registerTool(
    "undo",
    {
      title: "Undo",
      description: "ChangeHistoryService:Undo(). Edit context only.",
      inputSchema: {},
    },
    async () => call("undo", "edit", {})
  );

  server.registerTool(
    "redo",
    {
      title: "Redo",
      description: "ChangeHistoryService:Redo(). Edit context only.",
      inputSchema: {},
    },
    async () => call("redo", "edit", {})
  );

  server.registerTool(
    "mass_create_objects",
    {
      title: "Mass Create Objects",
      description:
        "Create many instances in one undoable batch. items: [{ className, " +
        "parentPath, name?, properties? }].",
      inputSchema: {
        items: z.array(
          z.object({
            className: z.string(),
            parentPath: z.string(),
            name: z.string().optional(),
            properties: z.record(z.string(), z.any()).optional(),
          })
        ),
        context: contextArg,
      },
    },
    async ({ items, context }) =>
      call("mass_create_objects", chooseContext(context), { items })
  );

  server.registerTool(
    "mass_duplicate",
    {
      title: "Mass Duplicate",
      description:
        "Clone an instance count times into its parent, each cumulatively offset by " +
        "offset (serialized Vector3). One undoable batch.",
      inputSchema: {
        path: z.string(),
        count: z.number().int().min(1).max(1000),
        offset: objectArg().optional(),
        context: contextArg,
      },
    },
    async ({ path, count, offset, context }) =>
      call("mass_duplicate", chooseContext(context), { path, count, offset })
  );

  server.registerTool(
    "smart_duplicate",
    {
      title: "Smart Duplicate",
      description:
        "Clone with a layout. mode='grid' (default) tiles by columns + spacing " +
        "(Vector3); mode='line' steps by spacing*i. One undoable batch.",
      inputSchema: {
        path: z.string(),
        count: z.number().int().min(1).max(1000),
        mode: z.enum(["grid", "line"]).default("grid"),
        columns: z.number().int().min(1).optional(),
        spacing: objectArg().optional(),
        context: contextArg,
      },
    },
    async ({ path, count, mode, columns, spacing, context }) =>
      call("smart_duplicate", chooseContext(context), { path, count, mode, columns, spacing })
  );

  server.registerTool(
    "mass_get_property",
    {
      title: "Mass Get Property",
      description: "Read one property across many instances. { paths[], property }.",
      inputSchema: {
        paths: z.array(z.string()),
        property: z.string(),
        context: contextArg,
      },
    },
    async ({ paths, property, context }) =>
      call("mass_get_property", chooseContext(context), { paths, property })
  );

  server.registerTool(
    "mass_set_property",
    {
      title: "Mass Set Property",
      description:
        "Set one property across many instances in a single undoable batch " +
        "(same as bulk_set_property).",
      inputSchema: {
        paths: z.array(z.string()),
        property: z.string(),
        value: objectArg(),
        context: contextArg,
      },
    },
    async ({ paths, property, value, context }) =>
      call("mass_set_property", chooseContext(context), { paths, property, value })
  );

  // ----- Batch 5: deeper inspection -----------------------------------------
  server.registerTool(
    "get_class_info",
    {
      title: "Get Class Info",
      description:
        "Best-effort class info: creatable? + which curated properties apply. Luau " +
        "has no full reflection from a plugin (no API dump bundled) — documented in note.",
      inputSchema: { className: z.string(), context: contextArg },
    },
    async ({ className, context }) =>
      call("get_class_info", chooseContext(context), { className })
  );

  server.registerTool(
    "get_services",
    {
      title: "Get Services",
      description: "List the loaded services (children of game) with classNames.",
      inputSchema: { context: contextArg },
    },
    async ({ context }) => call("get_services", chooseContext(context), {})
  );

  server.registerTool(
    "get_descendants",
    {
      title: "Get Descendants",
      description: "Flat list of descendant paths under a root, optional depth limit (cap 5000).",
      inputSchema: {
        path: z.string().default("game"),
        maxDepth: z.number().int().min(1).max(50).optional(),
        context: contextArg,
      },
    },
    async ({ path, maxDepth, context }) =>
      call("get_descendants", chooseContext(context), { path, maxDepth })
  );

  server.registerTool(
    "get_connected_instances",
    {
      title: "Get Connected Instances",
      description:
        "Instances connected to this one: BasePart:GetConnectedParts(true) + object-" +
        "valued properties (Part0/1, Attachment0/1, PrimaryPart, Adornee).",
      inputSchema: { path: z.string(), context: contextArg },
    },
    async ({ path, context }) =>
      call("get_connected_instances", chooseContext(context), { path })
  );

  server.registerTool(
    "compare_instances",
    {
      title: "Compare Instances",
      description: "Diff two instances across the curated property set.",
      inputSchema: { pathA: z.string(), pathB: z.string(), context: contextArg },
    },
    async ({ pathA, pathB, context }) =>
      call("compare_instances", chooseContext(context), { pathA, pathB })
  );

  server.registerTool(
    "get_project_structure",
    {
      title: "Get Project Structure",
      description: "Per-service child counts + children-by-class breakdown.",
      inputSchema: { context: contextArg },
    },
    async ({ context }) => call("get_project_structure", chooseContext(context), {})
  );

  server.registerTool(
    "get_file_tree",
    {
      title: "Get File Tree",
      description: "Nested tree of scripts under a root (branches containing scripts only).",
      inputSchema: { root: z.string().default("game"), context: contextArg },
    },
    async ({ root, context }) => call("get_file_tree", chooseContext(context), { root })
  );

  server.registerTool(
    "set_properties",
    {
      title: "Set Properties",
      description: "Set many properties on one instance in a single undoable batch.",
      inputSchema: {
        path: z.string(),
        properties: z.record(z.string(), z.any()),
        context: contextArg,
      },
    },
    async ({ path, properties, context }) =>
      call("set_properties", chooseContext(context), { path, properties })
  );

  server.registerTool(
    "search_by_property",
    {
      title: "Search By Property",
      description:
        "Find instances under root whose property equals value (serialized). " +
        "Compares by datatype equality.",
      inputSchema: {
        property: z.string(),
        value: objectArg(),
        root: z.string().default("game"),
        limit: z.number().int().min(1).max(1000).default(100),
        context: contextArg,
      },
    },
    async ({ property, value, root, limit, context }) =>
      call("search_by_property", chooseContext(context), { property, value, root, limit })
  );

  server.registerTool(
    "get_tags",
    {
      title: "Get Tags",
      description: "CollectionService:GetTags(instance) for one instance.",
      inputSchema: { path: z.string(), context: contextArg },
    },
    async ({ path, context }) => call("get_tags", chooseContext(context), { path })
  );

  // ----- Batch 6: assets / marketplace --------------------------------------
  server.registerTool(
    "get_asset_details",
    {
      title: "Get Asset Details",
      description: "MarketplaceService:GetProductInfo(assetId) -> name, creator, price, etc.",
      inputSchema: { assetId: z.number().int(), context: contextArg },
    },
    async ({ assetId, context }) =>
      call("get_asset_details", chooseContext(context), { assetId })
  );

  server.registerTool(
    "get_asset_thumbnail",
    {
      title: "Get Asset Thumbnail",
      description: "Return a usable rbxthumb:// content id for an asset's thumbnail.",
      inputSchema: {
        assetId: z.number().int(),
        size: z.number().int().optional(),
        context: contextArg,
      },
    },
    async ({ assetId, size, context }) =>
      call("get_asset_thumbnail", chooseContext(context), { assetId, size })
  );

  server.registerTool(
    "preview_asset",
    {
      title: "Preview Asset",
      description: "GetProductInfo + thumbnail content id for a quick asset preview.",
      inputSchema: { assetId: z.number().int(), context: contextArg },
    },
    async ({ assetId, context }) =>
      call("preview_asset", chooseContext(context), { assetId })
  );

  server.registerTool(
    "search_materials",
    {
      title: "Search Materials",
      description: "List built-in Enum.Material names, optionally filtered by query.",
      inputSchema: { query: z.string().optional(), context: contextArg },
    },
    async ({ query, context }) =>
      call("search_materials", chooseContext(context), { query })
  );

  server.registerTool(
    "search_assets",
    {
      title: "Search Assets",
      description:
        "Catalog search. UNSUPPORTED from a plugin (needs Open Cloud / web API) — " +
        "returns a clear reason.",
      inputSchema: {
        query: z.string(),
        type: z.string().optional(),
        context: contextArg,
      },
    },
    async ({ query, type, context }) =>
      call("search_assets", chooseContext(context), { query, type })
  );

  server.registerTool(
    "list_library",
    {
      title: "List Library",
      description:
        "List your inventory/library. UNSUPPORTED from a plugin (needs Open Cloud) — " +
        "returns a clear reason.",
      inputSchema: { context: contextArg },
    },
    async ({ context }) => call("list_library", chooseContext(context), {})
  );

  server.registerTool(
    "upload_decal",
    {
      title: "Upload Decal",
      description:
        "Publish an image as a decal. UNSUPPORTED from a plugin (needs Open Cloud " +
        "Assets API key) — returns a clear reason.",
      inputSchema: { context: contextArg },
    },
    async ({ context }) => call("upload_decal", chooseContext(context), {})
  );

  // ----- Batch 7: input simulation ------------------------------------------
  server.registerTool(
    "simulate_keyboard_input",
    {
      title: "Simulate Keyboard Input",
      description:
        "Send a key event via VirtualInputManager. Restricted (RobloxScriptSecurity) — " +
        "typically unsupported from a plugin; returns a clear reason when blocked.",
      inputSchema: {
        key: z.string(),
        action: z.enum(["press", "down", "up"]).default("press"),
        context: contextArg,
      },
    },
    async ({ key, action, context }) =>
      call("simulate_keyboard_input", chooseContext(context), { key, action })
  );

  server.registerTool(
    "simulate_mouse_input",
    {
      title: "Simulate Mouse Input",
      description:
        "Send a mouse move/button event via VirtualInputManager. Restricted " +
        "(RobloxScriptSecurity) — typically unsupported; returns a clear reason when blocked.",
      inputSchema: {
        action: z.enum(["move", "down", "up"]).default("move"),
        x: z.number().default(0),
        y: z.number().default(0),
        button: z.number().int().min(0).max(2).default(0),
        context: contextArg,
      },
    },
    async ({ action, x, y, button, context }) =>
      call("simulate_mouse_input", chooseContext(context), { action, x, y, button })
  );

  server.registerTool(
    "character_navigation",
    {
      title: "Character Navigation",
      description:
        "Move the player character toward a position (Humanoid:MoveTo). Needs a running " +
        "playtest; use context='server'. Unsupported in edit (no character).",
      inputSchema: { position: objectArg(), context: contextArg },
    },
    async ({ position, context }) =>
      call("character_navigation", chooseContext(context), { position })
  );

  // ----- Task 16 Batch A: build / scene / UI tree / file search -------------
  server.registerTool(
    "export_build",
    {
      title: "Export Build",
      description:
        "Serialize the subtree at path to a build JSON (className, name, curated " +
        "properties, attributes, tags, children). Depth-capped. Round-trips with import_build.",
      inputSchema: {
        path: z.string(),
        maxDepth: z.number().int().min(1).max(20).default(8),
        context: contextArg,
      },
    },
    async ({ path, maxDepth, context }) =>
      call("export_build", chooseContext(context), { path, maxDepth })
  );

  server.registerTool(
    "create_build",
    {
      title: "Create Build",
      description:
        "Like export_build but returns it tagged as a named build artifact " +
        "({ kind:'build', name, build }) for the AI to store and reuse later.",
      inputSchema: {
        path: z.string(),
        name: z.string().optional(),
        maxDepth: z.number().int().min(1).max(20).default(8),
        context: contextArg,
      },
    },
    async ({ path, name, maxDepth, context }) =>
      call("create_build", chooseContext(context), { path, name, maxDepth })
  );

  server.registerTool(
    "import_build",
    {
      title: "Import Build",
      description:
        "Instantiate a build JSON under parentPath (recursive Instance.new + " +
        "properties/attributes/tags via the serializer). One undo step.",
      inputSchema: {
        build: objectArg(),
        parentPath: z.string(),
        name: z.string().optional(),
        context: contextArg,
      },
    },
    async ({ build, parentPath, name, context }) =>
      call("import_build", chooseContext(context), { build, parentPath, name })
  );

  server.registerTool(
    "generate_build",
    {
      title: "Generate Build",
      description:
        "Generate instances from a compact spec. Supported: { kind:'grid', " +
        "className, rows, cols, spacing, parentPath, properties? } and { kind:'baseplate' }. One undo.",
      inputSchema: { spec: objectArg(), context: contextArg },
    },
    async ({ spec, context }) => call("generate_build", chooseContext(context), { spec })
  );

  server.registerTool(
    "create_keyframe_sequence",
    {
      title: "Create Keyframe Sequence",
      description:
        "Build a KeyframeSequence (nested Keyframe/Pose tree) from JSON for MANUAL upload. It is " +
        "collected in a shared folder (default ServerStorage/GeneratedAnimations, or under " +
        "parentPath if given, or a custom folderName) so you can right-click it -> Save to Roblox " +
        "or open it in the Animation Editor. Poses use the serializer's tagged CFrame form and are " +
        "matched to a rig by part name at PLAYBACK time. registerPreview returns a TEMPORARY, " +
        "session-only tempAnimationId (KeyframeSequenceProvider:RegisterKeyframeSequence) for " +
        "in-Studio preview only -- NOT a permanent uploaded AnimationId. One undo.",
      inputSchema: {
        parentPath: z.string().optional(),
        folderName: z.string().default("GeneratedAnimations"),
        name: z.string().default("Animation"),
        loop: z.boolean().default(false),
        priority: z
          .enum(["Idle", "Movement", "Action", "Action2", "Action3", "Action4", "Core"])
          .default("Action"),
        keyframes: objectArg(),
        registerPreview: z.boolean().default(true),
        context: contextArg,
      },
    },
    async ({ parentPath, folderName, name, loop, priority, keyframes, registerPreview, context }) =>
      call("create_keyframe_sequence", chooseContext(context), {
        parentPath,
        folderName,
        name,
        loop,
        priority,
        keyframes,
        registerPreview,
      })
  );

  // play_animation (task 22): the FIRST server/runtime-context write tool -- it plays
  // a track on a live rig during an F5 playtest (handled by RuntimeAgentSource). We
  // enforce the server-only rule here in Node: under edit context it returns the
  // specific "requires a running playtest" error rather than the generic agent miss.
  server.registerTool(
    "play_animation",
    {
      title: "Play Animation",
      description:
        "Play an AnimationId on a live rig's Animator during an F5 playtest. SERVER CONTEXT ONLY " +
        "(there is no simulation in edit). `target` is a path to a Humanoid/AnimationController rig, " +
        "or \"player\" for the playtest player's character. Returns the track Length (0 if not yet " +
        "streamed). Surfaces the real engine error (nil character, no Animator, asset not loaded).",
      inputSchema: {
        target: z.string(),
        animationId: z.union([z.string(), z.number()]),
        looped: z.boolean().optional(),
        priority: z
          .enum(["Idle", "Movement", "Action", "Action2", "Action3", "Action4", "Core"])
          .optional(),
        fadeTime: z.number().default(0.1),
        weight: z.number().default(1),
        speed: z.number().default(1),
        context: contextArg,
      },
    },
    async ({ target, animationId, looped, priority, fadeTime, weight, speed, context }) => {
      const reason = gateToolCall("play_animation");
      if (reason) return blocked(reason);
      const ctx = chooseContext(context);
      if (ctx !== "server") {
        return blocked("play_animation requires a running playtest (server context)");
      }
      return call("play_animation", ctx, {
        target,
        animationId,
        looped,
        priority,
        fadeTime,
        weight,
        speed,
      });
    }
  );

  server.registerTool(
    "create_sound",
    {
      title: "Create Sound",
      description:
        "Convenience wrapper over create_instance: create a Sound under parentPath with validated " +
        "props (coerced soundId, volume clamped 0-10, rollOff enum with fallback). One undo. " +
        "playOnCreate previews it with :Play() in edit mode.",
      inputSchema: {
        parentPath: z.string(),
        soundId: z.union([z.string(), z.number()]),
        name: z.string().default("Sound"),
        volume: z.number().default(0.5),
        looped: z.boolean().default(false),
        playbackSpeed: z.number().default(1),
        rollOffMode: z.enum(["Inverse", "Linear", "LinearSquare", "InverseTapered"]).optional(),
        rollOffMinDistance: z.number().optional(),
        rollOffMaxDistance: z.number().optional(),
        playOnCreate: z.boolean().default(false),
        context: contextArg,
      },
    },
    async ({
      parentPath,
      soundId,
      name,
      volume,
      looped,
      playbackSpeed,
      rollOffMode,
      rollOffMinDistance,
      rollOffMaxDistance,
      playOnCreate,
      context,
    }) =>
      call("create_sound", chooseContext(context), {
        parentPath,
        soundId,
        name,
        volume,
        looped,
        playbackSpeed,
        rollOffMode,
        rollOffMinDistance,
        rollOffMaxDistance,
        playOnCreate,
      })
  );

  server.registerTool(
    "set_lighting",
    {
      title: "Set Lighting",
      description:
        "Convenience over set_properties on Lighting plus optional child effects " +
        "(Atmosphere/Sky/BloomEffect/ColorCorrectionEffect/DepthOfFieldEffect/SunRaysEffect, " +
        "get-or-created one per class). Tagged Color3/Vector3 values via the serializer. Rejects " +
        "unknown property/effect names (named). One undo.",
      inputSchema: {
        properties: objectArg().optional(),
        effects: objectArg().optional(),
        context: contextArg,
      },
    },
    async ({ properties, effects, context }) =>
      call("set_lighting", chooseContext(context), { properties, effects })
  );

  server.registerTool(
    "import_scene",
    {
      title: "Import Scene",
      description:
        "Import a multi-root scene JSON ({ roots:[{ parentPath, build }] }). " +
        "mode='merge' (default) adds; mode='replace' clears each target first and requires confirm:true. One undo.",
      inputSchema: {
        scene: objectArg(),
        mode: z.enum(["merge", "replace"]).default("merge"),
        confirm: z.boolean().default(false),
        context: contextArg,
      },
    },
    async ({ scene, mode, confirm, context }) =>
      call("import_scene", chooseContext(context), { scene, mode, confirm })
  );

  server.registerTool(
    "create_ui_tree",
    {
      title: "Create UI Tree",
      description:
        "Build a GUI hierarchy from a nested spec (className/properties/children). " +
        "Default parent = a new ScreenGui in StarterGui. One undo.",
      inputSchema: {
        parentPath: z.string().optional(),
        tree: objectArg(),
        context: contextArg,
      },
    },
    async ({ parentPath, tree, context }) =>
      call("create_ui_tree", chooseContext(context), { parentPath, tree })
  );

  server.registerTool(
    "search_files",
    {
      title: "Search Files",
      description:
        "Match instance/script names AND full paths (distinct from grep_scripts, " +
        "which searches script content). Returns { path, className }.",
      inputSchema: {
        pattern: z.string(),
        root: z.string().default("game"),
        regex: z.boolean().default(false),
        limit: z.number().int().min(1).max(5000).default(500),
        context: contextArg,
      },
    },
    async ({ pattern, root, regex, limit, context }) =>
      call("search_files", chooseContext(context), { pattern, root, regex, limit })
  );

  // ----- Task 16 Batch B: raycast / bounds / camera / perf / group / align ---
  server.registerTool(
    "raycast",
    {
      title: "Raycast",
      description:
        "Workspace:Raycast from origin along direction (both [x,y,z]) up to maxDistance, " +
        "excluding ignorePaths. Returns { hit, hitPath, position, normal, material, distance }.",
      inputSchema: {
        origin: z.array(z.number()).length(3),
        direction: z.array(z.number()).length(3),
        maxDistance: z.number().positive().default(1000),
        ignorePaths: z.array(z.string()).optional(),
        context: contextArg,
      },
    },
    async ({ origin, direction, maxDistance, ignorePaths, context }) =>
      call("raycast", chooseContext(context), { origin, direction, maxDistance, ignorePaths })
  );

  server.registerTool(
    "get_bounding_box",
    {
      title: "Get Bounding Box",
      description:
        "World-space { cframe, size } for an instance (Model:GetBoundingBox or BasePart extents).",
      inputSchema: { path: z.string(), context: contextArg },
    },
    async ({ path, context }) => call("get_bounding_box", chooseContext(context), { path })
  );

  server.registerTool(
    "get_selection_bounds",
    {
      title: "Get Selection Bounds",
      description: "Combined world-space AABB ({ center, size, min, max }) of the current selection.",
      inputSchema: { context: contextArg },
    },
    async ({ context }) => call("get_selection_bounds", chooseContext(context), {})
  );

  server.registerTool(
    "get_camera",
    {
      title: "Get Camera",
      description: "Current workspace.CurrentCamera CFrame, position, and FieldOfView.",
      inputSchema: { context: contextArg },
    },
    async ({ context }) => call("get_camera", chooseContext(context), {})
  );

  server.registerTool(
    "set_camera",
    {
      title: "Set Camera",
      description:
        "Aim the Studio camera. Pass cframe (serialized), or position [x,y,z] with optional " +
        "lookAt [x,y,z]. View-only (not a place mutation), so allowed in read-only sessions.",
      inputSchema: {
        cframe: objectArg().optional(),
        position: z.array(z.number()).length(3).optional(),
        lookAt: z.array(z.number()).length(3).optional(),
        context: contextArg,
      },
    },
    async ({ cframe, position, lookAt, context }) =>
      call("set_camera", chooseContext(context), { cframe, position, lookAt })
  );

  server.registerTool(
    "focus_instance",
    {
      title: "Focus Instance",
      description:
        "Select an instance and frame the camera on it ('zoom to'). Pair with capture_viewport " +
        "to aim, then screenshot. Changes selection (write).",
      inputSchema: { path: z.string(), context: contextArg },
    },
    async ({ path, context }) => call("focus_instance", chooseContext(context), { path })
  );

  server.registerTool(
    "get_perf_stats",
    {
      title: "Get Perf Stats",
      description:
        "Performance snapshot: total instance count, part count, script count, and " +
        "Stats:GetTotalMemoryUsageMb. Check the impact of your edits.",
      inputSchema: { context: contextArg },
    },
    async ({ context }) => call("get_perf_stats", chooseContext(context), {})
  );

  server.registerTool(
    "group_instances",
    {
      title: "Group Instances",
      description:
        "Wrap the given paths into a new Model (PrimaryPart set to the first BasePart). One undo.",
      inputSchema: {
        paths: z.array(z.string()),
        name: z.string().optional(),
        context: contextArg,
      },
    },
    async ({ paths, name, context }) =>
      call("group_instances", chooseContext(context), { paths, name })
  );

  server.registerTool(
    "ungroup_instance",
    {
      title: "Ungroup Instance",
      description: "Dissolve a Model/Folder, reparenting its children to its parent. One undo.",
      inputSchema: { path: z.string(), context: contextArg },
    },
    async ({ path, context }) => call("ungroup_instance", chooseContext(context), { path })
  );

  server.registerTool(
    "align_instances",
    {
      title: "Align Instances",
      description:
        "Align/space parts along an axis. mode 'min'|'center'|'max' aligns to that edge/center; " +
        "'distribute' spaces evenly (or by 'spacing' if given). One undo.",
      inputSchema: {
        paths: z.array(z.string()),
        axis: z.enum(["x", "y", "z"]),
        mode: z.enum(["min", "center", "max", "distribute"]).default("center"),
        spacing: z.number().optional(),
        context: contextArg,
      },
    },
    async ({ paths, axis, mode, spacing, context }) =>
      call("align_instances", chooseContext(context), { paths, axis, mode, spacing })
  );

  server.registerTool(
    "measure_distance",
    {
      title: "Measure Distance",
      description: "World-space distance between two instances' pivots.",
      inputSchema: { pathA: z.string(), pathB: z.string(), context: contextArg },
    },
    async ({ pathA, pathB, context }) =>
      call("measure_distance", chooseContext(context), { pathA, pathB })
  );

  // ----- Task 17 Batch A: playtest lifecycle awareness ----------------------
  // Ungated (like get_status). Studio-side fields come from the edit Executor;
  // agentConnected is the bridge's `server` liveness. The agent polls this to
  // know a playtest is live and how long it has been going, so it can stop it.
  server.registerTool(
    "get_playtest_status",
    {
      title: "Get Playtest Status",
      description:
        "Report whether a playtest is live: { running, mode, startedAtUnix, durationSec, " +
        "players, agentConnected }. Poll this to decide when to stop a playtest you started " +
        "with playtest_control — stop it once you have what you need.",
      inputSchema: {},
    },
    async () => {
      let studio: Record<string, unknown> = {};
      try {
        const r = await enqueueAndAwait("get_playtest_status", "edit", {}, 5000);
        if (r.ok && r.result && typeof r.result === "object") {
          studio = r.result as Record<string, unknown>;
        }
      } catch {
        // no edit context polling (Studio closed / not connected) -> degraded status
      }
      // Authoritative liveness: the runtime agent's `server` heartbeat. A real
      // playtest (StudioTestService run) lives in a separate DataModel, so the
      // edit Executor's RunService:IsRunning() stays false -- server liveness is
      // the truth. Also accept a same-DataModel sim (studio.running) as a fallback.
      const serverLive = isAlive("server");
      const running = serverLive || studio.running === true;
      const startedAtUnix =
        running && typeof studio.startedAtUnix === "number"
          ? (studio.startedAtUnix as number)
          : null;
      const durationSec = startedAtUnix
        ? Math.max(0, Math.floor(Date.now() / 1000) - startedAtUnix)
        : 0;
      const mode = running
        ? ((studio.mode as string | undefined) ?? (serverLive ? "run" : null))
        : null;
      const merged = {
        running,
        mode,
        startedAtUnix,
        durationSec,
        players: typeof studio.players === "number" ? studio.players : 0,
        agentConnected: serverLive,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(merged, null, 2) }],
      };
    }
  );

  // ----- meta (ungated) -----------------------------------------------------
  server.registerTool(
    "get_status",
    {
      title: "Get Status",
      description:
        "Report which Studio contexts are connected, plus the runtime agent's " +
        "recent self-diagnostics (diag: connect/poll/error/shutdown events).",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { edit: isAlive("edit"), server: isAlive("server"), diag: getDiag() },
            null,
            2
          ),
        },
      ],
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] server connected over stdio");
}
