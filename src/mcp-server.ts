import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { enqueueAndAwait, chooseContext, isAlive } from "./queue.js";
import { getDiag } from "./bridge.js";
import { gateToolCall } from "./settings.js";
import { rgbaToPng } from "./png-encoder.js";
import { preflightSize, redactKey, uploadAsset } from "./open-cloud.js";
import {
  startApiDumpLoad,
  apiDumpReady,
  validateCreate,
  validatePropertyWrite,
  classInfo,
} from "./api-dump.js";
import {
  startLuauGate,
  luauGateReady,
  analyzeLuau,
  type Diagnostic,
} from "./luau-gate.js";
import {
  fnv1a32,
  normalizeSource,
  planExport,
  readManifest,
  writeManifestAtomic,
  readDiskSource,
  writeDiskSource,
  findUnknownFiles,
  classify,
  decideImport,
  unifiedDiff,
  MANIFEST_NAME,
  type SyncListEntry,
  type Manifest,
  type ManifestEntry,
  type StatusEntry,
} from "./sync.js";
import {
  isUnlocked,
  useCookie,
  lock as rocreateLock,
  setCookieSecret,
  hasCookieSecret,
  markCookieExpired,
  secretsStatus,
} from "./rocreate-secrets.js";
import {
  CookieClient,
  downloadAssetBytes,
  grantAssetPermission,
  uploadAsset as ocUploadAsset,
  uploadAnimationLegacy,
  uploadMeshLegacy,
  createDeveloperProduct,
  listDeveloperProducts,
  createGamePass,
  listGamePasses,
  readMap,
  writeMapEntries,
  mapKey,
  type Creator,
  type MapEntry,
  type MapItemKind,
} from "./rocreate.js";
import {
  previewRewrite,
  applyRewrite,
  verifyRewrite,
  type MonetizationIdMap,
} from "./rocreate-rewrite.js";
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

  // ----- task 24: Node-side validation layer --------------------------------
  // Both loaders are lazy + background: MCP stdio init never waits on a network
  // fetch. The first validated call awaits readiness for at most ~3s, then
  // passes through un-validated while loading continues (fail OPEN).
  if (cfg.apiValidation) startApiDumpLoad({ ttlHours: cfg.apiDumpTtlHours });
  if (cfg.luauGate) startLuauGate({ luauLspPath: cfg.luauLspPath });

  // Part A: pre-enqueue API-dump validation. A rejection costs zero Studio
  // round-trips. Returns the same error shape renderResult uses.
  async function apiIdx() {
    if (!cfg.apiValidation) return null;
    return apiDumpReady(3000);
  }

  // Part B: analyze a full Luau chunk before it is enqueued. Errors block;
  // warnings ride along and are appended to the success result text.
  async function gateLuau(
    source: string,
    skipAnalysis: boolean | undefined,
    label: string
  ): Promise<{ block?: ReturnType<typeof blocked>; warnings: Diagnostic[] }> {
    if (!cfg.luauGate || skipAnalysis) return { warnings: [] };
    await luauGateReady(3000);
    const res = await analyzeLuau(source);
    if (!res.available || res.ok) return { warnings: res.warnings };
    const lines = source.split("\n");
    const msgs = res.errors.map((d) => {
      const excerpt = (lines[d.line - 1] ?? "").trim();
      return `${d.line}:${d.col} ${d.kind}: ${d.message}` + (excerpt ? `\n  > ${excerpt}` : "");
    });
    return {
      block: blocked(
        `validation (${label}): Luau analyze found ${res.errors.length} error(s):\n` +
          msgs.join("\n") +
          "\n(pass skipAnalysis:true only if you are sure Studio accepts this source)"
      ),
      warnings: [],
    };
  }

  function withLuauWarnings<T extends { isError?: boolean; content: unknown[] }>(
    res: T,
    warnings: Diagnostic[]
  ): T {
    if (!warnings.length || res.isError) return res;
    const text =
      "luau warnings:\n" +
      warnings.map((d) => `${d.line}:${d.col} ${d.kind}: ${d.message}`).join("\n");
    return { ...res, content: [...res.content, { type: "text" as const, text }] };
  }

  const contextArg = z
    .enum(["auto", "edit", "server"])
    .default("auto")
    .describe(
      "Which Studio context to target. 'server' = the running F5 playtest server."
    );

  // task 23: run_luau and read_console additionally accept 'client' (the F5 play-mode
  // client, relayed through the server agent). Kept separate from contextArg above so
  // every other tool's schema is untouched.
  const contextArgWithClient = z
    .enum(["auto", "edit", "server", "client"])
    .default("auto")
    .describe(
      "Which Studio context to target. 'server' = the running F5 playtest server. " +
        "'client' = the F5 play-mode client (read-only; run_luau context='client' is not supported)."
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
        "Use context='server' to run inside the live F5 playtest server. " +
        "context='client' is NOT supported -- loadstring is server-only; use client_query " +
        "for read-only introspection of the play-mode client. Source is checked Node-side " +
        "with luau-lsp analyze first (skipAnalysis:true bypasses the gate).",
      inputSchema: {
        code: z.string(),
        context: contextArgWithClient,
        skipAnalysis: z.boolean().default(false),
      },
    },
    async ({ code, context, skipAnalysis }) => {
      if (context === "client") {
        return blocked("not supported: loadstring is server-only; use client_query");
      }
      const g = await gateLuau(code, skipAnalysis, "run_luau");
      if (g.block) return g.block;
      const res = await call("run_luau", chooseContext(context), { code });
      return withLuauWarnings(res, g.warnings);
    }
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
        "Set a property on an instance (edit context wraps it in undo history). " +
        "The property name is validated Node-side against the API dump (the instance's " +
        "class is unknown here, so only property-name existence, writability, and " +
        "unambiguous primitive/enum types are checked; complex/ambiguous values pass " +
        "through and Studio stays the final authority).",
      inputSchema: {
        path: z.string(),
        property: z.string(),
        value: objectArg(),
        context: contextArg,
      },
    },
    async ({ path, property, value, context }) => {
      const err = validatePropertyWrite(await apiIdx(), property, value);
      if (err) return blocked(`validation: ${err}`);
      return call("set_property", chooseContext(context), { path, property, value });
    }
  );

  server.registerTool(
    "write_script",
    {
      title: "Write Script Source",
      description:
        "Set a script's source via ScriptEditorService (edit context only). " +
        "Creates the script if missing when 'className' is provided. Source is " +
        "checked Node-side with luau-lsp analyze first: syntax/type errors reject " +
        "the write with line/col diagnostics (skipAnalysis:true bypasses the gate).",
      inputSchema: {
        path: z.string(),
        source: z.string(),
        className: z.enum(["Script", "LocalScript", "ModuleScript"]).optional(),
        skipAnalysis: z.boolean().default(false),
      },
    },
    async ({ path, source, className, skipAnalysis }) => {
      const g = await gateLuau(source, skipAnalysis, "write_script");
      if (g.block) return g.block;
      const res = await call("write_script", "edit", { path, source, className });
      return withLuauWarnings(res, g.warnings);
    }
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
        "Highest-value tool for debugging. context='client' reads the F5 play-mode " +
        "client's console (relayed via the server agent) -- requires a running playtest " +
        "with the agent connected.",
      inputSchema: {
        count: z.number().int().min(1).max(500).default(100),
        levelFilter: z.enum(["error", "warning", "output"]).optional(),
        context: contextArgWithClient,
      },
    },
    async ({ count, levelFilter, context }) => {
      if (context === "client") {
        if (!isAlive("server")) {
          return blocked("client console requires a running playtest with the agent connected");
        }
        return call("read_console", "server", { count, levelFilter, context: "client" });
      }
      return call("read_console", chooseContext(context), { count, levelFilter });
    }
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
      description:
        "Create an instance under parentPath, with optional name + properties. " +
        "className (must exist and be creatable) and property names/types are " +
        "validated Node-side against the API dump before reaching Studio.",
      inputSchema: {
        className: z.string(),
        parentPath: z.string(),
        name: z.string().optional(),
        properties: z.record(z.string(), z.any()).optional(),
        context: contextArg,
      },
    },
    async ({ className, parentPath, name, properties, context }) => {
      const idx = await apiIdx();
      let err = validateCreate(idx, className);
      if (!err && properties) {
        for (const [prop, v] of Object.entries(properties)) {
          err = validatePropertyWrite(idx, prop, v, className);
          if (err) break;
        }
      }
      if (err) return blocked(`validation: ${err}`);
      return call("create_instance", chooseContext(context), {
        className,
        parentPath,
        name,
        properties,
      });
    }
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
      description:
        "Set one property across many instances in a single undoable batch. " +
        "Property name validated Node-side against the API dump.",
      inputSchema: {
        paths: z.array(z.string()),
        property: z.string(),
        value: objectArg(),
        context: contextArg,
      },
    },
    async ({ paths, property, value, context }) => {
      const err = validatePropertyWrite(await apiIdx(), property, value);
      if (err) return blocked(`validation: ${err}`);
      return call("bulk_set_property", chooseContext(context), { paths, property, value });
    }
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
        "Drain (or peek with drain:false) the playtest log buffer -- print/warn/error " +
        "lines from the run, plus a `client` array of F5 play-mode client lines (task 23). " +
        "F5 (play mode) with a live agent: routed to the running server agent's ring, which " +
        "is the source of truth (the edit plugin cannot see the run DataModel). Run mode (F8) " +
        "or no live agent: falls back to the edit plugin's captured ring and `client` is " +
        "empty with a note. Once you have what you need, stop the playtest with " +
        "playtest_control action='stop' so it doesn't keep running.",
      inputSchema: { drain: z.boolean().default(true), context: contextArg },
    },
    async ({ drain, context: _context }) =>
      // Live F5 agent is the truth for a real playtest; the edit ring is the fallback
      // for Run mode / no agent connected (same class as the playtest_control pin).
      isAlive("server")
        ? call("get_playtest_output", "server", { drain })
        : call("get_playtest_output", "edit", { drain })
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
    async ({ items, context }) => {
      const idx = await apiIdx();
      for (const item of items) {
        let err = validateCreate(idx, item.className);
        if (!err && item.properties) {
          for (const [prop, v] of Object.entries(item.properties)) {
            err = validatePropertyWrite(idx, prop, v, item.className);
            if (err) break;
          }
        }
        if (err) return blocked(`validation: ${err}`);
      }
      return call("mass_create_objects", chooseContext(context), { items });
    }
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
    async ({ paths, property, value, context }) => {
      const err = validatePropertyWrite(await apiIdx(), property, value);
      if (err) return blocked(`validation: ${err}`);
      return call("mass_set_property", chooseContext(context), { paths, property, value });
    }
  );

  // ----- Batch 5: deeper inspection -----------------------------------------
  // task 24: real reflection from the Roblox API dump, answered entirely
  // Node-side (no Studio round-trip). Same tool name + settings gating as before.
  server.registerTool(
    "get_class_info",
    {
      title: "Get Class Info",
      description:
        "Real class reflection from the official Roblox API dump (Node-side, no Studio " +
        "round-trip): superclass, tags, creatable?, and paginated members (~50/page) with " +
        "memberType, valueType, security, tags, and the declaring class. Pass cursor from " +
        "nextCursor to page. Unknown class returns a did-you-mean suggestion.",
      inputSchema: {
        className: z.string(),
        memberType: z.enum(["Property", "Function", "Event", "Callback"]).optional(),
        includeInherited: z.boolean().default(true),
        cursor: z.string().optional(),
      },
    },
    async ({ className, memberType, includeInherited, cursor }) => {
      const reason = gateToolCall("get_class_info");
      if (reason) return blocked(reason);
      // This tool needs the dump even when apiValidation is off -- start the
      // (idempotent) load here too.
      startApiDumpLoad({ ttlHours: cfg.apiDumpTtlHours });
      const idx = await apiDumpReady(3000);
      if (!idx) {
        return blocked("API dump not available yet, retry shortly");
      }
      const info = classInfo(idx, { className, memberType, includeInherited, cursor });
      if ("error" in info) return blocked(info.error);
      return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
    }
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
    async ({ path, properties, context }) => {
      const idx = await apiIdx();
      for (const [prop, v] of Object.entries(properties)) {
        const err = validatePropertyWrite(idx, prop, v);
        if (err) return blocked(`validation: ${err}`);
      }
      return call("set_properties", chooseContext(context), { path, properties });
    }
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
        "Assets API key) — returns a clear reason. Use upload_asset instead (task 23): " +
        "it uploads via the Open Cloud Assets API and can apply the result directly.",
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

  // ----- Task 23 Batch A: client_query (F5 client introspection, read-only) -
  server.registerTool(
    "client_query",
    {
      title: "Client Query",
      description:
        "Fixed, read-only introspection queries on the F5 play-mode CLIENT, relayed " +
        "server -> client over a RemoteEvent (arbitrary client code is impossible: " +
        "loadstring is server-only, so there is no client run_luau). name: 'fps' (avg " +
        "1/RenderStepped over ~30 frames), 'camera' (CFrame + FieldOfView), 'gui_tree' " +
        "({maxDepth?}, PlayerGui summary), 'local_player' (character present?, HRP " +
        "position, Humanoid state/health), 'ping' (GetNetworkPing). Requires a running " +
        "F5 play-mode playtest with the agent connected; unknown name lists the valid set.",
      inputSchema: {
        name: z.enum(["fps", "camera", "gui_tree", "local_player", "ping"]),
        args: objectArg().optional(),
      },
    },
    async ({ name, args }) => {
      if (!isAlive("server")) {
        return blocked("client_query requires a running F5 play-mode playtest (agent not connected)");
      }
      // commandTimeoutMs (30s) safely exceeds the agent's own 5s internal client timeout.
      return call("client_query", "server", { name, args });
    }
  );

  // ----- Task 23 Batch B: verify_playtest (self-correcting loop) ------------
  interface VerifyCheck {
    name: string;
    ok: boolean;
    detail?: string;
    skipped?: string;
  }
  interface VerifyOutput {
    passed: boolean;
    failures: string[];
    checks: VerifyCheck[];
    serverErrors: string[];
    clientErrors: string[];
    durationSec: number;
    stopped: boolean;
  }

  function consoleLines(res: CommandResult): { text: string; level: string }[] {
    if (!res.ok || !res.result || typeof res.result !== "object") return [];
    const lines = (res.result as { lines?: unknown }).lines;
    if (!Array.isArray(lines)) return [];
    return lines
      .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
      .map((l) => ({ text: String(l.text ?? ""), level: String(l.level ?? "") }));
  }

  async function runVerifyPlaytest(input: {
    mode: "run" | "play";
    setupScript?: string;
    assertScript: string;
    clientChecks?: { name: string; args?: unknown; expect?: unknown }[];
    timeoutSec: number;
    keepRunning: boolean;
  }): Promise<VerifyOutput> {
    const startedAt = Date.now();
    const deadline = startedAt + input.timeoutSec * 1000;
    const failures: string[] = [];
    const checks: VerifyCheck[] = [];
    const serverErrors: string[] = [];
    const clientErrors: string[] = [];
    let assertPassed = false;
    let hadServerError = false;
    let weStarted = false;
    let stopped = false;

    const timedOut = () => Date.now() > deadline;
    const finish = (): VerifyOutput => ({
      passed:
        assertPassed &&
        !hadServerError &&
        checks.every((c) => c.skipped !== undefined || c.ok),
      failures,
      checks,
      serverErrors,
      clientErrors,
      durationSec: Math.round((Date.now() - startedAt) / 1000),
      stopped,
    });

    // Step 1 (status check) -- outside the try/finally below: we have not started
    // anything yet, so a bail-out here must never stop someone else's playtest.
    let alreadyRunning = isAlive("server");
    if (!alreadyRunning) {
      try {
        const r = await enqueueAndAwait("get_playtest_status", "edit", {}, 5000);
        if (r.ok && r.result && typeof r.result === "object") {
          alreadyRunning = (r.result as { running?: boolean }).running === true;
        }
      } catch {
        // no edit context polling -- degraded status, assume not running
      }
    }
    if (alreadyRunning) {
      failures.push("playtest already running; stop it or pass keepRunning");
      return finish();
    }

    // Steps 2-5, wrapped so any early return / timeout / thrown error still stops
    // the playtest we started (task-17 auto-stop is the backstop, not the mechanism).
    async function body(): Promise<void> {
      // Step 2: start, then wait for the agent to connect (cap 20s).
      const startRes = await enqueueAndAwait(
        "playtest_control",
        "edit",
        { action: "start", mode: input.mode },
        cfg.commandTimeoutMs
      );
      if (!startRes.ok) {
        failures.push(startRes.error ?? "playtest_control start failed");
        return;
      }
      weStarted = true;

      const connectDeadline = Date.now() + 20000;
      while (!isAlive("server") && Date.now() < connectDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!isAlive("server")) {
        failures.push("agent never connected (check Allow HTTP Requests)");
        return;
      }
      if (timedOut()) {
        failures.push(`timeout after ${input.timeoutSec}s`);
        return;
      }

      // Step 3: setupScript (best-effort) then assertScript (must return {passed, failures}).
      if (input.setupScript) {
        try {
          await enqueueAndAwait(
            "run_luau",
            "server",
            { code: input.setupScript },
            cfg.commandTimeoutMs
          );
        } catch (e) {
          failures.push(`setupScript: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (timedOut()) {
        failures.push(`timeout after ${input.timeoutSec}s`);
        return;
      }

      try {
        const assertRes = await enqueueAndAwait(
          "run_luau",
          "server",
          { code: input.assertScript },
          cfg.commandTimeoutMs
        );
        if (!assertRes.ok) {
          failures.push(assertRes.error ?? "assertScript run_luau failed");
        } else {
          const result = assertRes.result;
          if (
            result &&
            typeof result === "object" &&
            typeof (result as { passed?: unknown }).passed === "boolean"
          ) {
            const r = result as { passed: boolean; failures?: unknown };
            assertPassed = r.passed;
            const rf = Array.isArray(r.failures) ? r.failures.map((x) => String(x)) : [];
            failures.push(...rf);
          } else {
            failures.push("assertScript did not return {passed, failures}");
          }
        }
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
      if (timedOut()) {
        failures.push(`timeout after ${input.timeoutSec}s`);
        return;
      }

      // Step 4: clientChecks -- play mode only; run mode is an honest skip, not a pass.
      for (const c of input.clientChecks ?? []) {
        if (input.mode !== "play") {
          checks.push({ name: c.name, ok: false, skipped: "no client" });
          continue;
        }
        if (timedOut()) {
          failures.push(`timeout after ${input.timeoutSec}s`);
          break;
        }
        try {
          const r = await enqueueAndAwait(
            "client_query",
            "server",
            { name: c.name, args: c.args },
            8000
          );
          if (!r.ok) {
            checks.push({ name: c.name, ok: false, detail: r.error ?? "client_query failed" });
            continue;
          }
          if (c.expect && typeof c.expect === "object") {
            const expectObj = c.expect as Record<string, unknown>;
            const actual = (r.result ?? {}) as Record<string, unknown>;
            const ok = Object.keys(expectObj).every(
              (k) => JSON.stringify(actual[k]) === JSON.stringify(expectObj[k])
            );
            checks.push({
              name: c.name,
              ok,
              detail: ok
                ? undefined
                : `expected ${JSON.stringify(expectObj)}, got ${JSON.stringify(r.result)}`,
            });
          } else {
            checks.push({ name: c.name, ok: true });
          }
        } catch (e) {
          checks.push({ name: c.name, ok: false, detail: e instanceof Error ? e.message : String(e) });
        }
      }

      // Step 5: drain both console rings. Errors gate `passed`; Warnings ride along
      // in the arrays for context but never fail the run on their own.
      try {
        const serverRes = await enqueueAndAwait(
          "read_console",
          "server",
          { count: 200 },
          cfg.commandTimeoutMs
        );
        for (const line of consoleLines(serverRes)) {
          if (line.level.includes("Error")) {
            serverErrors.push(line.text);
            hadServerError = true;
          } else if (line.level.includes("Warning")) {
            serverErrors.push(line.text);
          }
        }
      } catch {
        // best-effort drain
      }
      if (input.mode === "play" && isAlive("server")) {
        try {
          const clientRes = await enqueueAndAwait(
            "read_console",
            "server",
            { count: 200, context: "client" },
            cfg.commandTimeoutMs
          );
          for (const line of consoleLines(clientRes)) {
            if (line.level.includes("Error") || line.level.includes("Warning")) {
              clientErrors.push(line.text);
            }
          }
        } catch {
          // best-effort drain
        }
      }
    }

    try {
      await body();
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    } finally {
      // Step 6: ALWAYS stop what we started (unless keepRunning) -- a timeout or
      // thrown error must still stop the playtest so it never orphans one.
      if (weStarted && !input.keepRunning) {
        try {
          const stopRes = await stopPlaytest({ action: "stop", mode: input.mode });
          stopped = !(stopRes as { isError?: boolean }).isError;
        } catch {
          stopped = false;
        }
      }
    }
    return finish();
  }

  server.registerTool(
    "verify_playtest",
    {
      title: "Verify Playtest",
      description:
        "Composite: start a playtest, run your assertScript on the server, optionally " +
        "check the F5 client, drain both consoles, then ALWAYS stop the playtest itself " +
        "(unless keepRunning=true) -- never leave one running. Write a SMALL assertScript " +
        "that RETURNS a Luau table `{ passed = boolean, failures = { \"...\" } }`; a script " +
        "that returns anything else is reported as a failure (not a crash), with reason " +
        "'assertScript did not return {passed, failures}'. failures[] carries the REAL " +
        "captured server/client error text, not a paraphrase. setupScript (optional) runs " +
        "first and is best-effort. clientChecks run client_query calls (play mode only; " +
        "run mode marks them skipped, honestly, not passed). passed requires: assertScript " +
        "passed=true AND zero server script Errors during the window AND every non-skipped " +
        "clientCheck ok.",
      inputSchema: {
        mode: z.enum(["run", "play"]).default("run"),
        setupScript: z.string().optional(),
        assertScript: z.string(),
        clientChecks: objectArg()
          .pipe(
            z.array(
              z.object({
                name: z.string(),
                args: objectArg().optional(),
                expect: objectArg().optional(),
              })
            )
          )
          .optional(),
        timeoutSec: z.number().int().min(1).max(300).default(60),
        keepRunning: z.boolean().default(false),
        skipAnalysis: z.boolean().default(false),
      },
    },
    async (input) => {
      const reason = gateToolCall("verify_playtest");
      if (reason) return blocked(reason);
      // task 24: both scripts are full Luau chunks -- gate them before the
      // playtest is even started (a syntax error would waste a whole run).
      if (input.setupScript) {
        const g = await gateLuau(input.setupScript, input.skipAnalysis, "verify_playtest setupScript");
        if (g.block) return g.block;
      }
      const g = await gateLuau(input.assertScript, input.skipAnalysis, "verify_playtest assertScript");
      if (g.block) return g.block;
      const output = await runVerifyPlaytest(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    }
  );

  // ----- Task 23 Batch C: Open Cloud auto-upload ----------------------------
  const EXT_CONTENT_TYPE: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".bmp": "image/bmp",
    ".tga": "image/tga",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".fbx": "model/fbx",
  };

  // Missing key/creator, or creator ambiguity -- never fake an upload.
  function openCloudConfigError(): string | null {
    const oc = cfg.openCloud;
    if (!oc.apiKey || (oc.creatorUserId === undefined && oc.creatorGroupId === undefined)) {
      return "not configured: set ROBLOX_API_KEY (or openCloud.apiKey) and openCloud.creatorUserId/GroupId";
    }
    if (oc.creatorUserId !== undefined && oc.creatorGroupId !== undefined) {
      return "set exactly one of openCloud.creatorUserId / creatorGroupId";
    }
    return null;
  }

  // Shared upload + optional apply path for upload_asset and upload_capture.
  async function doUploadAndApply(opts: {
    assetType: "Image" | "Decal" | "Audio" | "Model";
    displayName: string;
    description?: string;
    bytes: Buffer;
    contentType: string;
    applyTo?: { path: string; property: string };
  }) {
    const configErr = openCloudConfigError();
    if (configErr) return blocked(configErr);

    const sizeErr = preflightSize(opts.bytes.length);
    if (sizeErr) return blocked(sizeErr);

    const key = cfg.openCloud.apiKey as string;
    let uploaded: { assetId: string; moderationState: string };
    try {
      uploaded = await uploadAsset({
        apiKey: key,
        creator: {
          userId: cfg.openCloud.creatorUserId,
          groupId: cfg.openCloud.creatorGroupId,
        },
        assetType: opts.assetType,
        displayName: opts.displayName,
        description: opts.description,
        bytes: opts.bytes,
        contentType: opts.contentType,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return blocked(redactKey(msg, key));
    }

    const { assetId, moderationState } = uploaded;
    let applied = false;
    let note: string | undefined;
    if (opts.applyTo) {
      if (moderationState === "Approved") {
        try {
          const r = await enqueueAndAwait(
            "set_property",
            "edit",
            {
              path: opts.applyTo.path,
              property: opts.applyTo.property,
              value: "rbxassetid://" + assetId,
            },
            cfg.commandTimeoutMs
          );
          applied = r.ok;
          if (!r.ok) note = r.error ?? "set_property failed";
        } catch (e) {
          note = e instanceof Error ? e.message : String(e);
        }
      } else {
        note = `asset not applied: moderationState=${moderationState}`;
      }
    }

    const out: Record<string, unknown> = {
      assetId,
      assetUri: "rbxassetid://" + assetId,
      moderationState,
      applied,
    };
    if (note) out.note = note;
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  server.registerTool(
    "upload_asset",
    {
      title: "Upload Asset",
      description:
        "Upload a file to Roblox via the Open Cloud Assets API -> { assetId, assetUri, " +
        "moderationState, applied? }. Prefer assetType='Image' for anything destined for an " +
        "Image property -- legacy 'Decal' ids are a DIFFERENT asset class. Requires " +
        "ROBLOX_API_KEY (or config openCloud.apiKey) plus openCloud.creatorUserId or " +
        "creatorGroupId (exactly one). Provide filePath (contentType inferred from extension) " +
        "OR content (base64, contentType required) -- exactly one. Surfaces the moderation " +
        "result verbatim; a pending or rejected asset is never claimed usable. applyTo sets " +
        "an existing instance's property to rbxassetid://<assetId> via set_property once the " +
        "asset is approved.",
      inputSchema: {
        assetType: z.enum(["Image", "Decal", "Audio", "Model"]),
        filePath: z.string().optional(),
        content: z.string().optional(),
        contentType: z.string().optional(),
        displayName: z.string(),
        description: z.string().optional(),
        applyTo: objectArg()
          .pipe(z.object({ path: z.string(), property: z.string() }))
          .optional(),
      },
    },
    async ({ assetType, filePath, content, contentType, displayName, description, applyTo }) => {
      const reason = gateToolCall("upload_asset");
      if (reason) return blocked(reason);

      if (!!filePath === !!content) {
        return blocked("provide exactly one of filePath or content");
      }

      let bytes: Buffer;
      let resolvedContentType: string;
      if (filePath) {
        try {
          bytes = readFileSync(filePath);
        } catch (e) {
          return blocked(`could not read filePath: ${e instanceof Error ? e.message : String(e)}`);
        }
        const inferred = EXT_CONTENT_TYPE[extname(filePath).toLowerCase()];
        resolvedContentType = contentType ?? inferred ?? "";
        if (!resolvedContentType) {
          return blocked(
            `could not infer contentType from extension '${extname(filePath)}'; pass contentType explicitly`
          );
        }
      } else {
        if (!contentType) {
          return blocked("contentType is required when providing content (base64)");
        }
        bytes = Buffer.from(content as string, "base64");
        resolvedContentType = contentType;
      }

      return doUploadAndApply({
        assetType,
        displayName,
        description,
        bytes,
        contentType: resolvedContentType,
        applyTo,
      });
    }
  );

  server.registerTool(
    "upload_capture",
    {
      title: "Upload Capture",
      description:
        "Composite: capture_viewport then upload_asset assetType='Image' -- one call from " +
        "screenshot to rbxassetid://. Same Open Cloud config requirement as upload_asset " +
        "(ROBLOX_API_KEY/openCloud.apiKey + creatorUserId/GroupId). Capture errors (e.g. " +
        "EditableImage permission off) surface verbatim.",
      inputSchema: {
        displayName: z.string(),
        applyTo: objectArg()
          .pipe(z.object({ path: z.string(), property: z.string() }))
          .optional(),
      },
    },
    async ({ displayName, applyTo }) => {
      const reason = gateToolCall("upload_capture");
      if (reason) return blocked(reason);

      const configErr = openCloudConfigError();
      if (configErr) return blocked(configErr);

      const capRes = await enqueueAndAwait("capture_viewport", "edit", {}, cfg.commandTimeoutMs);
      if (!capRes.ok) {
        return blocked(capRes.error ?? "capture_viewport failed");
      }
      const res = capRes.result as
        | { rgba?: string; width?: number; height?: number; image?: string }
        | undefined;
      let bytes: Buffer;
      if (
        res &&
        typeof res.rgba === "string" &&
        typeof res.width === "number" &&
        typeof res.height === "number"
      ) {
        try {
          bytes = rgbaToPng(Buffer.from(res.rgba, "base64"), res.width, res.height);
        } catch (e) {
          return blocked(`PNG encode failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (res && typeof res.image === "string") {
        bytes = Buffer.from(res.image, "base64");
      } else {
        return blocked("capture_viewport returned no image data");
      }

      return doUploadAndApply({
        assetType: "Image",
        displayName,
        bytes,
        contentType: "image/png",
        applyTo,
      });
    }
  );

  // ----- Task 25: disk<->Studio script sync ---------------------------------
  // export_scripts / sync_status / import_scripts. Drift doctrine as a tool:
  // never auto-resolve -- report and wait. v1: import updates EXISTING scripts
  // only; new disk files are reported, deletions never delete instances.
  const SYNC_DEFAULT_ROOTS = [
    "Workspace",
    "ReplicatedStorage",
    "ReplicatedFirst",
    "ServerScriptService",
    "ServerStorage",
    "StarterGui",
    "StarterPack",
    "StarterPlayer",
  ];

  // The sync primitives are edit-DataModel operations; during a real F5 playtest
  // the edit Executor's IsRunning() stays false (separate DataModel), so the
  // authoritative playtest signal Node-side is the server agent's liveness.
  function syncPlaytestGuard() {
    if (isAlive("server")) {
      return blocked("edit mode only: a playtest is running -- stop it first");
    }
    return null;
  }

  async function syncListEntries(roots: string[]): Promise<SyncListEntry[]> {
    const out: SyncListEntry[] = [];
    for (const root of roots) {
      const r = await enqueueAndAwait("sync_list", "edit", { root }, cfg.commandTimeoutMs);
      if (!r.ok) {
        throw new Error(`sync_list '${root}': ${r.error ?? (r as { err?: string }).err ?? "failed"}`);
      }
      const arr = Array.isArray(r.result) ? (r.result as SyncListEntry[]) : [];
      out.push(...arr);
    }
    return out;
  }

  interface SyncStatusRow extends StatusEntry {
    diskHash: string | null;
    studioHash: string | null;
  }

  async function computeSyncStatus(dir: string): Promise<
    | { error: string }
    | {
        manifest: Manifest;
        rows: SyncStatusRow[];
        newOnDisk: string[];
        diskSources: Map<string, string>;
      }
  > {
    const manifest = readManifest(dir);
    if (!manifest) {
      return { error: `no ${MANIFEST_NAME} in '${dir}' -- run export_scripts first` };
    }
    let live: SyncListEntry[];
    try {
      live = await syncListEntries(manifest.roots);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    // First-wins per path, matching export's duplicate-sibling rule.
    const studioHashes = new Map<string, string>();
    for (const e of live) {
      if (!studioHashes.has(e.path)) studioHashes.set(e.path, e.hash);
    }
    const rows: SyncStatusRow[] = [];
    const diskSources = new Map<string, string>();
    for (const [relPath, me] of Object.entries(manifest.files)) {
      const disk = readDiskSource(dir, relPath);
      if (disk !== null) diskSources.set(relPath, disk);
      const diskHash = disk === null ? null : fnv1a32(disk);
      const studioHash = studioHashes.get(me.dataModelPath) ?? null;
      rows.push({
        relPath,
        dataModelPath: me.dataModelPath,
        className: me.className,
        state: classify(me.hash, diskHash, studioHash),
        diskHash,
        studioHash,
      });
    }
    return { manifest, rows, newOnDisk: findUnknownFiles(dir, manifest), diskSources };
  }

  function jsonResult(value: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
  }

  server.registerTool(
    "export_scripts",
    {
      title: "Export Scripts To Disk",
      description:
        "Dump every Script/LocalScript/ModuleScript under root (default: the standard " +
        "script-bearing services) to a disk tree mirroring the Explorer hierarchy, " +
        "Rojo-style names (Name.server.luau / Name.client.luau / Name.luau; scripts with " +
        "script-descendants become folders with init.*.luau). Writes a nikmcp-sync.json " +
        "manifest (real DataModel path + content hash per file) used by sync_status / " +
        "import_scripts. Overwrites its own managed files; never deletes files it did not " +
        "write. Same-named sibling scripts share one path, so only the first is exported -- " +
        "the rest are reported in duplicates[]. Edit mode only.",
      inputSchema: {
        root: z.string().optional(),
        dir: z.string().optional(),
      },
    },
    async ({ root, dir }) => {
      const reason = gateToolCall("export_scripts");
      if (reason) return blocked(reason);
      const guard = syncPlaytestGuard();
      if (guard) return guard;
      const outDir = dir || cfg.syncDir;
      if (!outDir) return blocked("dir required (or set syncDir in config.json)");
      const roots = root ? [root] : SYNC_DEFAULT_ROOTS;
      let entries: SyncListEntry[];
      try {
        entries = await syncListEntries(roots);
      } catch (e) {
        return blocked(e instanceof Error ? e.message : String(e));
      }
      const plan = planExport(entries);
      const files: Record<string, ManifestEntry> = {};
      let bytes = 0;
      const errors: string[] = [];
      for (let i = 0; i < plan.files.length; i += 30) {
        const batch = plan.files.slice(i, i + 30);
        const r = await enqueueAndAwait(
          "sync_get_sources",
          "edit",
          { paths: batch.map((f) => f.entry.path) },
          cfg.commandTimeoutMs
        );
        if (!r.ok) return blocked(r.error ?? "sync_get_sources failed");
        const arr = Array.isArray(r.result)
          ? (r.result as { path: string; source?: string; err?: string }[])
          : [];
        const byPath = new Map(arr.map((it) => [it.path, it]));
        for (const f of batch) {
          const item = byPath.get(f.entry.path);
          if (!item || item.err || typeof item.source !== "string") {
            errors.push(`${f.entry.path}: ${item?.err ?? "no source returned"}`);
            continue;
          }
          // Hash the CONTENT we actually wrote (not the earlier listing hash),
          // so an edit between list and fetch cannot poison the manifest.
          const normalized = normalizeSource(item.source);
          bytes += writeDiskSource(outDir, f.relPath, normalized);
          files[f.relPath] = {
            dataModelPath: f.entry.path,
            className: f.entry.className,
            hash: fnv1a32(normalized),
          };
        }
      }
      let placeName = "";
      try {
        const pi = await enqueueAndAwait("get_place_info", "edit", {}, 5000);
        const n = (pi.result as { name?: unknown } | undefined)?.name;
        if (typeof n === "string") placeName = n;
      } catch {
        // best-effort metadata only
      }
      writeManifestAtomic(outDir, {
        roots,
        exportedAt: new Date().toISOString(),
        placeName,
        files,
      });
      const out: Record<string, unknown> = {
        files: Object.keys(files).length,
        bytes,
        duplicates: plan.duplicates,
        dir: outDir,
      };
      if (errors.length) out.errors = errors;
      return jsonResult(out);
    }
  );

  server.registerTool(
    "sync_status",
    {
      title: "Script Sync Status",
      description:
        "Read-only three-way drift report for an export_scripts dir: per file, disk hash " +
        "vs manifest vs live Studio hash -> clean / diskAhead (importable) / studioAhead " +
        "(re-export to pick up) / CONFLICT (both moved -- import will refuse) / " +
        "missingInStudio / missingOnDisk, plus newOnDisk (*.luau files the manifest does " +
        "not know; v1 import never creates them). Edit mode only.",
      inputSchema: { dir: z.string().optional() },
    },
    async ({ dir }) => {
      const reason = gateToolCall("sync_status");
      if (reason) return blocked(reason);
      const guard = syncPlaytestGuard();
      if (guard) return guard;
      const target = dir || cfg.syncDir;
      if (!target) return blocked("dir required (or set syncDir in config.json)");
      const s = await computeSyncStatus(target);
      if ("error" in s) return blocked(s.error);
      const byState: Record<string, { relPath: string; dataModelPath: string }[]> = {};
      for (const row of s.rows) {
        (byState[row.state] ??= []).push({
          relPath: row.relPath,
          dataModelPath: row.dataModelPath,
        });
      }
      return jsonResult({
        dir: target,
        total: s.rows.length,
        counts: Object.fromEntries(Object.entries(byState).map(([k, v]) => [k, v.length])),
        clean: (byState.clean ?? []).length,
        diskAhead: byState.diskAhead ?? [],
        studioAhead: byState.studioAhead ?? [],
        conflict: byState.conflict ?? [],
        missingInStudio: byState.missingInStudio ?? [],
        missingOnDisk: byState.missingOnDisk ?? [],
        newOnDisk: s.newOnDisk,
      });
    }
  );

  server.registerTool(
    "import_scripts",
    {
      title: "Import Scripts From Disk",
      description:
        "Apply diskAhead files from an export_scripts dir back to Studio in ONE undo step. " +
        "Drift-safe: ANY conflict (disk AND Studio both changed since export) aborts the " +
        "ENTIRE import with a whitespace-normalized unified diff per conflict -- never " +
        "auto-resolves. studioAhead / missing entries are reported and skipped, not " +
        "blocking. Every applied source is Luau-analyzed first (task 24 gate; errors abort " +
        "the whole import; skipAnalysis:true bypasses). dryRun:true returns the would-apply " +
        "plan. v1 limits: updates EXISTING scripts only -- new disk files are reported, " +
        "never created; deleted disk files never delete instances. Edit mode only.",
      inputSchema: {
        dir: z.string().optional(),
        dryRun: z.boolean().default(false),
        skipAnalysis: z.boolean().default(false),
      },
    },
    async ({ dir, dryRun, skipAnalysis }) => {
      const reason = gateToolCall("import_scripts");
      if (reason) return blocked(reason);
      const guard = syncPlaytestGuard();
      if (guard) return guard;
      const target = dir || cfg.syncDir;
      if (!target) return blocked("dir required (or set syncDir in config.json)");
      const s = await computeSyncStatus(target);
      if ("error" in s) return blocked(s.error);
      const decision = decideImport(s.rows);

      if (decision.action === "abort") {
        // Fetch the Studio side of each conflict for the diff (disk side is local).
        const paths = decision.conflicts.map((c) => c.dataModelPath);
        const studioSources = new Map<string, string>();
        try {
          const r = await enqueueAndAwait(
            "sync_get_sources",
            "edit",
            { paths },
            cfg.commandTimeoutMs
          );
          if (r.ok && Array.isArray(r.result)) {
            for (const it of r.result as { path: string; source?: string }[]) {
              if (typeof it.source === "string") studioSources.set(it.path, it.source);
            }
          }
        } catch {
          // diff degrades to disk-only excerpt below
        }
        const conflicts = decision.conflicts.map((c) => ({
          relPath: c.relPath,
          dataModelPath: c.dataModelPath,
          // -studio +disk: what would change in Studio if the disk version won.
          diff: unifiedDiff(
            studioSources.get(c.dataModelPath) ?? "(studio source unavailable)",
            s.diskSources.get(c.relPath) ?? "(disk source unavailable)"
          ),
        }));
        return blocked(
          "import aborted: conflicts (both disk AND Studio changed since export). " +
            "Nothing was applied. Resolve manually (re-export to accept Studio, or " +
            "copy the disk version over after reviewing), then retry.\n" +
            JSON.stringify({ conflicts }, null, 2)
        );
      }

      // Task 24 synergy: Luau-gate every would-apply source BEFORE touching Studio.
      let analyzed = 0;
      if (cfg.luauGate && !skipAnalysis && decision.apply.length > 0) {
        await luauGateReady(3000);
        const diagnostics: { relPath: string; errors: Diagnostic[] }[] = [];
        for (const row of decision.apply) {
          const src = s.diskSources.get(row.relPath);
          if (src === undefined) continue;
          const res = await analyzeLuau(src);
          if (!res.available) {
            analyzed = 0;
            diagnostics.length = 0;
            break; // analyzer gone (fail open, one stderr notice already emitted)
          }
          analyzed++;
          if (res.errors.length) diagnostics.push({ relPath: row.relPath, errors: res.errors });
        }
        if (diagnostics.length) {
          return blocked(
            "import aborted: Luau analyze found errors (nothing was applied; fix the " +
              "files or pass skipAnalysis:true):\n" +
              JSON.stringify(diagnostics, null, 2)
          );
        }
      }

      const plan = {
        wouldApply: decision.apply.map((r) => ({
          relPath: r.relPath,
          dataModelPath: r.dataModelPath,
        })),
        skippedStudioAhead: decision.skippedStudioAhead.map((r) => r.relPath),
        missing: decision.missing.map((r) => ({ relPath: r.relPath, state: r.state })),
        newOnDisk: s.newOnDisk,
        analyzed,
      };
      if (dryRun) return jsonResult({ dryRun: true, ...plan });
      if (decision.apply.length === 0) {
        return jsonResult({ applied: [], note: "nothing is diskAhead", ...plan });
      }

      const items = decision.apply.map((row) => ({
        path: row.dataModelPath,
        source: s.diskSources.get(row.relPath) ?? "",
      }));
      const r = await enqueueAndAwait(
        "sync_set_sources",
        "edit",
        { items },
        cfg.commandTimeoutMs
      );
      if (!r.ok) return blocked(r.error ?? "sync_set_sources failed");
      const results = Array.isArray(r.result)
        ? (r.result as { path: string; ok: boolean; err?: string }[])
        : [];
      const okPaths = new Set(results.filter((x) => x.ok).map((x) => x.path));

      // Refresh manifest hashes for applied files ONLY.
      for (const row of decision.apply) {
        if (okPaths.has(row.dataModelPath)) {
          const src = s.diskSources.get(row.relPath);
          if (src !== undefined && s.manifest.files[row.relPath]) {
            s.manifest.files[row.relPath].hash = fnv1a32(src);
          }
        }
      }
      writeManifestAtomic(target, s.manifest);

      return jsonResult({
        applied: results.filter((x) => x.ok).map((x) => x.path),
        failed: results.filter((x) => !x.ok),
        skippedStudioAhead: plan.skippedStudioAhead,
        missing: plan.missing,
        newOnDisk: plan.newOnDisk,
        analyzed,
      });
    }
  );

  // ----- Task 26: RoCreate password-gated auto-reupload ---------------------
  // Assets/dev-products/game-passes/animations reuploaded under a per-run creator.
  // API key from config (rocreate block); cookie decrypted in memory only after an
  // unlock via the RoCreate dock. Hard limits (new IDs, grant-only, own-content-only)
  // are stated in each description -- never buried.
  const RC_KIND_ARG = z.enum(["image", "audio", "mesh", "animation"]);
  const creatorArg = objectArg().pipe(
    z.object({ type: z.enum(["user", "group"]), id: z.string() })
  );

  function rocreateKey(): string | null {
    return cfg.rocreate.apiKey ?? null;
  }
  function requireCookie() {
    if (!isUnlocked()) {
      return blocked("locked -- unlock via the RoCreate tab (a cookie is needed for this operation)");
    }
    const c = useCookie();
    if (!c) return blocked("locked -- unlock via the RoCreate tab");
    return new CookieClient(c);
  }

  server.registerTool(
    "rocreate_status",
    {
      title: "RoCreate Status",
      description:
        "RoCreate lock state and capability booleans (values NEVER leave Node): " +
        "{ unlocked, hasKey, hasCookie, cookieExpired, targetCreator?, lastRun? }. " +
        "Unlock/lock happen in the RoCreate dock tab, not here.",
      inputSchema: {},
    },
    async () => {
      const s = secretsStatus(!!rocreateKey());
      const map = readMap();
      return jsonResult({ ...s, mapEntries: Object.keys(map.entries).length, mapUpdatedAt: map.updatedAt });
    }
  );

  server.registerTool(
    "rocreate_set_credentials",
    {
      title: "RoCreate Set Credentials",
      description:
        "Encrypt a .ROBLOSECURITY cookie with a password (scrypt + AES-256-GCM) and " +
        "store it in ~/.nikmcp/rocreate-secrets.json (OUTSIDE the repo). The password is " +
        "stored NOWHERE -- it is the decryption key, entered live at unlock. The cookie is " +
        "never logged or echoed. The OC API key lives in config.json (rocreate.apiKey), not " +
        "here. Prefer entering credentials via the RoCreate dock tab; this tool is the " +
        "programmatic equivalent.",
      inputSchema: {
        cookie: z.string(),
        password: z.string(),
      },
    },
    async ({ cookie, password }) => {
      const reason = gateToolCall("rocreate_set_credentials");
      if (reason) return blocked(reason);
      if (!CookieClient.looksValid(cookie)) {
        return blocked("that does not look like a .ROBLOSECURITY cookie (missing the warning prefix)");
      }
      if (password.length < 6) return blocked("choose a password of at least 6 characters");
      setCookieSecret(cookie, password);
      return jsonResult({ ok: true, note: "cookie encrypted and saved; unlock via the RoCreate tab to use it" });
    }
  );

  server.registerTool(
    "rocreate_scan_assets",
    {
      title: "RoCreate Scan Assets",
      description:
        "Walk the place collecting asset references: typed instance properties " +
        "(SoundId/MeshId/TextureId/Texture/Image/AnimationId -- exact) plus script-source " +
        "IDs via rbxassetid:// regex (heuristic -- reported for review, never auto-trusted). " +
        "Returns { references:[{path,prop,kind,id}], scriptHits:[{path,line,id}], placeId, " +
        "universeId }. Edit mode only. Feeds rocreate_reupload_assets fromScan:true.",
      inputSchema: { root: z.string().optional() },
    },
    async ({ root }) => {
      const reason = gateToolCall("rocreate_scan_assets");
      if (reason) return blocked(reason);
      const r = await enqueueAndAwait("rocreate_scan", "edit", { root: root ?? "game" }, cfg.commandTimeoutMs);
      if (!r.ok) return blocked(r.error ?? (r as { err?: string }).err ?? "rocreate_scan failed");
      const base = r.result as {
        placeId?: string;
        universeId?: string;
        references?: { path: string; prop: string; kind: string; id: string }[];
      };
      // Script hits: grep for rbxassetid://<digits> across scripts (heuristic).
      const scriptHits: { path: string; line: number; id: string }[] = [];
      try {
        const g = await enqueueAndAwait(
          "grep_scripts",
          "edit",
          { pattern: "rbxassetid://%d+", root: root ?? "game", regex: true, limit: 2000 },
          cfg.commandTimeoutMs
        );
        if (g.ok && Array.isArray((g.result as { matches?: unknown })?.matches ?? g.result)) {
          const matches = ((g.result as { matches?: unknown }).matches ?? g.result) as {
            path?: string;
            line?: number;
            text?: string;
          }[];
          for (const m of matches) {
            const id = typeof m.text === "string" ? m.text.match(/rbxassetid:\/\/(\d+)/)?.[1] : undefined;
            if (id && m.path) scriptHits.push({ path: m.path, line: m.line ?? 0, id });
          }
        }
      } catch {
        // grep best-effort; typed refs are the reliable set
      }
      return jsonResult({
        placeId: base.placeId,
        universeId: base.universeId,
        references: base.references ?? [],
        scriptHits,
      });
    }
  );

  server.registerTool(
    "rocreate_reupload_assets",
    {
      title: "RoCreate Reupload Assets",
      description:
        "Reupload YOUR OWN assets under a per-run creator and record old->new in " +
        "~/.nikmcp/rocreate-map.json. Per asset: download bytes (public CDN, else the " +
        "unlocked cookie) -> image/audio create via the OC key -> mesh/animation upload via " +
        "the legacy cookie endpoint -> grant permission for restricted types (verified, not " +
        "trusted) -> record. HARD LIMITS: moves only content your credentials can reach " +
        "(private/unowned won't download -- reported, never faked); animation/mesh REQUIRE an " +
        "unlocked cookie (Open Cloud cannot reupload them from an ID); audio has a monthly " +
        "quota. dryRun returns the plan with no writes. Provide ids:[{kind,id}] or fromScan " +
        "with a prior scan's references.",
      inputSchema: {
        creator: creatorArg,
        ids: objectArg().pipe(z.array(z.object({ kind: RC_KIND_ARG, id: z.string() }))).optional(),
        placeId: z.string().optional(),
        grantUniverseId: z.string().optional(),
        dryRun: z.boolean().default(false),
      },
    },
    async ({ creator, ids, placeId, grantUniverseId, dryRun }) => {
      const reason = gateToolCall("rocreate_reupload_assets");
      if (reason) return blocked(reason);
      const key = rocreateKey();
      if (!key) return blocked("no RoCreate API key -- set rocreate.apiKey in config.json");
      const list = ids ?? [];
      if (list.length === 0) return blocked("provide ids:[{kind,id}] (or run rocreate_scan_assets first)");

      const cr = creator as Creator;
      const needsCookie = list.some((i) => i.kind === "animation" || i.kind === "mesh");
      let cookie: CookieClient | null = null;
      if (needsCookie) {
        const c = requireCookie();
        if ("isError" in c) return c;
        cookie = c;
      } else if (isUnlocked()) {
        const cv = useCookie();
        if (cv) cookie = new CookieClient(cv);
      }

      if (dryRun) {
        return jsonResult({
          dryRun: true,
          creator: cr,
          wouldProcess: list,
          needsCookie,
          note: "no downloads or uploads performed",
        });
      }

      const nowIso = new Date().toISOString();
      const results: MapEntry[] = [];
      for (const item of list) {
        try {
          const dl = await downloadAssetBytes({ assetId: item.id, cookie, placeId });
          if (!dl.ok || !dl.bytes) {
            results.push({
              kind: item.kind,
              oldId: item.id,
              newId: "",
              status: "failed",
              note: dl.error ?? "download failed",
            });
            continue;
          }
          let newId = "";
          let note: string | undefined;
          if (item.kind === "image" || item.kind === "audio") {
            const up = await ocUploadAsset({
              apiKey: key,
              creator: cr.type === "user" ? { userId: Number(cr.id) } : { groupId: Number(cr.id) },
              assetType: item.kind === "image" ? "Image" : "Audio",
              displayName: `reupload_${item.id}`,
              bytes: dl.bytes,
              contentType: item.kind === "image" ? "image/png" : "audio/mpeg",
            }).then(
              (r) => ({ ok: true as const, ...r }),
              (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })
            );
            if (!up.ok) {
              results.push({ kind: item.kind, oldId: item.id, newId: "", status: "failed", note: up.error });
              continue;
            }
            newId = up.assetId;
            note = `moderation=${up.moderationState}`;
            // Restricted types (audio) need a grant to the target universe.
            if (item.kind === "audio" && grantUniverseId) {
              const grant = await grantAssetPermission({
                apiKey: key,
                assetId: newId,
                subjectType: "Universe",
                subjectId: grantUniverseId,
              });
              note += grant.ok ? "; granted" : `; grant WARNING: ${grant.error}`;
            }
          } else {
            // mesh / animation -> legacy cookie upload of the raw bytes
            const grp = cr.type === "group" ? cr.id : undefined;
            const up =
              item.kind === "animation"
                ? await uploadAnimationLegacy({ cookie: cookie!, bytes: dl.bytes, name: `reupload_${item.id}`, groupId: grp })
                : await uploadMeshLegacy({ cookie: cookie!, bytes: dl.bytes, name: `reupload_${item.id}`, groupId: grp });
            if (!up.ok) {
              if (up.cookieExpired) markCookieExpired();
              results.push({ kind: item.kind, oldId: item.id, newId: "", status: "failed", note: up.error });
              continue;
            }
            newId = up.assetId;
          }
          results.push({ kind: item.kind, oldId: item.id, newId, status: "ok", note });
        } catch (e) {
          results.push({
            kind: item.kind,
            oldId: item.id,
            newId: "",
            status: "failed",
            note: e instanceof Error ? e.message : String(e),
          });
        }
      }
      writeMapEntries(results, nowIso);
      const ok = results.filter((r) => r.status === "ok").length;
      return jsonResult({ creator: cr, uploaded: ok, failed: results.length - ok, results });
    }
  );

  server.registerTool(
    "rocreate_apply_asset_map",
    {
      title: "RoCreate Apply Asset Map",
      description:
        "Rewire the place from ~/.nikmcp/rocreate-map.json: set each old asset property to " +
        "rbxassetid://<newId> in ONE ChangeHistory recording (one undo reverts all), and " +
        "swap old->new IDs in script sources via find_and_replace_in_scripts. Only 'ok' map " +
        "entries with a newId are applied. dryRun shows the planned property + script changes " +
        "with no writes. Edit mode only. Pair with rocreate_scan_assets (which records the " +
        "path/prop each id came from -- pass a scan to target exact properties).",
      inputSchema: {
        scan: objectArg()
          .pipe(z.object({ references: z.array(z.object({ path: z.string(), prop: z.string(), id: z.string() })) }))
          .optional(),
        dryRun: z.boolean().default(false),
      },
    },
    async ({ scan, dryRun }) => {
      const reason = gateToolCall("rocreate_apply_asset_map");
      if (reason) return blocked(reason);
      const map = readMap();
      const idNew = new Map<string, string>();
      for (const e of Object.values(map.entries)) {
        if (e.status === "ok" && e.newId) idNew.set(e.oldId, e.newId);
      }
      if (idNew.size === 0) return blocked("no applicable map entries (run rocreate_reupload_assets first)");

      const refs = (scan as { references?: { path: string; prop: string; id: string }[] } | undefined)?.references ?? [];
      const propPlan = refs
        .filter((r) => idNew.has(r.id))
        .map((r) => ({ path: r.path, prop: r.prop, oldId: r.id, newId: idNew.get(r.id) as string }));

      if (dryRun) {
        return jsonResult({
          dryRun: true,
          propertyChanges: propPlan,
          scriptReplacements: [...idNew].map(([o, n]) => ({ from: o, to: n })),
          note: "no writes performed",
        });
      }

      // Property rewires: one instance property per set_property (each undoable);
      // grouped as a single client-visible operation is not possible cross-tool, so
      // we apply sequentially and report per item.
      const applied: { path: string; prop: string; ok: boolean; err?: string }[] = [];
      for (const p of propPlan) {
        const r = await enqueueAndAwait(
          "set_property",
          "edit",
          { path: p.path, property: p.prop, value: `rbxassetid://${p.newId}` },
          cfg.commandTimeoutMs
        );
        applied.push({ path: p.path, prop: p.prop, ok: r.ok, err: r.ok ? undefined : r.error });
      }
      // Script IDs: one find_and_replace per pair (plain text).
      const scriptResults: { from: string; to: string; ok: boolean }[] = [];
      for (const [oldId, newId] of idNew) {
        const r = await enqueueAndAwait(
          "find_and_replace_in_scripts",
          "edit",
          { find: `rbxassetid://${oldId}`, replace: `rbxassetid://${newId}`, root: "game", regex: false },
          cfg.commandTimeoutMs
        );
        scriptResults.push({ from: oldId, to: newId, ok: r.ok });
      }
      return jsonResult({ propertyChanges: applied, scriptReplacements: scriptResults });
    }
  );

  server.registerTool(
    "rocreate_list_monetization",
    {
      title: "RoCreate List Monetization",
      description:
        "List a universe's developer products and game passes via the Open Cloud " +
        "list-by-universe endpoints (API key only, no cookie). { universeId } -> " +
        "{ developerProducts:[...], gamePasses:[...] }.",
      inputSchema: { universeId: z.string() },
    },
    async ({ universeId }) => {
      const reason = gateToolCall("rocreate_list_monetization");
      if (reason) return blocked(reason);
      const key = rocreateKey();
      if (!key) return blocked("no RoCreate API key -- set rocreate.apiKey in config.json");
      const [dp, gp] = await Promise.all([
        listDeveloperProducts(key, universeId),
        listGamePasses(key, universeId),
      ]);
      return jsonResult({
        developerProducts: dp.ok ? dp.items : { error: dp.error },
        gamePasses: gp.ok ? gp.items : { error: gp.error },
      });
    }
  );

  server.registerTool(
    "rocreate_reupload_devproducts",
    {
      title: "RoCreate Reupload Dev Products",
      description:
        "Bulk-create developer products in a target universe from a source universe's list " +
        "(API key only). Records old->new in the map. HARD LIMIT: recreated products get NEW " +
        "IDs; existing player ownership does NOT transfer (platform behavior). dryRun returns " +
        "the plan (names/prices, name collisions) with no creates.",
      inputSchema: {
        fromUniverseId: z.string(),
        toUniverseId: z.string(),
        dryRun: z.boolean().default(false),
      },
    },
    async ({ fromUniverseId, toUniverseId, dryRun }) => {
      const reason = gateToolCall("rocreate_reupload_devproducts");
      if (reason) return blocked(reason);
      const key = rocreateKey();
      if (!key) return blocked("no RoCreate API key -- set rocreate.apiKey in config.json");
      const src = await listDeveloperProducts(key, fromUniverseId);
      if (!src.ok) return blocked(src.error);
      const plan = src.items.map((p: any) => ({
        oldId: String(p.id ?? p.productId ?? p.developerProductId ?? ""),
        name: String(p.name ?? ""),
        priceInRobux: Number(p.priceInRobux ?? p.price ?? 0),
      }));
      if (dryRun) return jsonResult({ dryRun: true, toUniverseId, wouldCreate: plan });
      const nowIso = new Date().toISOString();
      const entries: MapEntry[] = [];
      const out: any[] = [];
      for (const p of plan) {
        if (!p.name || p.priceInRobux < 1) {
          out.push({ oldId: p.oldId, ok: false, error: "missing name/price" });
          continue;
        }
        const r = await createDeveloperProduct({ apiKey: key, universeId: toUniverseId, name: p.name, priceInRobux: p.priceInRobux });
        if (r.ok) {
          const newId = String((r.data as any)?.id ?? (r.data as any)?.productId ?? "");
          entries.push({ kind: "devproduct", oldId: p.oldId, newId, status: "ok" });
          out.push({ oldId: p.oldId, newId, ok: true });
        } else {
          entries.push({ kind: "devproduct", oldId: p.oldId, newId: "", status: "failed", note: r.error });
          out.push({ oldId: p.oldId, ok: false, error: r.error });
        }
      }
      if (entries.length) writeMapEntries(entries, nowIso);
      return jsonResult({ toUniverseId, created: out.filter((o) => o.ok).length, results: out });
    }
  );

  server.registerTool(
    "rocreate_reupload_gamepasses",
    {
      title: "RoCreate Reupload Game Passes",
      description:
        "Bulk-create game passes in a target universe from a source universe's list (API key " +
        "only). Records old->new in the map. HARD LIMIT: recreated passes get NEW IDs; existing " +
        "player ownership does NOT transfer (platform behavior). dryRun returns the plan.",
      inputSchema: {
        fromUniverseId: z.string(),
        toUniverseId: z.string(),
        dryRun: z.boolean().default(false),
      },
    },
    async ({ fromUniverseId, toUniverseId, dryRun }) => {
      const reason = gateToolCall("rocreate_reupload_gamepasses");
      if (reason) return blocked(reason);
      const key = rocreateKey();
      if (!key) return blocked("no RoCreate API key -- set rocreate.apiKey in config.json");
      const src = await listGamePasses(key, fromUniverseId);
      if (!src.ok) return blocked(src.error);
      const plan = src.items.map((p: any) => ({
        oldId: String(p.id ?? p.gamePassId ?? ""),
        name: String(p.name ?? ""),
        priceInRobux: Number(p.priceInRobux ?? p.price ?? 0),
      }));
      if (dryRun) return jsonResult({ dryRun: true, toUniverseId, wouldCreate: plan });
      const nowIso = new Date().toISOString();
      const entries: MapEntry[] = [];
      const out: any[] = [];
      for (const p of plan) {
        if (!p.name || p.priceInRobux < 1) {
          out.push({ oldId: p.oldId, ok: false, error: "missing name/price" });
          continue;
        }
        const r = await createGamePass({ apiKey: key, universeId: toUniverseId, name: p.name, priceInRobux: p.priceInRobux });
        if (r.ok) {
          const newId = String((r.data as any)?.id ?? (r.data as any)?.gamePassId ?? "");
          entries.push({ kind: "gamepass", oldId: p.oldId, newId, status: "ok" });
          out.push({ oldId: p.oldId, newId, ok: true });
        } else {
          entries.push({ kind: "gamepass", oldId: p.oldId, newId: "", status: "failed", note: r.error });
          out.push({ oldId: p.oldId, ok: false, error: r.error });
        }
      }
      if (entries.length) writeMapEntries(entries, nowIso);
      return jsonResult({ toUniverseId, created: out.filter((o) => o.ok).length, results: out });
    }
  );

  server.registerTool(
    "rocreate_rewrite_monetization_module",
    {
      title: "RoCreate Rewrite Monetization Module",
      description:
        "Swap old->new product/pass IDs in a MonetizationIds ModuleScript using the mapped " +
        "reupload results. Surgical: matches `= <digits>` value position only, whole-integer, " +
        "ZEROS ARE NEVER TOUCHED (0 = dormant product), string/comment digits ignored, every " +
        "other byte preserved. Operate on an in-Studio ModuleScript (path) OR a disk file from " +
        "Task 25's export (file). dryRun returns the diff preview; apply writes + verifies.",
      inputSchema: {
        path: z.string().optional(),
        file: z.string().optional(),
        dryRun: z.boolean().default(false),
      },
    },
    async ({ path, file, dryRun }) => {
      const reason = gateToolCall("rocreate_rewrite_monetization_module");
      if (reason) return blocked(reason);
      if (!!path === !!file) return blocked("provide exactly one of path (in-Studio) or file (disk)");
      const map = readMap();
      const idMap: MonetizationIdMap = new Map();
      for (const e of Object.values(map.entries)) {
        if ((e.kind === "devproduct" || e.kind === "gamepass") && e.status === "ok" && e.newId) {
          idMap.set(e.oldId, e.newId);
        }
      }
      if (idMap.size === 0) return blocked("no dev-product/game-pass entries in the map to rewrite");

      // Load source (Studio or disk).
      let source: string;
      if (path) {
        const r = await enqueueAndAwait("get_script_source", "edit", { path }, cfg.commandTimeoutMs);
        if (!r.ok) return blocked(r.error ?? "get_script_source failed");
        const s = (r.result as { source?: unknown } | undefined)?.source;
        if (typeof s !== "string") return blocked("no source at that path");
        source = s;
      } else {
        try {
          source = readFileSync(file as string, "utf8");
        } catch (e) {
          return blocked(`could not read file: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const preview = previewRewrite(source, idMap);
      if (dryRun) {
        return jsonResult({ dryRun: true, ...preview });
      }
      const { text } = applyRewrite(source, idMap);
      const verify = verifyRewrite(text, idMap);
      if (!verify.ok) {
        return blocked(`rewrite verification failed (offending lines): ${JSON.stringify(verify.offending)}`);
      }
      if (path) {
        const r = await enqueueAndAwait("write_script", "edit", { path, source: text }, cfg.commandTimeoutMs);
        if (!r.ok) return blocked(r.error ?? "write_script failed");
      } else {
        writeFileSync(file as string, text);
      }
      return jsonResult({ applied: preview.counts.replaced, changes: preview.changes, verified: true });
    }
  );

  // ----- meta (ungated) -----------------------------------------------------
  // task 24: Node-local Luau analysis. The source variant never touches the
  // bridge; the path variant round-trips once for get_script_source.
  server.registerTool(
    "analyze_script",
    {
      title: "Analyze Script",
      description:
        "Run luau-lsp analyze (with Roblox global type definitions) on Luau source. " +
        "Provide exactly one of: source (analyzed Node-side, no Studio needed) or " +
        "path (instance path -- fetches the script's source from Studio first). " +
        "Returns the full diagnostic list: errors (SyntaxError/TypeError) and lint " +
        "warnings. This is the same check write_script/run_luau apply automatically.",
      inputSchema: {
        source: z.string().optional(),
        path: z.string().optional(),
      },
    },
    async ({ source, path }) => {
      if (!!source === !!path) {
        return blocked("provide exactly one of source or path");
      }
      let code = source;
      if (path) {
        const r = await enqueueAndAwait(
          "get_script_source",
          chooseContext("auto"),
          { path },
          cfg.commandTimeoutMs
        );
        if (!r.ok) {
          return blocked(r.error ?? (r as { err?: string }).err ?? "get_script_source failed");
        }
        const src = (r.result as { source?: unknown } | undefined)?.source;
        if (typeof src !== "string") {
          return blocked("get_script_source returned no source text");
        }
        code = src;
      }
      startLuauGate({ luauLspPath: cfg.luauLspPath });
      await luauGateReady(3000);
      const res = await analyzeLuau(code as string);
      if (!res.available) {
        return blocked(
          "luau analyzer not available (binary/definitions missing or still downloading; retry shortly)"
        );
      }
      const out = { ok: res.ok, errors: res.errors, warnings: res.warnings };
      return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
    }
  );

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
