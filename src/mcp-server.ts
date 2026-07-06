import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
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
  secretsStatus,
} from "./rocreate-secrets.js";
import {
  CookieClient,
  downloadAssetBytes,
  grantAssetPermission,
  uploadAsset as ocUploadAsset,
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
        const content: ({ type: "image"; data: string; mimeType: string } | { type: "text"; text: string })[] = [
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        ];
        // selection_capture (and any future rgba-returning tool) rides extra keys
        // (e.g. `legend`) alongside rgba/width/height. Nothing else in the shape
        // changes, so append them as a trailing text block instead of dropping
        // them -- existing tools (capture_viewport) have no extra keys, so this
        // is a no-op for them.
        const { rgba: _rgba, width: _width, height: _height, ...extra } = res as Record<string, unknown>;
        if (Object.keys(extra).length > 0) {
          content.push({ type: "text" as const, text: JSON.stringify(extra, null, 2) });
        }
        return { content };
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

// ----- Bucket 4 QoL: snapshot_revert in-memory store ------------------------
// A "build" node here is export_build/import_build's existing serialization
// shape: { className, name, properties?, attributes?, tags?, children? }.
// Module-level (not per-call) so snapshots survive across tool calls for the
// life of this Node process; NOT persisted to disk or across restarts.
interface BuildNode {
  className: string;
  name: string;
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  tags?: string[];
  children?: BuildNode[];
}

interface BuildSnapshot {
  label: string;
  path: string;
  parentPath: string;
  name: string;
  build: unknown;
  takenAt: string;
}

const SNAPSHOT_CAP = 6;
const snapshotStore = new Map<string, BuildSnapshot>();

// LRU insert: re-inserting an existing label moves it to the MRU end (Map
// iteration order is insertion order); eviction takes the oldest (front) key.
function storeSnapshot(label: string, snap: BuildSnapshot): void {
  snapshotStore.delete(label);
  snapshotStore.set(label, snap);
  while (snapshotStore.size > SNAPSHOT_CAP) {
    const oldest = snapshotStore.keys().next().value;
    if (oldest === undefined) break;
    snapshotStore.delete(oldest);
  }
}

// Paths are dot-separated FindFirstChild segments (resolvePath's convention,
// shared by every path-taking tool) -- splitting on the last "." is exactly
// how the plugin itself would walk back up to the parent.
function splitPath(path: string): { parentPath: string; name: string } {
  // Mirror resolvePath's skip of leading "game"/"Game" segments so
  // "game.Workspace" splits identically to "Workspace" (empty parentPath)
  // and the bare-service revert guard cannot be bypassed with a game. prefix.
  let normalized = path;
  for (;;) {
    const m = normalized.match(/^[Gg]ame\./);
    if (!m) break;
    normalized = normalized.slice(m[0].length);
  }
  const idx = normalized.lastIndexOf(".");
  if (idx === -1) return { parentPath: "", name: normalized };
  return { parentPath: normalized.slice(0, idx), name: normalized.slice(idx + 1) };
}

function countBuildInstances(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as BuildNode;
  let count = 1;
  if (Array.isArray(n.children)) {
    for (const c of n.children) count += countBuildInstances(c);
  }
  return count;
}

// Flattens a build tree to relPath -> node, where relPath is the dotted chain
// of `name`s from the snapshotted root (e.g. "Root.Sub.Part"). Sibling name
// collisions are an inherent approximation of this scheme -- same limitation
// every path-based tool in this codebase already has.
function flattenBuild(node: unknown, prefix: string, out: Map<string, BuildNode>): void {
  if (!node || typeof node !== "object") return;
  const n = node as BuildNode;
  const relPath = prefix ? `${prefix}.${n.name}` : n.name;
  out.set(relPath, n);
  if (Array.isArray(n.children)) {
    for (const c of n.children) flattenBuild(c, relPath, out);
  }
}

interface PropChange {
  prop: string;
  before: unknown;
  after: unknown;
}
interface ChangedInstance {
  path: string;
  changedProps: PropChange[];
}
interface BuildDiff {
  addedInstances: string[];
  removedInstances: string[];
  changedInstances: ChangedInstance[];
  truncated: boolean;
}

const DIFF_ENTRY_CAP = 200;
const DIFF_PROPS_PER_INSTANCE_CAP = 20;

function diffBuildTrees(before: unknown, after: unknown): BuildDiff {
  const beforeMap = new Map<string, BuildNode>();
  const afterMap = new Map<string, BuildNode>();
  flattenBuild(before, "", beforeMap);
  flattenBuild(after, "", afterMap);

  const addedInstances: string[] = [];
  const removedInstances: string[] = [];
  const changedInstances: ChangedInstance[] = [];
  let truncated = false;
  const total = () => addedInstances.length + removedInstances.length + changedInstances.length;

  for (const relPath of afterMap.keys()) {
    if (!beforeMap.has(relPath)) {
      if (total() >= DIFF_ENTRY_CAP) {
        truncated = true;
        break;
      }
      addedInstances.push(relPath);
    }
  }
  for (const relPath of beforeMap.keys()) {
    if (!afterMap.has(relPath)) {
      if (total() >= DIFF_ENTRY_CAP) {
        truncated = true;
        break;
      }
      removedInstances.push(relPath);
    }
  }
  for (const [relPath, beforeNode] of beforeMap) {
    const afterNode = afterMap.get(relPath);
    if (!afterNode) continue;
    if (total() >= DIFF_ENTRY_CAP) {
      truncated = true;
      break;
    }
    const changedProps: PropChange[] = [];
    if (beforeNode.className !== afterNode.className) {
      changedProps.push({ prop: "className", before: beforeNode.className, after: afterNode.className });
    }
    const beforeProps = beforeNode.properties ?? {};
    const afterProps = afterNode.properties ?? {};
    for (const p of new Set([...Object.keys(beforeProps), ...Object.keys(afterProps)])) {
      if (changedProps.length >= DIFF_PROPS_PER_INSTANCE_CAP) break;
      const b = beforeProps[p];
      const a = afterProps[p];
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        changedProps.push({ prop: p, before: b, after: a });
      }
    }
    const beforeAttrs = beforeNode.attributes ?? {};
    const afterAttrs = afterNode.attributes ?? {};
    for (const p of new Set([...Object.keys(beforeAttrs), ...Object.keys(afterAttrs)])) {
      if (changedProps.length >= DIFF_PROPS_PER_INSTANCE_CAP) break;
      const b = beforeAttrs[p];
      const a = afterAttrs[p];
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        changedProps.push({ prop: `attr:${p}`, before: b, after: a });
      }
    }
    if (changedProps.length > 0) {
      changedInstances.push({ path: relPath, changedProps });
    }
  }

  return { addedInstances, removedInstances, changedInstances, truncated };
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
        "unlocked cookie) -> create via the Open Cloud KEY (image/audio/animation/mesh -- " +
        "animation & mesh are Open Cloud asset types as of Oct 2025, uploaded as the " +
        "downloaded .rbxm) -> grant permission for restricted types (audio/animation, " +
        "verified not trusted) -> record. HARD LIMITS: moves only content your credentials " +
        "can reach (private/unowned won't download -- reported, never faked); animation/mesh " +
        "downloads REQUIRE an unlocked cookie (restricted); audio has a monthly quota. A " +
        "restricted asset whose universe grant returns 200 but is NOT confirmed " +
        "(missing asset-permissions:write scope) is recorded 'pending', never 'ok'. An id " +
        "already reuploaded ok is SKIPPED on re-run (no double-upload) unless force:true. " +
        "dryRun returns the plan with no writes. Provide ids:[{kind,id}] or fromScan with a " +
        "prior scan's references.",
      inputSchema: {
        creator: creatorArg,
        ids: objectArg().pipe(z.array(z.object({ kind: RC_KIND_ARG, id: z.string() }))).optional(),
        placeId: z.string().optional(),
        grantUniverseId: z.string().optional(),
        dryRun: z.boolean().default(false),
        // Re-run safety: by default an id already reuploaded ok (in the map) is
        // SKIPPED so a re-run never double-uploads / re-burns audio quota. force
        // re-uploads it anyway (creating a fresh new id).
        force: z.boolean().default(false),
      },
    },
    async ({ creator, ids, placeId, grantUniverseId, dryRun, force }) => {
      const reason = gateToolCall("rocreate_reupload_assets");
      if (reason) return blocked(reason);
      const key = rocreateKey();
      if (!key) return blocked("no RoCreate API key -- set rocreate.apiKey in config.json");
      const apiKey: string = key; // narrowed non-null for the closures below
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
      const existing = readMap();
      const results: MapEntry[] = [];
      const skipped: { kind: string; oldId: string; newId: string }[] = [];

      // Grant a restricted asset (audio/animation) to the target universe and
      // report honestly. A grant that returns 200 but does not confirm the asset
      // (missing asset-permissions:write scope) is NOT trusted -> the item is
      // recorded "pending" (asset exists, but is not usable in the universe yet),
      // never "ok". Returns the status the item should carry + a note fragment.
      async function grantRestricted(
        assetId: string
      ): Promise<{ status: MapEntry["status"]; note: string }> {
        if (!grantUniverseId) {
          return { status: "ok", note: "" };
        }
        const grant = await grantAssetPermission({
          apiKey,
          assetId,
          subjectType: "Universe",
          subjectId: grantUniverseId,
        });
        if (grant.ok) return { status: "ok", note: "; granted" };
        return { status: "pending", note: `; grant NOT applied: ${grant.error}` };
      }

      for (const item of list) {
        // Re-run dedup: skip an id already reuploaded ok unless force.
        const prior = existing.entries[mapKey(item.kind as MapItemKind, item.id)];
        if (!force && prior && prior.status === "ok" && prior.newId) {
          skipped.push({ kind: item.kind, oldId: item.id, newId: prior.newId });
          continue;
        }
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
          let status: MapEntry["status"] = "ok";
          // All four kinds now upload through the Open Cloud KEY path. Roblox
          // retired the legacy ide/publish endpoints (410/404) and made Animation
          // and Mesh first-class Open Cloud asset types (Oct 2025). assetdelivery
          // returns animations/meshes already wrapped as binary .rbxm ("<roblox!"),
          // which is exactly the model/x-rbxm fileContent Open Cloud wants -- proven
          // live end-to-end for Animation (2026-07-04).
          const assetType =
            item.kind === "image"
              ? "Image"
              : item.kind === "audio"
                ? "Audio"
                : item.kind === "animation"
                  ? "Animation"
                  : "Mesh";
          const contentType =
            item.kind === "image"
              ? "image/png"
              : item.kind === "audio"
                ? "audio/mpeg"
                : "model/x-rbxm";
          const up = await ocUploadAsset({
            apiKey: key,
            creator: cr.type === "user" ? { userId: Number(cr.id) } : { groupId: Number(cr.id) },
            assetType,
            displayName: `reupload_${item.id}`,
            bytes: dl.bytes,
            contentType,
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
          // Audio and Animation are restricted types -> grant + verify (status
          // "pending" if the grant returns 200 but is unconfirmed).
          if (item.kind === "audio" || item.kind === "animation") {
            const g = await grantRestricted(newId);
            status = g.status;
            note += g.note;
          }
          results.push({ kind: item.kind, oldId: item.id, newId, status, note });
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
      if (results.length) writeMapEntries(results, nowIso);
      const ok = results.filter((r) => r.status === "ok").length;
      const pending = results.filter((r) => r.status === "pending").length;
      return jsonResult({
        creator: cr,
        uploaded: ok,
        pending,
        failed: results.filter((r) => r.status === "failed").length,
        skipped,
        results,
      });
    }
  );

  server.registerTool(
    "rocreate_apply_asset_map",
    {
      title: "RoCreate Apply Asset Map",
      description:
        "Rewire the place from ~/.nikmcp/rocreate-map.json: set each old asset property to " +
        "rbxassetid://<newId>, and swap old->new IDs in script sources via " +
        "find_and_replace_in_scripts. Only 'ok' map entries with a newId are applied (a " +
        "'pending' entry -- e.g. an ungranted audio -- is intentionally NOT wired). NOTE: each " +
        "property change and each script replacement is its OWN undo step (a single batched " +
        "undo would need a dedicated plugin command); undo may take several Ctrl+Z. dryRun " +
        "shows the planned changes with no writes. Edit mode only. Pair with rocreate_scan_assets " +
        "(which records the path/prop each id came from -- pass a scan to target exact properties).",
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
        // OC list nests price at priceInformation.defaultPriceInRobux (confirmed
        // live 2026-07-04); flat fields are older/fallback shapes.
        priceInRobux: Number(
          p.priceInformation?.defaultPriceInRobux ?? p.priceInRobux ?? p.price ?? 0
        ),
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
    "rocreate_create_devproducts",
    {
      title: "RoCreate Create Dev Products",
      description:
        "Create one or more brand-new developer products in a universe from an explicit list -- " +
        "just give each a name and a price in Robux (optional description). Publishes via the " +
        "Open Cloud API key (no source universe needed). Pass as many products as you want in one " +
        "call. dryRun returns the plan (names/prices) with no creates. Net-new products get fresh " +
        "IDs; this does NOT remap anything (use reupload_devproducts to clone an existing catalog).",
      inputSchema: {
        universeId: z.string(),
        products: objectArg().pipe(
          z
            .array(
              z.object({
                name: z.string(),
                priceInRobux: z.number(),
                description: z.string().optional(),
              })
            )
            .min(1)
        ),
        dryRun: z.boolean().default(false),
      },
    },
    async ({ universeId, products, dryRun }) => {
      const reason = gateToolCall("rocreate_create_devproducts");
      if (reason) return blocked(reason);
      const key = rocreateKey();
      if (!key) return blocked("no RoCreate API key -- set rocreate.apiKey in config.json");
      const plan = products.map((p) => ({
        name: String(p.name ?? "").trim(),
        priceInRobux: Number(p.priceInRobux),
        description: p.description,
      }));
      if (dryRun) return jsonResult({ dryRun: true, universeId, wouldCreate: plan });
      const out: any[] = [];
      for (const p of plan) {
        if (!p.name || !Number.isFinite(p.priceInRobux) || p.priceInRobux < 1) {
          out.push({ name: p.name, ok: false, error: "missing name or price < 1" });
          continue;
        }
        const r = await createDeveloperProduct({
          apiKey: key,
          universeId,
          name: p.name,
          description: p.description,
          priceInRobux: p.priceInRobux,
        });
        if (r.ok) {
          const newId = String((r.data as any)?.id ?? (r.data as any)?.productId ?? "");
          out.push({ name: p.name, newId, priceInRobux: p.priceInRobux, ok: true });
        } else {
          out.push({ name: p.name, ok: false, error: r.error });
        }
      }
      return jsonResult({ universeId, created: out.filter((o) => o.ok).length, results: out });
    }
  );

  // ----- RoCreate local-file upload (image/audio/model + folder) ------------
  // Publish LOCAL files from THIS computer as brand-new Roblox assets through the
  // Open Cloud KEY (rocreate.apiKey) under a per-run creator. KEY-ONLY: a net-new
  // upload from disk needs NO cookie/unlock (the cookie only downloads restricted
  // EXISTING assets; a fresh upload needs just the key -- same path as
  // rocreate_create_devproducts). Net-new ids; nothing is remapped.
  const RC_IMAGE_EXT: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".bmp": "image/bmp",
    ".tga": "image/tga",
  };
  const RC_AUDIO_EXT: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
  };
  const RC_MODEL_EXT: Record<string, string> = {
    ".fbx": "model/fbx",
  };
  // Folder upload: classify each file by extension -> { contentType, assetType }.
  const RC_MEDIA: Record<string, { ct: string; type: "Image" | "Audio" }> = {
    ".png": { ct: "image/png", type: "Image" },
    ".jpg": { ct: "image/jpeg", type: "Image" },
    ".jpeg": { ct: "image/jpeg", type: "Image" },
    ".bmp": { ct: "image/bmp", type: "Image" },
    ".tga": { ct: "image/tga", type: "Image" },
    ".mp3": { ct: "audio/mpeg", type: "Audio" },
    ".ogg": { ct: "audio/ogg", type: "Audio" },
  };

  // creator.id feeds creationContext.creator.{userId|groupId} as a string; a
  // non-numeric id would silently become "NaN" -- reject it up front.
  function creatorIdError(creator: Creator): string | null {
    return /^\d+$/.test(creator.id) ? null : "creator.id must be a numeric user or group id";
  }

  // Core: upload already-in-memory bytes via the OC key + optional universe grant.
  // No MCP formatting -- shared by the single-file tools and the folder tool.
  async function ocUploadOne(opts: {
    apiKey: string;
    creator: Creator;
    assetType: "Image" | "Audio" | "Model";
    displayName: string;
    description?: string;
    bytes: Buffer;
    contentType: string;
    grantUniverseId?: string;
  }): Promise<
    | { ok: true; assetId: string; assetUri: string; moderationState: string; granted?: boolean; grantNote?: string }
    | { ok: false; error: string }
  > {
    const sizeErr = preflightSize(opts.bytes.length);
    if (sizeErr) return { ok: false, error: sizeErr };
    let up: { assetId: string; moderationState: string };
    try {
      up = await ocUploadAsset({
        apiKey: opts.apiKey,
        creator:
          opts.creator.type === "user"
            ? { userId: Number(opts.creator.id) }
            : { groupId: Number(opts.creator.id) },
        assetType: opts.assetType,
        displayName: opts.displayName,
        description: opts.description,
        bytes: opts.bytes,
        contentType: opts.contentType,
      });
    } catch (e) {
      return { ok: false, error: redactKey(e instanceof Error ? e.message : String(e), opts.apiKey) };
    }
    const res: {
      ok: true;
      assetId: string;
      assetUri: string;
      moderationState: string;
      granted?: boolean;
      grantNote?: string;
    } = {
      ok: true,
      assetId: up.assetId,
      assetUri: "rbxassetid://" + up.assetId,
      moderationState: up.moderationState,
    };
    // Restricted types (audio) need a Use grant to play inside a universe whose
    // owner differs from the uploader. Verify-don't-trust the 200.
    if (opts.grantUniverseId) {
      const grant = await grantAssetPermission({
        apiKey: opts.apiKey,
        assetId: up.assetId,
        subjectType: "Universe",
        subjectId: opts.grantUniverseId,
      });
      res.granted = grant.ok;
      if (!grant.ok) res.grantNote = grant.error;
    }
    return res;
  }

  // Single-file upload wrapper: validate + read bytes + infer contentType, then
  // ocUploadOne, then optional applyTo. Returns an MCP result.
  async function rocreateUploadLocal(opts: {
    assetType: "Image" | "Audio" | "Model";
    creator: Creator;
    filePath?: string;
    content?: string;
    contentType?: string;
    displayName: string;
    description?: string;
    extMap: Record<string, string>;
    mediaPrefix: string; // "image/" | "audio/" | "model/"
    grantUniverseId?: string;
    applyTo?: { path: string; property: string };
  }) {
    const key = rocreateKey();
    if (!key) return blocked("no RoCreate API key -- set rocreate.apiKey in config.json");
    const cErr = creatorIdError(opts.creator);
    if (cErr) return blocked(cErr);

    if (!!opts.filePath === !!opts.content) {
      return blocked("provide exactly one of filePath or content (base64)");
    }

    let bytes: Buffer;
    let resolvedContentType: string;
    if (opts.filePath) {
      try {
        bytes = readFileSync(opts.filePath);
      } catch (e) {
        return blocked(`could not read filePath: ${e instanceof Error ? e.message : String(e)}`);
      }
      const ext = extname(opts.filePath).toLowerCase();
      resolvedContentType = opts.contentType ?? opts.extMap[ext] ?? "";
      if (!resolvedContentType) {
        return blocked(
          `unsupported ${opts.assetType.toLowerCase()} extension '${ext || "(none)"}'; ` +
            `supported: ${Object.keys(opts.extMap).join(", ")} (or pass contentType explicitly)`
        );
      }
    } else {
      if (!opts.contentType) {
        return blocked("contentType is required when providing content (base64)");
      }
      bytes = Buffer.from(opts.content as string, "base64");
      resolvedContentType = opts.contentType;
    }

    // Guard against a mismatched file (e.g. an mp3 handed to upload_image).
    if (!resolvedContentType.startsWith(opts.mediaPrefix)) {
      return blocked(
        `contentType '${resolvedContentType}' is not ${opts.mediaPrefix}* -- ` +
          `this tool only uploads ${opts.assetType.toLowerCase()} files`
      );
    }

    const up = await ocUploadOne({
      apiKey: key,
      creator: opts.creator,
      assetType: opts.assetType,
      displayName: opts.displayName,
      description: opts.description,
      bytes,
      contentType: resolvedContentType,
      grantUniverseId: opts.grantUniverseId,
    });
    if (!up.ok) return blocked(up.error);

    const out: Record<string, unknown> = {
      assetId: up.assetId,
      assetUri: up.assetUri,
      moderationState: up.moderationState,
      creator: opts.creator,
    };
    if (up.granted !== undefined) out.granted = up.granted;
    if (up.grantNote) out.grantNote = up.grantNote;

    // Optional convenience: wire the new id straight into an instance property
    // (Approved-only; a pending/rejected asset is never applied).
    if (opts.applyTo) {
      if (up.moderationState === "Approved") {
        try {
          const r = await enqueueAndAwait(
            "set_property",
            "edit",
            { path: opts.applyTo.path, property: opts.applyTo.property, value: up.assetUri },
            cfg.commandTimeoutMs
          );
          out.applied = r.ok;
          if (!r.ok) out.applyNote = r.error ?? "set_property failed";
        } catch (e) {
          out.applied = false;
          out.applyNote = e instanceof Error ? e.message : String(e);
        }
      } else {
        out.applied = false;
        out.applyNote = `not applied: moderationState=${up.moderationState}`;
      }
    }

    return jsonResult(out);
  }

  server.registerTool(
    "rocreate_upload_image",
    {
      title: "RoCreate Upload Image",
      description:
        "Upload an image file from THIS computer to Roblox as a brand-new Image asset via the " +
        "Open Cloud KEY (rocreate.apiKey), owned by `creator` ({type:'user'|'group', id}) -> " +
        "{ assetId, assetUri, moderationState, applied? }. KEY-ONLY: no cookie/unlock needed (the " +
        "cookie only downloads restricted EXISTING assets; a local upload needs just the key). " +
        "Provide filePath (contentType inferred from .png/.jpg/.jpeg/.bmp/.tga) OR content " +
        "(base64, contentType required) -- exactly one. Net-new id; does NOT remap anything (use " +
        "rocreate_reupload_assets to clone an EXISTING asset). Moderation is surfaced verbatim -- " +
        "a pending/rejected asset is never claimed usable. applyTo sets an existing instance's " +
        "property to rbxassetid://<assetId> once the asset is Approved. Use this (assetType " +
        "'Image') for anything bound to an Image/Texture property -- legacy Decal ids are a " +
        "different asset class.",
      inputSchema: {
        creator: creatorArg,
        filePath: z.string().optional(),
        content: z.string().optional(),
        contentType: z.string().optional(),
        displayName: z.string(),
        description: z.string().optional(),
        applyTo: objectArg().pipe(z.object({ path: z.string(), property: z.string() })).optional(),
      },
    },
    async ({ creator, filePath, content, contentType, displayName, description, applyTo }) => {
      const reason = gateToolCall("rocreate_upload_image");
      if (reason) return blocked(reason);
      return rocreateUploadLocal({
        assetType: "Image",
        creator: creator as Creator,
        filePath,
        content,
        contentType,
        displayName,
        description,
        extMap: RC_IMAGE_EXT,
        mediaPrefix: "image/",
        applyTo: applyTo as { path: string; property: string } | undefined,
      });
    }
  );

  server.registerTool(
    "rocreate_upload_audio",
    {
      title: "RoCreate Upload Audio",
      description:
        "Upload an audio file from THIS computer to Roblox as a brand-new Audio asset via the " +
        "Open Cloud KEY (rocreate.apiKey), owned by `creator` ({type:'user'|'group', id}) -> " +
        "{ assetId, assetUri, moderationState, granted?, applied? }. KEY-ONLY: no cookie/unlock " +
        "needed. Provide filePath (contentType inferred from .mp3/.ogg) OR content (base64, " +
        "contentType required) -- exactly one. Audio is a RESTRICTED type: to be playable inside " +
        "a universe whose owner differs from the uploader it needs a Use grant -- pass " +
        "grantUniverseId to grant it (the 200 is verified, not trusted: granted:false + grantNote " +
        "means it did NOT apply, e.g. the key lacks asset-permissions:write). Audio uploads draw " +
        "on a monthly quota. Net-new id; moderation surfaced verbatim. applyTo sets an instance's " +
        "property (e.g. a Sound's SoundId) to rbxassetid://<assetId> once the asset is Approved.",
      inputSchema: {
        creator: creatorArg,
        filePath: z.string().optional(),
        content: z.string().optional(),
        contentType: z.string().optional(),
        displayName: z.string(),
        description: z.string().optional(),
        grantUniverseId: z.string().optional(),
        applyTo: objectArg().pipe(z.object({ path: z.string(), property: z.string() })).optional(),
      },
    },
    async ({ creator, filePath, content, contentType, displayName, description, grantUniverseId, applyTo }) => {
      const reason = gateToolCall("rocreate_upload_audio");
      if (reason) return blocked(reason);
      return rocreateUploadLocal({
        assetType: "Audio",
        creator: creator as Creator,
        filePath,
        content,
        contentType,
        displayName,
        description,
        extMap: RC_AUDIO_EXT,
        mediaPrefix: "audio/",
        grantUniverseId,
        applyTo: applyTo as { path: string; property: string } | undefined,
      });
    }
  );

  server.registerTool(
    "rocreate_upload_model",
    {
      title: "RoCreate Upload Model",
      description:
        "Upload a local .fbx from THIS computer to Roblox as a brand-new Model asset (imported as " +
        "MeshParts) via the Open Cloud KEY (rocreate.apiKey), owned by `creator` ({type:'user'|" +
        "'group', id}) -> { assetId, assetUri, moderationState, granted? }. KEY-ONLY: no cookie/" +
        "unlock needed. Provide filePath (.fbx) OR content (base64, contentType required, must be " +
        "model/*) -- exactly one. Optional grantUniverseId grants it into a universe (verified, not " +
        "trusted). Net-new id; load it in-game with InsertService:LoadAsset(assetId). To clone a " +
        "mesh/animation that already lives INSIDE a place, use rocreate_reupload_assets instead.",
      inputSchema: {
        creator: creatorArg,
        filePath: z.string().optional(),
        content: z.string().optional(),
        contentType: z.string().optional(),
        displayName: z.string(),
        description: z.string().optional(),
        grantUniverseId: z.string().optional(),
      },
    },
    async ({ creator, filePath, content, contentType, displayName, description, grantUniverseId }) => {
      const reason = gateToolCall("rocreate_upload_model");
      if (reason) return blocked(reason);
      return rocreateUploadLocal({
        assetType: "Model",
        creator: creator as Creator,
        filePath,
        content,
        contentType,
        displayName,
        description,
        extMap: RC_MODEL_EXT,
        mediaPrefix: "model/",
        grantUniverseId,
      });
    }
  );

  server.registerTool(
    "rocreate_upload_folder",
    {
      title: "RoCreate Upload Folder",
      description:
        "Bulk-upload every image/audio file in a LOCAL folder to Roblox as brand-new assets via the " +
        "Open Cloud KEY (rocreate.apiKey), owned by `creator` ({type:'user'|'group', id}) -- ideal " +
        "for a UI export folder of PNGs. { creator, folderPath, kind?:'auto'|'image'|'audio' " +
        "(default auto), grantUniverseId?, dryRun? } -> { uploaded, failed, results:[{ file, " +
        "assetId?, assetUri?, moderationState?, granted?, error? }] }. KEY-ONLY. Each file's " +
        "displayName is its filename (no extension); contentType is inferred from the extension " +
        "(png/jpg/jpeg/bmp/tga, mp3/ogg). Non-media files and subfolders are skipped (top-level " +
        "only, NOT recursive). grantUniverseId grants each AUDIO into a universe (images need no " +
        "grant). dryRun lists what WOULD upload with no uploads. Each file gets its own NEW id.",
      inputSchema: {
        creator: creatorArg,
        folderPath: z.string(),
        kind: z.enum(["auto", "image", "audio"]).default("auto"),
        grantUniverseId: z.string().optional(),
        dryRun: z.boolean().default(false),
      },
    },
    async ({ creator, folderPath, kind, grantUniverseId, dryRun }) => {
      const reason = gateToolCall("rocreate_upload_folder");
      if (reason) return blocked(reason);
      const key = rocreateKey();
      if (!key) return blocked("no RoCreate API key -- set rocreate.apiKey in config.json");
      const cr = creator as Creator;
      const cErr = creatorIdError(cr);
      if (cErr) return blocked(cErr);

      let names: string[];
      try {
        names = readdirSync(folderPath);
      } catch (e) {
        return blocked(`could not read folderPath: ${e instanceof Error ? e.message : String(e)}`);
      }

      const plan: { file: string; full: string; assetType: "Image" | "Audio"; contentType: string }[] = [];
      for (const name of names) {
        const ext = extname(name).toLowerCase();
        const media = RC_MEDIA[ext];
        if (!media) continue;
        if (kind !== "auto" && media.type.toLowerCase() !== kind) continue;
        const full = join(folderPath, name);
        try {
          if (statSync(full).isDirectory()) continue;
        } catch {
          continue;
        }
        plan.push({ file: name, full, assetType: media.type, contentType: media.ct });
      }

      if (plan.length === 0) {
        return blocked(
          "no matching files in folder (supported: png/jpg/jpeg/bmp/tga, mp3/ogg; top-level only)"
        );
      }
      if (dryRun) {
        return jsonResult({
          dryRun: true,
          folderPath,
          creator: cr,
          wouldUpload: plan.map((p) => ({ file: p.file, assetType: p.assetType })),
        });
      }

      const results: Record<string, unknown>[] = [];
      for (const p of plan) {
        let bytes: Buffer;
        try {
          bytes = readFileSync(p.full);
        } catch (e) {
          results.push({ file: p.file, ok: false, error: `read failed: ${e instanceof Error ? e.message : String(e)}` });
          continue;
        }
        const displayName = p.file.slice(0, p.file.length - extname(p.file).length) || p.file;
        const up = await ocUploadOne({
          apiKey: key,
          creator: cr,
          assetType: p.assetType,
          displayName,
          bytes,
          contentType: p.contentType,
          // Only audio needs a grant; grant-calling an image id is a wasted 4xx.
          grantUniverseId: p.assetType === "Audio" ? grantUniverseId : undefined,
        });
        if (up.ok) {
          const row: Record<string, unknown> = {
            file: p.file,
            ok: true,
            assetId: up.assetId,
            assetUri: up.assetUri,
            moderationState: up.moderationState,
          };
          if (up.granted !== undefined) row.granted = up.granted;
          if (up.grantNote) row.grantNote = up.grantNote;
          results.push(row);
        } else {
          results.push({ file: p.file, ok: false, error: up.error });
        }
      }
      return jsonResult({
        folderPath,
        creator: cr,
        uploaded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      });
    }
  );

  server.registerTool(
    "rocreate_grant_asset",
    {
      title: "RoCreate Grant Asset",
      description:
        "Grant Use-permission for an EXISTING asset you own into a universe (or a user/group) via " +
        "the Open Cloud KEY (rocreate.apiKey). { assetId, universeId } (or subjectType + subjectId) " +
        "-> { granted, grantedAssetIds, grantNote? }. KEY-ONLY. Verify-not-trust: granted:false + " +
        "grantNote means the 200 did NOT confirm the asset (e.g. the key lacks " +
        "asset-permissions:write, or the asset is public and needs no grant). Grant-only -- there " +
        "is NO API revoke. Use for an audio/restricted asset id you already have (e.g. from " +
        "rocreate_upload_audio) that needs to play inside a specific game.",
      inputSchema: {
        assetId: z.string(),
        universeId: z.string().optional(),
        subjectType: z.enum(["Universe", "User", "Group"]).optional(),
        subjectId: z.string().optional(),
        grantToDependencies: z.boolean().optional(),
      },
    },
    async ({ assetId, universeId, subjectType, subjectId, grantToDependencies }) => {
      const reason = gateToolCall("rocreate_grant_asset");
      if (reason) return blocked(reason);
      const key = rocreateKey();
      if (!key) return blocked("no RoCreate API key -- set rocreate.apiKey in config.json");
      const st = subjectType ?? "Universe";
      const sid = subjectId ?? universeId;
      if (!sid) return blocked("provide universeId (or subjectType + subjectId)");
      const g = await grantAssetPermission({
        apiKey: key,
        assetId,
        subjectType: st,
        subjectId: sid,
        grantToDependencies,
      });
      return jsonResult({
        assetId,
        subjectType: st,
        subjectId: sid,
        granted: g.ok,
        grantedAssetIds: g.grantedAssetIds,
        grantNote: g.ok ? undefined : g.error,
      });
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
        // Same nested-price shape as dev products (defensive; flat fallbacks kept).
        priceInRobux: Number(
          p.priceInformation?.defaultPriceInRobux ?? p.priceInRobux ?? p.price ?? 0
        ),
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

  // ----- Bucket 1: Eyes in Studio (orbit/selection capture, visual diff, -----
  // client-capture feasibility) ----------------------------------------------
  // Generous per-step timeout: these compose several plugin round-trips (camera
  // read/write + up to 6 captures), and capture_viewport alone can take up to
  // ~10s inside the plugin (screenshot callback + tiled pixel read). commandTimeoutMs
  // defaults to 30s; floor every step in these composites at 45s so a slow Studio
  // frame never trips an internal timeout before the whole composite finishes.
  const EYES_STEP_TIMEOUT_MS = Math.max(cfg.commandTimeoutMs, 45000);

  const ORBIT_ANGLES = ["front", "back", "left", "right", "top", "iso"] as const;
  type OrbitAngle = (typeof ORBIT_ANGLES)[number];

  // Convention (matches focus_instance's own framing math): a model's front
  // faces -Z, so the "front" camera sits further out along -Z looking back
  // toward the center; iso/top follow the brief's own turntable angles. All
  // offsets are relative to the bounding-box center.
  function orbitEyeOffset(angle: OrbitAngle, distance: number): [number, number, number] {
    switch (angle) {
      case "front":
        return [0, 0, -distance];
      case "back":
        return [0, 0, distance];
      case "left":
        return [-distance, 0, 0];
      case "right":
        return [distance, 0, 0];
      case "top":
        return [0, distance, 0.001]; // tiny Z nudge: CFrame.lookAt is unstable looking straight down
      case "iso": {
        const v = [1, 0.8, -1];
        const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [(v[0] / len) * distance, (v[1] / len) * distance, (v[2] / len) * distance];
      }
    }
  }

  interface BBox {
    center: [number, number, number];
    size: { x: number; y: number; z: number };
  }

  // Shared by orbit_capture and visual_diff's path-framing.
  async function fetchBoundingBox(path: string): Promise<{ bbox?: BBox; error?: string }> {
    const r = await enqueueAndAwait("get_bounding_box", "edit", { path }, EYES_STEP_TIMEOUT_MS);
    if (!r.ok) return { error: r.error ?? (r as { err?: string }).err ?? "get_bounding_box failed" };
    const res = r.result as
      | { cframe?: { comps?: number[] }; size?: { x: number; y: number; z: number } }
      | undefined;
    const comps = res?.cframe?.comps;
    const size = res?.size;
    if (!Array.isArray(comps) || comps.length < 3 || !size) {
      return { error: "get_bounding_box returned an unexpected shape" };
    }
    return { bbox: { center: [comps[0], comps[1], comps[2]], size } };
  }

  function orbitDistance(size: { x: number; y: number; z: number }): number {
    return Math.max(10, Math.max(size.x, size.y, size.z) * 1.9);
  }

  server.registerTool(
    "orbit_capture",
    {
      title: "Orbit Capture",
      description:
        "Node-side composite (zero new plugin code): frame an instance from up to 6 fixed " +
        "angles and capture a PNG at each. Saves the current camera first and ALWAYS restores " +
        "it after (even on error). Angles: 'front'/'back' along -Z/+Z, 'left'/'right' along " +
        "-X/+X, 'top' straight down, 'iso' a 3/4 turntable angle -- all framed from the " +
        "instance's world-space bounding box (get_bounding_box) at a distance scaled to its " +
        "size. Same engine limits as capture_viewport (edit-mode viewport only, Allow " +
        "Mesh/Image APIs).",
      inputSchema: {
        path: z.string(),
        angles: z.array(z.enum(ORBIT_ANGLES)).min(1).max(6).default(["front", "right", "top", "iso"]),
        context: contextArg,
      },
    },
    async ({ path, angles, context: _context }) => {
      const reason = gateToolCall("orbit_capture");
      if (reason) return blocked(reason);

      let savedCframe: unknown = null;
      try {
        const camRes = await enqueueAndAwait("get_camera", "edit", {}, EYES_STEP_TIMEOUT_MS);
        if (camRes.ok && camRes.result && typeof camRes.result === "object") {
          savedCframe = (camRes.result as { cframe?: unknown }).cframe ?? null;
        }
      } catch {
        // best-effort save; if this fails we simply can't restore later
      }

      const { bbox, error } = await fetchBoundingBox(path);
      if (!bbox) return blocked(error ?? "orbit_capture: could not read bounding box");
      const distance = orbitDistance(bbox.size);

      const lines = [
        `orbit_capture: ${path}`,
        `bbox center=(${bbox.center.map((n) => n.toFixed(2)).join(", ")}) ` +
          `size=(${bbox.size.x.toFixed(2)}, ${bbox.size.y.toFixed(2)}, ${bbox.size.z.toFixed(2)})`,
        `distance=${distance.toFixed(2)}`,
        `angles: ${angles.join(", ")}`,
      ];
      const images: { type: "image"; data: string; mimeType: string }[] = [];

      try {
        for (const angle of angles) {
          const off = orbitEyeOffset(angle, distance);
          const position = [bbox.center[0] + off[0], bbox.center[1] + off[1], bbox.center[2] + off[2]];
          const setRes = await enqueueAndAwait(
            "set_camera",
            "edit",
            { position, lookAt: bbox.center },
            EYES_STEP_TIMEOUT_MS
          );
          if (!setRes.ok) {
            lines.push(`${angle}: set_camera failed: ${setRes.error ?? "unknown error"}`);
            continue;
          }
          const capRes = await enqueueAndAwait("capture_viewport", "edit", {}, EYES_STEP_TIMEOUT_MS);
          if (!capRes.ok) {
            lines.push(
              `${angle}: capture failed: ${capRes.error ?? (capRes as { err?: string }).err ?? "unknown error"}`
            );
            continue;
          }
          const cap = capRes.result as { rgba?: string; width?: number; height?: number } | undefined;
          if (typeof cap?.rgba === "string" && typeof cap.width === "number" && typeof cap.height === "number") {
            try {
              const png = rgbaToPng(Buffer.from(cap.rgba, "base64"), cap.width, cap.height);
              images.push({ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" });
              lines.push(`${angle}: captured (${cap.width}x${cap.height})`);
            } catch (e) {
              lines.push(`${angle}: PNG encode failed: ${String(e)}`);
            }
          } else {
            lines.push(`${angle}: capture returned no image data`);
          }
        }
      } finally {
        if (savedCframe) {
          try {
            await enqueueAndAwait("set_camera", "edit", { cframe: savedCframe }, EYES_STEP_TIMEOUT_MS);
          } catch {
            lines.push("(camera restore failed -- Studio camera was left at the last orbit angle)");
          }
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }, ...images] };
    }
  );

  server.registerTool(
    "selection_capture",
    {
      title: "Selection Capture",
      description:
        "Screenshot with each target instance temporarily highlighted (a Highlight overlay, " +
        "distinct color per target from a fixed 8-color palette) and optionally auto-framed on " +
        "their combined bounding box. Defaults to the current Studio selection when paths is " +
        "omitted. Highlights are destroyed and the camera restored after the capture, even on " +
        "error. Same engine limits as capture_viewport (edit-mode viewport only, Allow " +
        "Mesh/Image APIs). Returns the PNG plus a legend mapping each path to its color.",
      inputSchema: {
        paths: z.array(z.string()).optional(),
        autoFrame: z.boolean().default(true),
        fill: z.boolean().default(true),
        context: contextArg,
      },
    },
    async ({ paths, autoFrame, fill, context: _context }) =>
      call("selection_capture", "edit", { paths, autoFrame, fill })
  );

  interface VisualBaseline {
    rgba: Buffer;
    width: number;
    height: number;
    camera: unknown; // tagged serialized CFrame from get_camera's result -- fed straight back into set_camera({cframe})
  }
  const VISUAL_BASELINE_CAP = 8;
  const visualBaselines = new Map<string, VisualBaseline>();

  function rememberBaseline(label: string, b: VisualBaseline): void {
    if (visualBaselines.has(label)) visualBaselines.delete(label); // bump to most-recent
    visualBaselines.set(label, b);
    while (visualBaselines.size > VISUAL_BASELINE_CAP) {
      const oldest = visualBaselines.keys().next().value;
      if (oldest === undefined) break;
      visualBaselines.delete(oldest);
    }
  }

  // Raw capture bypassing renderResult's PNG conversion -- visual_diff needs the
  // decoded Buffer itself (to store as a baseline, or to diff pixel-by-pixel).
  async function captureRaw(): Promise<{ rgba: Buffer; width: number; height: number } | { error: string }> {
    const r = await enqueueAndAwait("capture_viewport", "edit", {}, EYES_STEP_TIMEOUT_MS);
    if (!r.ok) return { error: r.error ?? (r as { err?: string }).err ?? "capture_viewport failed" };
    const res = r.result as { rgba?: string; width?: number; height?: number } | undefined;
    if (typeof res?.rgba !== "string" || typeof res.width !== "number" || typeof res.height !== "number") {
      return { error: "capture_viewport returned no image data" };
    }
    return { rgba: Buffer.from(res.rgba, "base64"), width: res.width, height: res.height };
  }

  server.registerTool(
    "visual_diff",
    {
      title: "Visual Diff",
      description:
        "Node-side in-memory visual regression check (baselines are NOT persisted to disk -- " +
        "an LRU of the last 8 labels lives for this server process only). mode='baseline': " +
        "optionally frame `path` (same iso angle as orbit_capture), capture, and store it under " +
        "`label` along with the camera used. mode='compare': replay that SAME stored camera, " +
        "capture again, and report percent-of-pixels-changed (>12 max-channel-delta threshold), " +
        "mean delta, and the changed-region bounding box. Restores whatever camera was active " +
        "before the compare. A dimension mismatch (e.g. Studio window resized) is reported as " +
        "text instead of computing bogus stats.",
      inputSchema: {
        mode: z.enum(["baseline", "compare"]),
        label: z.string(),
        path: z.string().optional().describe("baseline mode only: frame this instance before capturing"),
        context: contextArg,
      },
    },
    async ({ mode, label, path, context: _context }) => {
      const reason = gateToolCall("visual_diff");
      if (reason) return blocked(reason);

      if (mode === "baseline") {
        if (path) {
          const { bbox, error } = await fetchBoundingBox(path);
          if (!bbox) return blocked(error ?? "visual_diff: could not read bounding box");
          const distance = orbitDistance(bbox.size);
          const off = orbitEyeOffset("iso", distance);
          const position = [bbox.center[0] + off[0], bbox.center[1] + off[1], bbox.center[2] + off[2]];
          const setRes = await enqueueAndAwait(
            "set_camera",
            "edit",
            { position, lookAt: bbox.center },
            EYES_STEP_TIMEOUT_MS
          );
          if (!setRes.ok) return blocked(`visual_diff: set_camera failed: ${setRes.error ?? "unknown error"}`);
        }
        const camRes = await enqueueAndAwait("get_camera", "edit", {}, EYES_STEP_TIMEOUT_MS);
        const camera = camRes.ok ? ((camRes.result as { cframe?: unknown } | undefined)?.cframe ?? null) : null;
        const cap = await captureRaw();
        if ("error" in cap) return blocked(`visual_diff: ${cap.error}`);
        rememberBaseline(label, { rgba: cap.rgba, width: cap.width, height: cap.height, camera });
        const png = rgbaToPng(cap.rgba, cap.width, cap.height);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `visual_diff: stored baseline '${label}' (${cap.width}x${cap.height})` +
                (path ? ` framed on ${path}` : ""),
            },
            { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
          ],
        };
      }

      // mode === "compare"
      const base = visualBaselines.get(label);
      if (!base) {
        return blocked(
          `visual_diff: no baseline stored for label '${label}' -- run mode='baseline' first ` +
            `(known labels: ${[...visualBaselines.keys()].join(", ") || "none"})`
        );
      }

      let savedCframe: unknown = null;
      try {
        const camRes = await enqueueAndAwait("get_camera", "edit", {}, EYES_STEP_TIMEOUT_MS);
        if (camRes.ok) savedCframe = (camRes.result as { cframe?: unknown } | undefined)?.cframe ?? null;
      } catch {
        // best-effort
      }

      let cap: { rgba: Buffer; width: number; height: number } | { error: string };
      try {
        if (base.camera) {
          const setRes = await enqueueAndAwait(
            "set_camera",
            "edit",
            { cframe: base.camera },
            EYES_STEP_TIMEOUT_MS
          );
          if (!setRes.ok) {
            return blocked(`visual_diff: could not replay baseline camera: ${setRes.error ?? "unknown error"}`);
          }
        }
        cap = await captureRaw();
      } finally {
        if (savedCframe) {
          try {
            await enqueueAndAwait("set_camera", "edit", { cframe: savedCframe }, EYES_STEP_TIMEOUT_MS);
          } catch {
            // best-effort restore
          }
        }
      }
      if ("error" in cap) return blocked(`visual_diff: ${cap.error}`);

      rememberBaseline(label, base); // touch LRU on read too

      const beforePng = rgbaToPng(base.rgba, base.width, base.height);
      const afterPng = rgbaToPng(cap.rgba, cap.width, cap.height);

      if (base.width !== cap.width || base.height !== cap.height) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `visual_diff '${label}': resize mismatch -- baseline is ${base.width}x${base.height}, ` +
                `current capture is ${cap.width}x${cap.height}. No pixel diff computed.`,
            },
            { type: "image" as const, data: beforePng.toString("base64"), mimeType: "image/png" },
            { type: "image" as const, data: afterPng.toString("base64"), mimeType: "image/png" },
          ],
        };
      }

      const THRESHOLD = 12;
      const total = base.width * base.height;
      let changed = 0;
      let deltaSum = 0;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < total; i++) {
        const o = i * 4;
        const dr = Math.abs(base.rgba[o] - cap.rgba[o]);
        const dg = Math.abs(base.rgba[o + 1] - cap.rgba[o + 1]);
        const db = Math.abs(base.rgba[o + 2] - cap.rgba[o + 2]);
        const delta = Math.max(dr, dg, db);
        deltaSum += delta;
        if (delta > THRESHOLD) {
          changed++;
          const x = i % base.width;
          const y = (i / base.width) | 0;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      const stats = {
        label,
        width: base.width,
        height: base.height,
        pixelsChangedPct: total > 0 ? (changed / total) * 100 : 0,
        meanDelta: total > 0 ? deltaSum / total : 0,
        threshold: THRESHOLD,
        changedBounds: changed > 0 ? { minX, minY, maxX, maxY } : null,
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(stats, null, 2) },
          { type: "image" as const, data: beforePng.toString("base64"), mimeType: "image/png" },
          { type: "image" as const, data: afterPng.toString("base64"), mimeType: "image/png" },
        ],
      };
    }
  );

  // ----- ui_capture / playtest_gif: client-capture feasibility verdict -------
  // Investigated plugin/src/ClientAgentSource.luau and RuntimeAgentSource.luau
  // end-to-end before writing either tool. Finding: the F5 client agent is a
  // FIXED, intentionally-closed query whitelist by design (its own header:
  // "== Fixed named queries ==" / "arbitrary client eval is NOT supported --
  // these are the only introspection points the client offers"), relayed
  // server<->client over ONE RemoteEvent (NikMCP_ClientRelay) with a closed set
  // of kinds ("query"/"queryResult"/"logs") correlated by id -- see
  // RuntimeAgentSource.luau's relay.OnServerEvent handler. That is NOT the same
  // shape as Executor.execute's ~80-entry, freely-extensible cmd.type dispatch;
  // it is the narrower surface the brief's decision rule calls a "hardcoded
  // query whitelist". Both tools are therefore registered honestly-unsupported,
  // entirely Node-side (no Executor.luau/ClientAgentSource.luau changes --
  // there is no edit-context plugin work to dispatch, since the limitation is
  // about the F5 client, a different execution context Executor.luau never
  // touches), rather than smuggling a new heavy capability into a surface
  // explicitly designed to stay closed.
  server.registerTool(
    "ui_capture",
    {
      title: "UI Capture",
      description:
        "UNSUPPORTED: pixel-level GUI capture requires running inside the F5 play-mode CLIENT " +
        "(CaptureService hides SurfaceGuis by design, and ScreenGuis only exist client-side), " +
        "but the client agent (ClientAgentSource.luau) is a fixed, intentionally-closed " +
        "introspection whitelist (fps/camera/gui_tree/local_player/ping) -- arbitrary client " +
        "eval is explicitly not supported there, and adding pixel capture would mean smuggling " +
        "a heavy new capability into a surface designed to stay minimal. Use client_query " +
        "name='gui_tree' for GUI structure in the meantime. If ever implemented: also requires " +
        "Game Settings > Security > 'Allow Mesh / Image APIs'.",
      inputSchema: { strip: z.boolean().optional() },
    },
    async () => {
      const reason = gateToolCall("ui_capture");
      if (reason) return blocked(reason);
      return blocked(
        "ui_capture is not supported: the F5 client agent is a fixed introspection whitelist, " +
          "not a general command executor -- pixel capture cannot be added without opening it up " +
          "to arbitrary client-side logic. Use client_query name='gui_tree' for GUI structure."
      );
    }
  );

  server.registerTool(
    "playtest_gif",
    {
      title: "Playtest GIF",
      description:
        "UNSUPPORTED for the same reason as ui_capture: it depends on the same client-side " +
        "pixel capture, which the F5 client agent's fixed introspection whitelist does not " +
        "offer. Would otherwise loop client captures at `intervalMs` for `frames` and encode an " +
        "animated GIF Node-side.",
      inputSchema: {
        frames: z.number().int().min(1).max(8).default(5),
        intervalMs: z.number().int().min(100).default(500),
      },
    },
    async () => {
      const reason = gateToolCall("playtest_gif");
      if (reason) return blocked(reason);
      return blocked(
        "playtest_gif is not supported: it needs the same client-side pixel capture ui_capture " +
          "would need, which the F5 client agent's fixed introspection whitelist does not offer."
      );
    }
  );

  // ----- Bucket 2: project understanding ------------------------------------
  // remote_inventory / datastore_inventory / require_graph: thin passthroughs to
  // new plugin-side scanning commands (same shape as get_project_structure /
  // grep_scripts). monetization_map / place_digest are Node-side composites.
  // 60s timeout floor for the composites' internal steps, same reasoning as
  // Bucket 1's EYES_STEP_TIMEOUT_MS: these scan every script source in the
  // place, which can take longer than the 30s default on a large project.
  const DIGEST_STEP_TIMEOUT_MS = Math.max(cfg.commandTimeoutMs, 60000);

  server.registerTool(
    "remote_inventory",
    {
      title: "Remote Inventory",
      description:
        "Every RemoteEvent/RemoteFunction/UnreliableRemoteEvent/BindableEvent/BindableFunction " +
        "under root (path + className), cross-referenced with a name-matched usage scan across " +
        "every script source (FireServer/InvokeServer/OnServerEvent/OnServerInvoke/FireClient/" +
        "FireAllClients/OnClientEvent/OnClientInvoke/Fire/Invoke/Event:Connect/WaitForChild/" +
        "FindFirstChild). Usages for a name shared by multiple remotes are attributed to all of " +
        "them and marked ambiguous. Caps: 400 remotes, 40 usages/remote (truncated flags).",
      inputSchema: { root: z.string().default("game"), context: contextArg },
    },
    async ({ root, context }) => call("remote_inventory", chooseContext(context), { root })
  );

  server.registerTool(
    "datastore_inventory",
    {
      title: "Datastore Inventory",
      description:
        "Scans every script source for GetDataStore/GetOrderedDataStore/GetGlobalDataStore and " +
        "MemoryStoreService GetSortedMap/GetQueue declarations, plus GetAsync/SetAsync/" +
        "UpdateAsync/IncrementAsync/RemoveAsync/GetSortedAsync operation calls. Groups by store " +
        "name (literal string args; non-literal names reported dynamic:true with the source " +
        "expression). Operations are attributed to a store by tracked local-variable assignment " +
        "when possible (inferred:false), else to the nearest store declared earlier in the same " +
        "script (inferred:true); operations that cannot be attributed at all land in " +
        "unattributedOperations. { root } -> { stores:[{name,scope,className,dynamic,declaredIn," +
        "operations}], unattributedOperations, summary:{storeCount,scriptsTouchingData," +
        "dynamicNames} }.",
      inputSchema: { root: z.string().default("game"), context: contextArg },
    },
    async ({ root, context }) => call("datastore_inventory", chooseContext(context), { root })
  );

  server.registerTool(
    "require_graph",
    {
      title: "Require Graph",
      description:
        "Every require() call site under root, best-effort resolved against the live DataModel: " +
        "game.X.Y, game:GetService(\"X\").Y, script.Parent.X, script.X, and :WaitForChild(\"X\")/" +
        ":FindFirstChild(\"X\") chains resolve to a concrete instance path; require(12345) numeric " +
        "asset ids report { assetId }; anything else is unresolved (raw expression text, omitted " +
        "when includeUnresolved:false). { edges:[{from,to,kind,line}], summary:{moduleCount," +
        "edgeCount,unresolvedCount,topRequired (top 10 by in-degree),cycles (DFS over resolved " +
        "edges, capped at 10)} }. Cap: 3000 edges (truncated flag).",
      inputSchema: {
        root: z.string().default("game"),
        includeUnresolved: z.boolean().default(true),
        context: contextArg,
      },
    },
    async ({ root, includeUnresolved, context }) =>
      call("require_graph", chooseContext(context), { root, includeUnresolved })
  );

  server.registerTool(
    "monetization_map",
    {
      title: "Monetization Map",
      description:
        "Node composite: (1) scans every script source for PromptProductPurchase/" +
        "PromptGamePassPurchase/PromptPurchase/UserOwnsGamePassAsync/GetProductInfo call sites, " +
        "id-like variable bindings (name contains 'product'/'gamepass'/'game_pass' + numeric " +
        "literal), and ProcessReceipt assignments; (2) when universeId is given and a RoCreate " +
        "API key is configured, fetches the universe's live developer products + game passes " +
        "(same Open Cloud call as rocreate_list_monetization) and merges: each live item gets " +
        "wired (its id appears in code) + wiredAt (the code sites); each code id gets orphanCode " +
        "(does not match any live id). Missing universeId/key degrades gracefully to the code-" +
        "only scan with a note, never an error. Read-only.",
      inputSchema: { root: z.string().default("game"), universeId: z.string().optional() },
    },
    async ({ root, universeId }) => {
      const reason = gateToolCall("monetization_map");
      if (reason) return blocked(reason);
      const scanRes = await enqueueAndAwait("monetization_scan", "edit", { root }, DIGEST_STEP_TIMEOUT_MS);
      if (!scanRes.ok) {
        return blocked(scanRes.error ?? (scanRes as { err?: string }).err ?? "monetization_scan failed");
      }
      const scan = scanRes.result as
        | {
            promptSites?: { script: string; line: number; kind: string; idLiteral?: number }[];
            idBindings?: { script: string; line: number; name: string; id: number }[];
            processReceipt?: { script: string; line: number }[];
          }
        | undefined;
      const promptSites = scan?.promptSites ?? [];
      const idBindings = scan?.idBindings ?? [];
      const processReceipt = scan?.processReceipt ?? [];

      let liveProducts: any[] | undefined;
      let liveGamepasses: any[] | undefined;
      let note: string | undefined;
      const key = rocreateKey();
      if (!universeId) {
        note = "no universeId provided -- live product/gamepass data skipped (code-only scan below)";
      } else if (!key) {
        note = "no RoCreate API key -- set rocreate.apiKey in config.json for live data (code-only scan below)";
      } else {
        try {
          const [dp, gp] = await Promise.all([
            listDeveloperProducts(key, universeId),
            listGamePasses(key, universeId),
          ]);
          if (dp.ok) liveProducts = dp.items;
          else note = `developer products: ${dp.error}`;
          if (gp.ok) liveGamepasses = gp.items;
          else note = (note ? note + "; " : "") + `game passes: ${gp.error}`;
        } catch (e) {
          note = `live monetization fetch failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      const liveIdSet =
        liveProducts || liveGamepasses
          ? new Set<string>(
              [...(liveProducts ?? []), ...(liveGamepasses ?? [])].flatMap((it: any) =>
                ["id", "productId", "developerProductId", "gamePassId"]
                  .map((k) => it?.[k])
                  .filter((v) => v !== undefined && v !== null)
                  .map(String)
              )
            )
          : null;

      function wireLive(items: any[] | undefined, idKeys: string[]) {
        if (!items) return undefined;
        return items.map((it) => {
          const idStr = idKeys.map((k) => it?.[k]).find((v) => v !== undefined && v !== null);
          const id = idStr !== undefined ? String(idStr) : undefined;
          const wiredAt: { script: string; line: number; via: string; name?: string }[] = [];
          if (id) {
            for (const s of promptSites) {
              if (s.idLiteral !== undefined && String(s.idLiteral) === id) {
                wiredAt.push({ script: s.script, line: s.line, via: "promptSite" });
              }
            }
            for (const b of idBindings) {
              if (String(b.id) === id) wiredAt.push({ script: b.script, line: b.line, via: "idBinding", name: b.name });
            }
          }
          return { ...it, wired: wiredAt.length > 0, wiredAt };
        });
      }
      const liveProductsOut = wireLive(liveProducts, ["id", "productId", "developerProductId"]);
      const liveGamepassesOut = wireLive(liveGamepasses, ["id", "gamePassId"]);

      const promptSitesOut = promptSites.map((s) =>
        liveIdSet && s.idLiteral !== undefined
          ? { ...s, orphanCode: !liveIdSet.has(String(s.idLiteral)) }
          : s
      );
      const idBindingsOut = idBindings.map((b) =>
        liveIdSet ? { ...b, orphanCode: !liveIdSet.has(String(b.id)) } : b
      );

      const wiringSummary = {
        promptSiteCount: promptSitesOut.length,
        idBindingCount: idBindingsOut.length,
        processReceiptCount: processReceipt.length,
        liveProductCount: liveProductsOut?.length,
        liveGamepassCount: liveGamepassesOut?.length,
        wiredLiveCount:
          liveProductsOut || liveGamepassesOut
            ? [...(liveProductsOut ?? []), ...(liveGamepassesOut ?? [])].filter((x) => x.wired).length
            : undefined,
        orphanCodeCount:
          liveIdSet !== null
            ? [...promptSitesOut, ...idBindingsOut].filter((x: any) => x.orphanCode).length
            : undefined,
      };

      return jsonResult({
        liveProducts: liveProductsOut,
        liveGamepasses: liveGamepassesOut,
        promptSites: promptSitesOut,
        idBindings: idBindingsOut,
        processReceipt,
        wiringSummary,
        note,
      });
    }
  );

  server.registerTool(
    "place_digest",
    {
      title: "Place Digest",
      description:
        "Node composite: sequentially runs get_project_structure, digest_extras (script/tag/" +
        "workspace/StarterGui/sound/animation counts), remote_inventory, datastore_inventory, and " +
        "monetization_scan (NOT monetization_map -- no network calls), then assembles one report: " +
        "a short human-readable overview (place id, per-service sizes, script counts, remote/" +
        "store/prompt-site counts, tag count) followed by the full merged JSON. `include` skips " +
        "heavy parts (default all): structure, extras, remotes, datastores, monetization. A step " +
        "that errors is recorded under errors{} without failing the whole digest. Read-only.",
      inputSchema: {
        include: z
          .array(z.enum(["structure", "extras", "remotes", "datastores", "monetization"]))
          .optional(),
      },
    },
    async ({ include }) => {
      const reason = gateToolCall("place_digest");
      if (reason) return blocked(reason);
      const want = new Set(include && include.length ? include : ["structure", "extras", "remotes", "datastores", "monetization"]);

      const parts: Record<string, any> = {};
      const errors: Record<string, string> = {};

      async function step(key: string, type: string, payload: unknown) {
        if (!want.has(key)) return;
        const r = await enqueueAndAwait(type, "edit", payload, DIGEST_STEP_TIMEOUT_MS);
        if (r.ok) parts[key] = r.result;
        else errors[key] = r.error ?? (r as { err?: string }).err ?? `${type} failed`;
      }

      await step("structure", "get_project_structure", {});
      await step("extras", "digest_extras", {});
      await step("remotes", "remote_inventory", { root: "game" });
      await step("datastores", "datastore_inventory", { root: "game" });
      await step("monetization", "monetization_scan", { root: "game" });

      const structure = parts.structure as
        | { placeId?: number; gameId?: number; services?: { name: string; childCount: number }[] }
        | undefined;
      const extras = parts.extras as
        | { scriptCounts?: { Script: number; LocalScript: number; ModuleScript: number }; totalInstances?: number; tags?: Record<string, number> }
        | undefined;
      const remotes = parts.remotes as { remotes?: unknown[]; summary?: unknown } | undefined;
      const datastores = parts.datastores as { summary?: unknown } | undefined;
      const monetization = parts.monetization as { promptSites?: unknown[] } | undefined;

      const lines: string[] = [];
      lines.push(`place_digest: placeId=${structure?.placeId ?? "?"} gameId=${structure?.gameId ?? "?"}`);
      if (structure?.services) {
        lines.push(`services: ${structure.services.map((s) => `${s.name}(${s.childCount})`).join(", ")}`);
      }
      if (extras) {
        const sc = extras.scriptCounts;
        lines.push(
          `scripts: Script=${sc?.Script ?? 0} LocalScript=${sc?.LocalScript ?? 0} ModuleScript=${sc?.ModuleScript ?? 0}; ` +
            `totalInstances=${extras.totalInstances ?? "?"}; tags=${extras.tags ? Object.keys(extras.tags).length : 0}`
        );
      }
      if (remotes) lines.push(`remotes: ${remotes.remotes?.length ?? 0} (${JSON.stringify(remotes.summary ?? {})})`);
      if (datastores) lines.push(`datastores: ${JSON.stringify(datastores.summary ?? {})}`);
      if (monetization) lines.push(`monetization prompt sites: ${monetization.promptSites?.length ?? 0}`);
      if (Object.keys(errors).length) lines.push(`errors: ${JSON.stringify(errors)}`);

      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
          { type: "text" as const, text: JSON.stringify({ ...parts, errors: Object.keys(errors).length ? errors : undefined }, null, 2) },
        ],
      };
    }
  );

  // ----- Bucket 3: style / art direction -------------------------------------
  // ui_style_fingerprint / world_style_probe / ui_layout_probe: thin passthroughs
  // to new plugin-side inspection commands (same shape as get_project_structure),
  // each with a Node-side classifier appended as a readable summary. lighting_profile
  // is a fixed edit-context passthrough (no root/context input -- Lighting is a
  // single service). art_direction_report is a Node composite with zero new
  // plugin code: it re-runs the same three plugin commands directly and reuses
  // the same classifier functions to write one art-direction brief.
  // 60s timeout floor, same reasoning as Bucket 2's DIGEST_STEP_TIMEOUT_MS: a
  // world_style_probe / ui_layout_probe walk can outrun the 30s default on a
  // large place.
  const STYLE_STEP_TIMEOUT_MS = Math.max(cfg.commandTimeoutMs, 60000);

  interface UiFingerprintRaw {
    root?: string;
    objectCount?: number;
    truncated?: boolean;
    fonts?: {
      families?: { family: string; count: number }[];
      textScaledCount?: number;
      textFixedCount?: number;
      textSizeDistribution?: Record<string, number>;
    };
    corners?: { count?: number; buckets?: { sharp?: number; rounded?: number; pill?: number } };
    strokes?: {
      count?: number;
      thicknessDistribution?: Record<string, number>;
      colors?: { hex: string; count: number }[];
      applyStrokeModeCounts?: Record<string, number>;
    };
    gradients?: { count?: number; topColorPairs?: { pair: string; count: number }[] };
    colors?: { hex: string; count: number; sources?: { background: number; text: number; image: number } }[];
    shadows?: { heuristicCount?: number };
    layoutHygiene?: {
      size?: { scaleOnly: number; offsetOnly: number; mixed: number };
      position?: { scaleOnly: number; offsetOnly: number; mixed: number };
      paddingCount?: number;
      listLayoutCount?: number;
      gridLayoutCount?: number;
      aspectRatioConstraintCount?: number;
      centeredAnchorFraction?: number;
    };
    images?: { count?: number; distinctImageIds?: string[]; distinctImageIdCount?: number };
  }

  interface UiStyleTokens {
    palettePrimary: string[];
    paletteAccent: string[];
    fontPrimary?: string;
    fontSecondary?: string;
    cornerProfile: string;
    strokeProfile?: { typicalThickness: number; color: string };
    usesGradients: boolean;
    usesShadows: boolean;
  }

  // Shared by ui_style_fingerprint and art_direction_report -- one rule tree,
  // one token builder, used in both places so the two never drift apart.
  function classifyUiStyle(raw: UiFingerprintRaw | undefined): {
    styleClass: string;
    tokens: UiStyleTokens;
    hygieneWarnings: string[];
  } {
    const cornerCount = raw?.corners?.count ?? 0;
    const buckets = raw?.corners?.buckets ?? {};
    const sharp = buckets.sharp ?? 0;
    const rounded = buckets.rounded ?? 0;
    const pill = buckets.pill ?? 0;
    const strokeCount = raw?.strokes?.count ?? 0;
    const gradientCount = raw?.gradients?.count ?? 0;
    const shadowCount = raw?.shadows?.heuristicCount ?? 0;

    const denom = cornerCount || 1;
    const pillFrac = pill / denom;
    const roundedFrac = rounded / denom;

    const thicknessDist = raw?.strokes?.thicknessDistribution ?? {};
    let modalThickness = 0;
    let modalCount = -1;
    for (const [k, c] of Object.entries(thicknessDist)) {
      if (c > modalCount) {
        modalCount = c;
        modalThickness = Number(k) || 0;
      }
    }
    const hasThickStrokes = strokeCount > 0 && modalThickness >= 3;
    const hasShadows = shadowCount > 0;
    const hasGradients = gradientCount > 0;

    let styleClass: string;
    if (cornerCount === 0 && gradientCount === 0 && strokeCount === 0) {
      styleClass = "flat";
    } else if (pillFrac >= 0.4) {
      styleClass = "pill-heavy";
    } else if (pillFrac >= 0.15 && (hasShadows || hasThickStrokes)) {
      styleClass = "bubbly";
    } else if (roundedFrac >= 0.4 && !hasGradients) {
      styleClass = "rounded-soft";
    } else if (hasGradients && (hasShadows || strokeCount > 0)) {
      styleClass = "skeuo-textured";
    } else {
      styleClass = "mixed";
    }

    const colors = raw?.colors ?? [];
    const palettePrimary = colors
      .filter((c) => (c.sources?.background ?? 0) > 0)
      .slice(0, 3)
      .map((c) => c.hex);
    const paletteAccent = colors
      .filter((c) => (c.sources?.background ?? 0) === 0)
      .slice(0, 3)
      .map((c) => c.hex);

    const cornerProfile =
      pill >= rounded && pill >= sharp && pill > 0 ? "pill" : rounded >= sharp && rounded > 0 ? "rounded" : "sharp";

    const strokeColors = raw?.strokes?.colors ?? [];
    const strokeProfile =
      strokeCount > 0 ? { typicalThickness: modalThickness, color: strokeColors[0]?.hex ?? "#000000" } : undefined;

    const families = raw?.fonts?.families ?? [];
    const tokens: UiStyleTokens = {
      palettePrimary,
      paletteAccent,
      fontPrimary: families[0]?.family,
      fontSecondary: families[1]?.family,
      cornerProfile,
      strokeProfile,
      usesGradients: hasGradients,
      usesShadows: hasShadows,
    };

    const hygieneWarnings: string[] = [];
    const size = raw?.layoutHygiene?.size;
    if (size) {
      const total = size.scaleOnly + size.offsetOnly + size.mixed;
      if (total > 0) {
        const offsetPct = Math.round((100 * (size.offsetOnly + size.mixed)) / total);
        if (offsetPct >= 20) hygieneWarnings.push(`${offsetPct}% of Sizes use Offset (Scale is safer across devices).`);
      }
    }
    const pos = raw?.layoutHygiene?.position;
    if (pos) {
      const total = pos.scaleOnly + pos.offsetOnly + pos.mixed;
      if (total > 0) {
        const offsetPct = Math.round((100 * (pos.offsetOnly + pos.mixed)) / total);
        if (offsetPct >= 20)
          hygieneWarnings.push(`${offsetPct}% of Positions use Offset (Scale is safer across devices).`);
      }
    }
    const centeredFrac = raw?.layoutHygiene?.centeredAnchorFraction;
    if (typeof centeredFrac === "number" && centeredFrac < 0.5) {
      hygieneWarnings.push(`only ${Math.round(centeredFrac * 100)}% of elements use a centered (0.5,0.5) AnchorPoint.`);
    }

    return { styleClass, tokens, hygieneWarnings };
  }

  function describeUiStyle(raw: UiFingerprintRaw | undefined, classified: ReturnType<typeof classifyUiStyle>): string {
    const lines: string[] = [];
    lines.push(
      `ui_style_fingerprint: styleClass=${classified.styleClass} over ${raw?.objectCount ?? 0} GuiObjects under ${
        raw?.root ?? "?"
      }` + (raw?.truncated ? " (truncated at cap)" : "")
    );
    const t = classified.tokens;
    lines.push(
      `tokens: primary=${t.palettePrimary.join("/") || "none"} accent=${t.paletteAccent.join("/") || "none"} ` +
        `font=${t.fontPrimary ?? "unknown"}${t.fontSecondary ? "+" + t.fontSecondary : ""} corners=${t.cornerProfile} ` +
        `strokes=${t.strokeProfile ? `${t.strokeProfile.typicalThickness}px ${t.strokeProfile.color}` : "none"} ` +
        `gradients=${t.usesGradients} shadows=${t.usesShadows}`
    );
    if (classified.hygieneWarnings.length) lines.push(`hygiene: ${classified.hygieneWarnings.join(" ")}`);
    return lines.join("\n");
  }

  interface WorldProbeRaw {
    root?: string;
    sampled?: boolean;
    stride?: number;
    totalDescendants?: number;
    sampledCount?: number;
    partCount?: number;
    colors?: { hex: string; count: number }[];
    materials?: {
      top?: { material: string; count: number }[];
      neonFraction?: number;
      plasticFraction?: number;
      studLikeFraction?: number;
      variantTop?: { variant: string; count: number }[];
      partsWithVariantCount?: number;
    };
    size?: { avgMagnitude?: number; medianMagnitude?: number };
    transparentFraction?: number;
    meshCharacter?: { meshPartCount?: number; unionCount?: number; regularPartCount?: number };
    textureCount?: number;
    decalCount?: number;
    surfaceAppearanceCount?: number;
    juiceSignals?: { particleEmitterCount?: number; beamCount?: number; trailCount?: number };
    lights?: { pointLightCount?: number; spotLightCount?: number; surfaceLightCount?: number };
    terrain?: unknown;
  }

  interface WorldStyleDescription {
    paletteLine: string;
    materialCharacter: string;
    meshLine: string;
    juiceLine: string;
    summary: string;
  }

  // Shared by world_style_probe and art_direction_report.
  function describeWorldStyle(raw: WorldProbeRaw | undefined): WorldStyleDescription {
    const colors = raw?.colors ?? [];
    const swatches = colors
      .slice(0, 5)
      .map((c) => c.hex)
      .join(", ");
    const mat = raw?.materials;
    const neonFrac = mat?.neonFraction ?? 0;
    const plasticFrac = mat?.plasticFraction ?? 0;
    const studFrac = mat?.studLikeFraction ?? 0;

    let materialCharacter = "mixed materials";
    if (studFrac >= 0.3) materialCharacter = "classic studs via MaterialVariants";
    else if (neonFrac >= 0.3) materialCharacter = "neon-heavy and glowy";
    else if (plasticFrac >= 0.5) materialCharacter = "smooth plastic cartoon";

    const mesh = raw?.meshCharacter;
    const meshPart = mesh?.meshPartCount ?? 0;
    const regular = (mesh?.regularPartCount ?? 0) + (mesh?.unionCount ?? 0);
    let meshLine: string;
    if (meshPart > regular * 2 && meshPart > 0) {
      meshLine = "The world is mesh-driven (custom MeshParts dominate over primitive parts).";
    } else if (regular > meshPart * 2 && regular > 0) {
      meshLine = "The world is built from primitive parts/unions rather than custom meshes.";
    } else {
      meshLine = "The world mixes primitive parts and custom meshes.";
    }

    const juice = raw?.juiceSignals;
    const juiceTotal = (juice?.particleEmitterCount ?? 0) + (juice?.beamCount ?? 0) + (juice?.trailCount ?? 0);
    const juiceLine =
      juiceTotal > 0
        ? `World juice signals present: ${juice?.particleEmitterCount ?? 0} particle emitters, ${
            juice?.beamCount ?? 0
          } beams, ${juice?.trailCount ?? 0} trails.`
        : "No particle emitters, beams, or trails found -- the world may read as static.";

    const paletteLine = swatches ? `dominant palette ${swatches}` : "no dominant palette found";

    const summaryLines = [`world_style_probe: ${paletteLine}, ${materialCharacter}.`, meshLine, juiceLine];
    if (raw?.sampled) summaryLines.push(`(sampled: stride=${raw.stride} over ${raw.totalDescendants} descendants)`);
    if (raw?.terrain) summaryLines.push(`terrain: ${JSON.stringify(raw.terrain)}`);

    return { paletteLine, materialCharacter, meshLine, juiceLine, summary: summaryLines.join("\n") };
  }

  interface LightingProfileRaw {
    technology?: string;
    clockTime?: number;
    timeOfDay?: string;
    brightness?: number;
    ambient?: string;
    ambientLuminance?: number;
    outdoorAmbient?: string;
    outdoorAmbientLuminance?: number;
    colorShiftTop?: string;
    colorShiftBottom?: string;
    environmentDiffuseScale?: number;
    environmentSpecularScale?: number;
    globalShadows?: boolean;
    shadowSoftness?: number;
    exposureCompensation?: number;
    fog?: { fogStart?: number; fogEnd?: number; fogColor?: string };
    effects?: {
      atmosphere?: { density?: number; offset?: number; color?: string; decay?: string; glare?: number; haze?: number };
      sky?: { skyboxSet?: boolean; sunTextureSet?: boolean; starCount?: number };
      bloom?: { intensity?: number; size?: number; threshold?: number };
      colorCorrection?: { brightness?: number; contrast?: number; saturation?: number; tintColor?: string };
      depthOfField?: { focusDistance?: number; inFocusRadius?: number };
      sunRays?: { intensity?: number; spread?: number };
      blur?: { size?: number };
    };
  }

  // Shared by lighting_profile and art_direction_report.
  function classifyLightingMood(raw: LightingProfileRaw | undefined): { mood: string; note?: string } {
    const clockTime = typeof raw?.clockTime === "number" ? raw.clockTime : 14;
    const brightness = typeof raw?.brightness === "number" ? raw.brightness : 2;
    const ambientLum = typeof raw?.ambientLuminance === "number" ? raw.ambientLuminance : 0;
    const exposure = typeof raw?.exposureCompensation === "number" ? raw.exposureCompensation : 0;
    const atmosphereDensity = typeof raw?.effects?.atmosphere?.density === "number" ? raw.effects.atmosphere.density : 0;
    const saturation = typeof raw?.effects?.colorCorrection?.saturation === "number" ? raw.effects.colorCorrection.saturation : 0;
    const hasBloom = !!raw?.effects?.bloom;
    const hasColorCorrection = !!raw?.effects?.colorCorrection;
    const hasAtmosphere = !!raw?.effects?.atmosphere;

    const isNight = clockTime < 6 || clockTime > 20;
    const isDusk = (clockTime >= 17 && clockTime <= 20) || (clockTime >= 5 && clockTime < 7);

    const untouched =
      !hasAtmosphere &&
      !hasColorCorrection &&
      !hasBloom &&
      ambientLum < 0.05 &&
      Math.abs(exposure) < 0.05 &&
      brightness >= 1.5 &&
      brightness <= 2.5 &&
      !isNight &&
      !isDusk;

    if (untouched) {
      return { mood: "neutral-default", note: "lighting not art-directed yet -- still close to Studio defaults" };
    }
    if (isNight || (ambientLum < 0.1 && brightness < 1.5)) {
      return { mood: "dark-moody" };
    }
    if (isDusk || (ambientLum < 0.25 && (saturation < -0.1 || atmosphereDensity > 0.2))) {
      return { mood: "warm-cozy" };
    }
    if (saturation > 0.15 || hasBloom) {
      return { mood: "bright-bubbly" };
    }
    return { mood: "bright-clean" };
  }

  function describeLighting(raw: LightingProfileRaw | undefined, mood: { mood: string; note?: string }): string {
    const lines: string[] = [];
    lines.push(
      `lighting_profile: mood=${mood.mood}` +
        (mood.note ? ` (${mood.note})` : "") +
        ` clockTime=${raw?.clockTime ?? "?"} brightness=${raw?.brightness ?? "?"} technology=${raw?.technology ?? "unreadable"}`
    );
    const effectNames = Object.keys(raw?.effects ?? {});
    lines.push(effectNames.length ? `effects: ${effectNames.join(", ")}` : "effects: none");
    return lines.join("\n");
  }

  interface LayoutRect {
    path: string;
    rect: { x: number; y: number; w: number; h: number };
    [k: string]: unknown;
  }
  interface LayoutResolutionReport {
    resolution: { width: number; height: number; name: string };
    elementCount: number;
    truncated?: boolean;
    rootRects?: LayoutRect[];
    issues?: {
      offscreen?: LayoutRect[];
      overlaps?: { a: string; b: string; overlapRect: unknown }[];
      touchTargetTooSmall?: LayoutRect[];
      textLikelyClipped?: LayoutRect[];
      tinyText?: LayoutRect[];
    };
  }
  interface LayoutProbeRaw {
    root?: string;
    screenCount?: number;
    resolutions?: LayoutResolutionReport[];
    approximations?: string[];
  }

  function describeLayoutProbe(raw: LayoutProbeRaw | undefined): string {
    const lines: string[] = [];
    lines.push(`ui_layout_probe: root=${raw?.root ?? "?"} screens=${raw?.screenCount ?? 0}`);
    for (const res of raw?.resolutions ?? []) {
      const issues = res.issues ?? {};
      const counts = [
        `offscreen=${issues.offscreen?.length ?? 0}`,
        `overlaps=${issues.overlaps?.length ?? 0}`,
        `tinyTouch=${issues.touchTargetTooSmall?.length ?? 0}`,
        `clippedText=${issues.textLikelyClipped?.length ?? 0}`,
        `tinyText=${issues.tinyText?.length ?? 0}`,
      ].join(" ");
      lines.push(
        `${res.resolution.name} (${res.resolution.width}x${res.resolution.height}): ${res.elementCount} elements, ${counts}` +
          (res.truncated ? " [truncated]" : "")
      );
    }
    return lines.join("\n");
  }

  const DEFAULT_LAYOUT_RESOLUTIONS = [
    { width: 390, height: 844, name: "phone" },
    { width: 1024, height: 768, name: "tablet" },
    { width: 1920, height: 1080, name: "desktop" },
  ];

  server.registerTool(
    "ui_style_fingerprint",
    {
      title: "UI Style Fingerprint",
      description:
        "Walks GuiObjects under root (default StarterGui, cap 5000) and fingerprints the UI's art " +
        "style: fonts (FontFace family + TextScaled/fixed TextSize distribution), UICorner radius " +
        "buckets (sharp/rounded/pill), UIStroke thickness/color/ApplyStrokeMode, UIGradient color " +
        "pairs, a quantized color histogram (background/text/image, top 12), a shadow-name heuristic, " +
        "layout hygiene (Size/Position UDim2 scale-vs-offset usage, UIPadding/UIListLayout/" +
        "UIGridLayout/UIAspectRatioConstraint counts, centered-anchor fraction), and distinct image " +
        "asset ids (cap 40). Node classifies a styleClass (flat/rounded-soft/bubbly/pill-heavy/mixed/" +
        "skeuo-textured) and a reusable token set (palette, fonts, corner/stroke profile) on top of " +
        "the raw scan. Read-only.",
      inputSchema: { root: z.string().optional(), context: contextArg },
    },
    async ({ root, context }) => {
      const reason = gateToolCall("ui_style_fingerprint");
      if (reason) return blocked(reason);
      const r = await enqueueAndAwait("ui_style_fingerprint", chooseContext(context), { root }, STYLE_STEP_TIMEOUT_MS);
      if (!r.ok) return blocked(r.error ?? (r as { err?: string }).err ?? "ui_style_fingerprint failed");
      const raw = r.result as UiFingerprintRaw;
      const classified = classifyUiStyle(raw);
      const text = describeUiStyle(raw, classified);
      return {
        content: [
          { type: "text" as const, text },
          {
            type: "text" as const,
            text: JSON.stringify({ ...raw, styleClass: classified.styleClass, tokens: classified.tokens }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "world_style_probe",
    {
      title: "World Style Probe",
      description:
        "Walks workspace descendants (default root: workspace; stride-sampled above sampleCap, " +
        "default 50000) and fingerprints the 3D world's art style: a quantized Color histogram (top " +
        "16), Material counts (top 12) plus neon/plastic/stud-like fractions (stud-like = " +
        "MaterialVariant name containing 'Stud'), avg/median part size, transparency fraction, " +
        "MeshPart vs Part vs UnionOperation counts, Texture/Decal/SurfaceAppearance counts, " +
        "juice signals (ParticleEmitter/Beam/Trail counts), light counts (Point/Spot/Surface), and a " +
        "cheap (non-voxel) Terrain presence check. Node classifies a materials character (e.g. " +
        "'classic studs via MaterialVariants' / 'neon-heavy and glowy' / 'smooth plastic cartoon') and " +
        "a mesh-vs-part character. Read-only.",
      inputSchema: {
        root: z.string().optional(),
        sampleCap: z.number().int().min(1000).max(500000).default(50000),
        context: contextArg,
      },
    },
    async ({ root, sampleCap, context }) => {
      const reason = gateToolCall("world_style_probe");
      if (reason) return blocked(reason);
      const r = await enqueueAndAwait(
        "world_style_probe",
        chooseContext(context),
        { root, sampleCap },
        STYLE_STEP_TIMEOUT_MS
      );
      if (!r.ok) return blocked(r.error ?? (r as { err?: string }).err ?? "world_style_probe failed");
      const raw = r.result as WorldProbeRaw;
      const desc = describeWorldStyle(raw);
      return {
        content: [
          { type: "text" as const, text: desc.summary },
          { type: "text" as const, text: JSON.stringify(raw, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    "lighting_profile",
    {
      title: "Lighting Profile",
      description:
        "Reads Lighting's mood-defining properties (Technology [pcall-guarded, RobloxScriptSecurity], " +
        "ClockTime/TimeOfDay, Brightness, Ambient/OutdoorAmbient [+ luminance], ColorShift_Top/Bottom, " +
        "EnvironmentDiffuse/SpecularScale, GlobalShadows, ShadowSoftness, ExposureCompensation, Fog) " +
        "plus any Atmosphere/Sky/BloomEffect/ColorCorrectionEffect/DepthOfFieldEffect/SunRaysEffect/" +
        "BlurEffect children (presence + key values). Node classifies a mood label (bright-clean/" +
        "bright-bubbly/warm-cozy/dark-moody/neutral-default -- the last flags lighting that still " +
        "looks like untouched Studio defaults). Always edit context (Lighting is a single service). " +
        "Read-only.",
      inputSchema: {},
    },
    async () => {
      const reason = gateToolCall("lighting_profile");
      if (reason) return blocked(reason);
      const r = await enqueueAndAwait("lighting_profile", "edit", {}, STYLE_STEP_TIMEOUT_MS);
      if (!r.ok) return blocked(r.error ?? (r as { err?: string }).err ?? "lighting_profile failed");
      const raw = r.result as LightingProfileRaw;
      const mood = classifyLightingMood(raw);
      const text = describeLighting(raw, mood);
      return {
        content: [
          { type: "text" as const, text },
          { type: "text" as const, text: JSON.stringify({ ...raw, mood: mood.mood, moodNote: mood.note }, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    "ui_layout_probe",
    {
      title: "UI Layout Probe",
      description:
        "Pure-math layout solver (no rendering, no viewport capture): resolves the absolute rect of " +
        "every GuiObject under root (a ScreenGui path, or default all ScreenGuis under StarterGui) at " +
        "each given resolution (default phone 390x844 / tablet 1024x768 / desktop 1920x1080), applying " +
        "UDim2 Size/Position + AnchorPoint, UISizeConstraint, an approximate UIAspectRatioConstraint, " +
        "SizeConstraint (RelativeXX/RelativeYY), UIPadding, UIListLayout, and an approximate " +
        "UIGridLayout, minus a fixed 58px ScreenGui top inset when IgnoreGuiInset is false. Cap 3000 " +
        "GuiObjects/resolution. Reports per resolution: offscreen elements (>8px outside the " +
        "viewport), sibling AABB overlaps among visible non-layout children (cap 30 pairs), " +
        "touchTargetTooSmall (ImageButton/TextButton under 36px, phone resolution only), " +
        "textLikelyClipped (fixed TextSize taller than its rect, not wrapped), tinyText (fixed " +
        "TextSize <12px, phone only), plus rootRects (the ScreenGui's direct children) and an explicit " +
        "`approximations` list of every simplification made (no UIFlex, no text/RichText measurement, " +
        "AutomaticSize unmeasured, fixed inset, layout approximations, no rotation). Read-only.",
      inputSchema: {
        root: z.string().optional(),
        resolutions: z
          .array(z.object({ width: z.number().int().positive(), height: z.number().int().positive(), name: z.string() }))
          .optional(),
        context: contextArg,
      },
    },
    async ({ root, resolutions, context }) => {
      const reason = gateToolCall("ui_layout_probe");
      if (reason) return blocked(reason);
      const res = resolutions && resolutions.length ? resolutions : DEFAULT_LAYOUT_RESOLUTIONS;
      const r = await enqueueAndAwait(
        "ui_layout_probe",
        chooseContext(context),
        { root, resolutions: res },
        STYLE_STEP_TIMEOUT_MS
      );
      if (!r.ok) return blocked(r.error ?? (r as { err?: string }).err ?? "ui_layout_probe failed");
      const raw = r.result as LayoutProbeRaw;
      const text = describeLayoutProbe(raw);
      return {
        content: [
          { type: "text" as const, text },
          { type: "text" as const, text: JSON.stringify(raw, null, 2) },
        ],
      };
    }
  );

  function buildArtDirectionBrief(input: {
    ui?: UiFingerprintRaw;
    uiClassified?: ReturnType<typeof classifyUiStyle>;
    world?: WorldProbeRaw;
    worldDesc?: WorldStyleDescription;
    lighting?: LightingProfileRaw;
    lightingMood?: { mood: string; note?: string };
  }): string {
    const opening: string[] = [];
    if (input.worldDesc) {
      opening.push(`${input.worldDesc.paletteLine}, ${input.worldDesc.materialCharacter}`);
    }
    if (input.lightingMood) {
      opening.push(`lit ${input.lightingMood.mood.replace(/-/g, " ")}`);
    }
    if (input.uiClassified) {
      opening.push(`UI reads ${input.uiClassified.styleClass.replace(/-/g, " ")}`);
    }

    let text = "";
    if (opening.length) {
      text += `This game's art direction: ${opening.join("; ")}. `;
    }
    if (input.worldDesc) {
      text += `${input.worldDesc.meshLine} ${input.worldDesc.juiceLine} `;
    }
    if (input.lightingMood?.note) {
      text += `${input.lightingMood.note}. `;
    }
    if (input.uiClassified) {
      const t = input.uiClassified.tokens;
      text +=
        `The UI's reusable token set: primary palette ${t.palettePrimary.join("/") || "none found"}, accent ` +
        `${t.paletteAccent.join("/") || "none found"}, font ${t.fontPrimary ?? "unknown"}` +
        (t.fontSecondary ? ` (+ ${t.fontSecondary})` : "") +
        `, ${t.cornerProfile} corners, ${t.usesGradients ? "gradients in use" : "flat fills, no gradients"}, ` +
        `${t.usesShadows ? "drop shadows present" : "no shadow layer detected"}. `;
      if (input.uiClassified.hygieneWarnings.length) {
        text += `${input.uiClassified.hygieneWarnings.join(" ")} `;
      }
    }

    const doList: string[] = [];
    const dontList: string[] = [];
    if (input.uiClassified) {
      const t = input.uiClassified.tokens;
      doList.push(
        `use ${t.cornerProfile} corners` +
          (t.strokeProfile ? ` + ${t.strokeProfile.typicalThickness}px strokes in ${t.strokeProfile.color}` : "")
      );
      if (t.usesGradients) doList.push("keep using subtle gradients for depth");
      else dontList.push("introduce gradients -- this game uses flat fills");
      if (t.usesShadows) doList.push("keep drop shadows under raised UI elements");
      else dontList.push("add heavy drop shadows -- none exist today");
      if (t.palettePrimary.length) doList.push(`stick to the established palette (${t.palettePrimary.join(", ")})`);
    }
    if (input.worldDesc) {
      doList.push(`match new props/materials to ${input.worldDesc.materialCharacter}`);
    }
    if (input.lightingMood) {
      doList.push(`keep new lighting consistent with the ${input.lightingMood.mood.replace(/-/g, " ")} mood`);
    }

    let brief = text.trim();
    if (doList.length) brief += `\n\nDO: ${doList.join("; ")}.`;
    if (dontList.length) brief += `\nDONT: ${dontList.join("; ")}.`;
    return brief;
  }

  server.registerTool(
    "art_direction_report",
    {
      title: "Art Direction Report",
      description:
        "Node composite, zero new plugin code: re-runs ui_style_fingerprint, world_style_probe, and " +
        "lighting_profile directly (skippable via `include`: ui/world/lighting, default all three), " +
        "classifies each with the exact same rule trees the standalone tools use, then writes ONE " +
        "natural-language art direction brief (~150-250 words) an agent can read before building " +
        "anything in this game -- overall direction (world palette + materials + lighting mood + UI " +
        "style class), the UI token set to reuse, and explicit DO/DONT bullets -- followed by the full " +
        "JSON of all three raw payloads. A step that errors is recorded under errors{} without failing " +
        "the whole report. The flagship deliverable of the style bucket. Read-only.",
      inputSchema: { include: z.array(z.enum(["ui", "world", "lighting"])).optional() },
    },
    async ({ include }) => {
      const reason = gateToolCall("art_direction_report");
      if (reason) return blocked(reason);
      const want = new Set(include && include.length ? include : ["ui", "world", "lighting"]);

      const parts: Record<string, unknown> = {};
      const errors: Record<string, string> = {};
      let uiClassified: ReturnType<typeof classifyUiStyle> | undefined;
      let worldDesc: WorldStyleDescription | undefined;
      let lightingMood: { mood: string; note?: string } | undefined;

      if (want.has("ui")) {
        const r = await enqueueAndAwait("ui_style_fingerprint", "edit", {}, STYLE_STEP_TIMEOUT_MS);
        if (r.ok) {
          parts.ui = r.result;
          uiClassified = classifyUiStyle(r.result as UiFingerprintRaw);
        } else {
          errors.ui = r.error ?? (r as { err?: string }).err ?? "ui_style_fingerprint failed";
        }
      }
      if (want.has("world")) {
        const r = await enqueueAndAwait("world_style_probe", "edit", { sampleCap: 50000 }, STYLE_STEP_TIMEOUT_MS);
        if (r.ok) {
          parts.world = r.result;
          worldDesc = describeWorldStyle(r.result as WorldProbeRaw);
        } else {
          errors.world = r.error ?? (r as { err?: string }).err ?? "world_style_probe failed";
        }
      }
      if (want.has("lighting")) {
        const r = await enqueueAndAwait("lighting_profile", "edit", {}, STYLE_STEP_TIMEOUT_MS);
        if (r.ok) {
          parts.lighting = r.result;
          lightingMood = classifyLightingMood(r.result as LightingProfileRaw);
        } else {
          errors.lighting = r.error ?? (r as { err?: string }).err ?? "lighting_profile failed";
        }
      }

      const brief = buildArtDirectionBrief({
        ui: parts.ui as UiFingerprintRaw | undefined,
        uiClassified,
        world: parts.world as WorldProbeRaw | undefined,
        worldDesc,
        lighting: parts.lighting as LightingProfileRaw | undefined,
        lightingMood,
      });

      const lines = [brief];
      if (Object.keys(errors).length) lines.push(`(errors: ${JSON.stringify(errors)})`);

      return {
        content: [
          { type: "text" as const, text: lines.join("\n\n") },
          {
            type: "text" as const,
            text: JSON.stringify({ ...parts, errors: Object.keys(errors).length ? errors : undefined }, null, 2),
          },
        ],
      };
    }
  );

  // ----- Bucket 4: QoL (lint gate / smoke test / snapshot-revert / multiplayer) -
  // luau_lint_gate reuses the exact luau-lsp pipeline analyze_script uses (factored
  // out here as fetchScriptSource/analyzeSource -- analyze_script itself is
  // refactored just below to call these instead of duplicating the logic).
  // 60s timeout floor, same reasoning as Bucket 2/3's DIGEST_STEP_TIMEOUT_MS /
  // STYLE_STEP_TIMEOUT_MS: scanning many scripts or a large build subtree can
  // outrun the 30s default.
  const QOL_STEP_TIMEOUT_MS = Math.max(cfg.commandTimeoutMs, 60000);

  async function fetchScriptSource(
    path: string,
    ctx: Context
  ): Promise<{ ok: true; source: string } | { ok: false; error: string }> {
    const r = await enqueueAndAwait("get_script_source", ctx, { path }, QOL_STEP_TIMEOUT_MS);
    if (!r.ok) {
      return { ok: false, error: r.error ?? (r as { err?: string }).err ?? "get_script_source failed" };
    }
    const src = (r.result as { source?: unknown } | undefined)?.source;
    if (typeof src !== "string") {
      return { ok: false, error: "get_script_source returned no source text" };
    }
    return { ok: true, source: src };
  }

  async function analyzeSource(code: string) {
    startLuauGate({ luauLspPath: cfg.luauLspPath });
    await luauGateReady(3000);
    return analyzeLuau(code);
  }

  server.registerTool(
    "luau_lint_gate",
    {
      title: "Luau Lint Gate",
      description:
        "Read-only CI-style lint gate. Runs the SAME luau-lsp analyze pipeline as " +
        "analyze_script over a set of scripts and reports one pass/fail verdict. Provide " +
        "exactly one of: paths (explicit script paths) or root (lints every Script/" +
        "LocalScript/ModuleScript under it, via list_scripts). failOn='error' (default) fails " +
        "only on blocking diagnostics (SyntaxError/TypeError); failOn='warning' fails on any " +
        "lint warning too. Capped at 100 scripts (truncated flag) and 10 diagnostics per " +
        "script. Always scans the edit-context place.",
      inputSchema: {
        paths: z.array(z.string()).optional(),
        root: z.string().optional(),
        failOn: z.enum(["error", "warning"]).default("error"),
      },
    },
    async ({ paths, root, failOn }) => {
      const reason = gateToolCall("luau_lint_gate");
      if (reason) return blocked(reason);
      if (!!paths === !!root) {
        return blocked("provide exactly one of paths or root");
      }

      let targets: string[];
      if (paths) {
        targets = paths;
      } else {
        const r = await enqueueAndAwait("list_scripts", "edit", { root }, QOL_STEP_TIMEOUT_MS);
        if (!r.ok) {
          return blocked(r.error ?? (r as { err?: string }).err ?? "list_scripts failed");
        }
        const list = (r.result as { path?: unknown }[] | undefined) ?? [];
        targets = list.map((e) => String(e.path ?? "")).filter(Boolean);
      }

      const SCRIPT_CAP = 100;
      const truncated = targets.length > SCRIPT_CAP;
      if (truncated) targets = targets.slice(0, SCRIPT_CAP);

      const scripts: {
        path: string;
        errors: number;
        warnings: number;
        firstDiagnostics: Diagnostic[];
        error?: string;
      }[] = [];
      let totalErrors = 0;
      let totalWarnings = 0;

      for (const path of targets) {
        const src = await fetchScriptSource(path, "edit");
        if (!src.ok) {
          scripts.push({ path, errors: 0, warnings: 0, firstDiagnostics: [], error: src.error });
          continue;
        }
        const res = await analyzeSource(src.source);
        if (!res.available) {
          scripts.push({
            path,
            errors: 0,
            warnings: 0,
            firstDiagnostics: [],
            error: "luau analyzer not available (binary/definitions missing or still downloading)",
          });
          continue;
        }
        totalErrors += res.errors.length;
        totalWarnings += res.warnings.length;
        scripts.push({
          path,
          errors: res.errors.length,
          warnings: res.warnings.length,
          firstDiagnostics: [...res.errors, ...res.warnings].slice(0, 10),
        });
      }

      const verdictPass = failOn === "warning" ? totalErrors === 0 && totalWarnings === 0 : totalErrors === 0;
      const summary =
        `LINT GATE: ${verdictPass ? "PASS" : "FAIL"} -- ${totalErrors} error(s), ${totalWarnings} ` +
        `warning(s) across ${targets.length} script(s)` +
        (truncated ? ` (truncated to first ${SCRIPT_CAP})` : "");
      const details = {
        verdict: verdictPass ? "pass" : "fail",
        failOn,
        scriptCount: targets.length,
        truncated,
        totalErrors,
        totalWarnings,
        scripts,
      };
      return {
        content: [
          { type: "text" as const, text: summary },
          { type: "text" as const, text: JSON.stringify(details, null, 2) },
        ],
      };
    }
  );

  interface SmokeStepResult {
    index: number;
    description?: string;
    ok: boolean;
    value?: unknown;
    error?: string;
    ms: number;
  }

  // Luau truthiness (not JS): only `false`/`nil` are falsy -- 0 and "" are truthy,
  // matching what a Luau dev writing the step script would expect.
  function luauTruthy(v: unknown): boolean {
    return v !== false && v !== null && v !== undefined;
  }

  async function runPlaytestSmoke(input: {
    steps: { luau: string; description?: string; expectTruthy: boolean; timeoutMs?: number }[];
    setupLuau?: string;
    numPlayers?: number;
    stopAfter: boolean;
    collectOutput: boolean;
  }): Promise<{
    passed: boolean;
    stepsPassed: number;
    stepsTotal: number;
    results: SmokeStepResult[];
    setupError?: string;
    serverErrors: string[];
    outputTail: string[];
    durationSec: number;
    stopped: boolean;
  }> {
    const startedAt = Date.now();
    const results: SmokeStepResult[] = [];
    const serverErrors: string[] = [];
    const outputTail: string[] = [];
    let setupError: string | undefined;
    let weStarted = false;
    let stopped = false;

    // Same reasoning as verify_playtest's step 1: a bail-out here must never
    // touch a playtest someone else already has running.
    let alreadyRunning = isAlive("server");
    if (!alreadyRunning) {
      try {
        const r = await enqueueAndAwait("get_playtest_status", "edit", {}, 5000);
        if (r.ok && r.result && typeof r.result === "object") {
          alreadyRunning = (r.result as { running?: boolean }).running === true;
        }
      } catch {
        // degraded status -- assume not running
      }
    }
    if (alreadyRunning) {
      return {
        passed: false,
        stepsPassed: 0,
        stepsTotal: input.steps.length,
        results: [],
        setupError: "playtest already running; stop it or run steps against it manually",
        serverErrors: [],
        outputTail: [],
        durationSec: 0,
        stopped: false,
      };
    }

    async function body(): Promise<void> {
      const startRes = await enqueueAndAwait(
        "playtest_control",
        "edit",
        { action: "start", mode: "run", numPlayers: input.numPlayers },
        QOL_STEP_TIMEOUT_MS
      );
      if (!startRes.ok) {
        setupError = startRes.error ?? "playtest_control start failed";
        return;
      }
      weStarted = true;

      const connectDeadline = Date.now() + 20000;
      while (!isAlive("server") && Date.now() < connectDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!isAlive("server")) {
        setupError = "agent never connected (check Allow HTTP Requests)";
        return;
      }

      if (input.setupLuau) {
        try {
          const r = await enqueueAndAwait("run_luau", "server", { code: input.setupLuau }, QOL_STEP_TIMEOUT_MS);
          if (!r.ok) setupError = r.error ?? "setupLuau failed";
        } catch (e) {
          setupError = e instanceof Error ? e.message : String(e);
        }
      }

      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i];
        const t0 = Date.now();
        try {
          const r = await enqueueAndAwait(
            "run_luau",
            "server",
            { code: step.luau },
            step.timeoutMs ?? QOL_STEP_TIMEOUT_MS
          );
          const ms = Date.now() - t0;
          if (!r.ok) {
            results.push({ index: i, description: step.description, ok: false, error: r.error ?? "run_luau failed", ms });
            break; // first failure aborts remaining steps
          }
          const ok = step.expectTruthy ? luauTruthy(r.result) : true;
          results.push({
            index: i,
            description: step.description,
            ok,
            value: r.result,
            error: ok ? undefined : `expected truthy, got ${JSON.stringify(r.result)}`,
            ms,
          });
          if (!ok) break;
        } catch (e) {
          results.push({
            index: i,
            description: step.description,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            ms: Date.now() - t0,
          });
          break;
        }
      }

      if (input.collectOutput) {
        try {
          const r = await enqueueAndAwait("get_playtest_output", "server", { drain: true }, QOL_STEP_TIMEOUT_MS);
          if (r.ok && r.result && typeof r.result === "object") {
            const lines = (r.result as { lines?: unknown }).lines;
            if (Array.isArray(lines)) {
              for (const l of lines) {
                const o = (l ?? {}) as Record<string, unknown>;
                const level = String(o.level ?? "");
                const text = String(o.text ?? "");
                if (level.includes("Error") || level.includes("Warning")) serverErrors.push(text);
                outputTail.push(`[${level}] ${text}`);
              }
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
      setupError = setupError ?? (e instanceof Error ? e.message : String(e));
    } finally {
      if (weStarted && input.stopAfter) {
        try {
          const stopRes = await stopPlaytest({ action: "stop", mode: "run" });
          stopped = !(stopRes as { isError?: boolean }).isError;
        } catch {
          stopped = false;
        }
      }
    }

    const stepsPassed = results.filter((r) => r.ok).length;
    const passed = !setupError && results.length === input.steps.length && stepsPassed === input.steps.length;
    return {
      passed,
      stepsPassed,
      stepsTotal: input.steps.length,
      results,
      setupError,
      serverErrors,
      outputTail: outputTail.slice(-200),
      durationSec: Math.round((Date.now() - startedAt) / 1000),
      stopped,
    };
  }

  server.registerTool(
    "playtest_smoke",
    {
      title: "Playtest Smoke",
      description:
        "Composite: generalizes verify_playtest into an ordered smoke-test script. Starts a " +
        "Run-mode playtest, waits for the server agent, runs an optional setupLuau once (best-" +
        "effort), then runs each step's `luau` IN ORDER in the F5 SERVER context via the same " +
        "mechanism run_luau uses. By default (expectTruthy:true) a falsy Luau return (false/nil) " +
        "fails the step; pass expectTruthy:false for a step you only want to execute without " +
        "erroring. The FIRST failed step aborts all remaining steps (no continue-on-failure), " +
        "but the playtest is still stopped (unless stopAfter:false) and output still drained " +
        "(unless collectOutput:false). numPlayers is passed through to playtest_control's start " +
        "payload (mirroring its contract) -- mainly meaningful for play-mode starts, which this " +
        "tool does not use (steps only need the server context). Every step's source is checked " +
        "Node-side with luau-lsp analyze first, same as run_luau.",
      inputSchema: {
        steps: z
          .array(
            z.object({
              luau: z.string(),
              description: z.string().optional(),
              expectTruthy: z.boolean().default(true),
              timeoutMs: z.number().int().min(1).optional(),
            })
          )
          .min(1),
        setupLuau: z.string().optional(),
        numPlayers: z.number().int().min(1).max(8).optional(),
        stopAfter: z.boolean().default(true),
        collectOutput: z.boolean().default(true),
        skipAnalysis: z.boolean().default(false),
      },
    },
    async (input) => {
      const reason = gateToolCall("playtest_smoke");
      if (reason) return blocked(reason);
      if (input.setupLuau) {
        const g = await gateLuau(input.setupLuau, input.skipAnalysis, "playtest_smoke setupLuau");
        if (g.block) return g.block;
      }
      for (let i = 0; i < input.steps.length; i++) {
        const g = await gateLuau(input.steps[i].luau, input.skipAnalysis, `playtest_smoke step #${i + 1}`);
        if (g.block) return g.block;
      }
      const output = await runPlaytestSmoke(input);
      const firstFail = output.results.find((r) => !r.ok);
      const summary = output.passed
        ? `SMOKE: ${output.stepsPassed}/${output.stepsTotal} steps passed`
        : `SMOKE: ${output.stepsPassed}/${output.stepsTotal} steps passed, failed at #${
            firstFail ? firstFail.index + 1 : output.results.length + 1
          }: ${firstFail?.error ?? output.setupError ?? "unknown failure"}`;
      return {
        content: [
          { type: "text" as const, text: summary },
          { type: "text" as const, text: JSON.stringify(output, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    "snapshot_revert",
    {
      title: "Snapshot / Diff / Revert",
      description:
        "Composite over export_build/import_build: snapshot a subtree now, diff it against a " +
        "later snapshot, or revert it back to what was snapshotted. In-memory only (this Node " +
        "process' lifetime), LRU-capped at 6 labels -- not persisted to disk or across restarts. " +
        "mode='snapshot' (needs path): export_build's path and stores it under label. " +
        "mode='diff' (needs label): re-exports the same path and reports addedInstances/" +
        "removedInstances/changedInstances (matched by relative name-path within the subtree; " +
        "cap 200 entries total, 20 changed props per instance). mode='revert' (needs label): " +
        "DESTRUCTIVE -- deletes the CURRENT instance at the snapshotted path, then reimports the " +
        "stored build under its recorded parent. If import fails after the delete, the label is " +
        "NOT dropped (retry mode='revert' with the same label) and the failure says so loudly. " +
        "Refuses to revert a bare top-level path (e.g. 'Workspace' or 'game', no parent segment) " +
        "to avoid nuking a service or the DataModel itself. mode='list': stored labels + path/" +
        "takenAt/instanceCount.",
      inputSchema: {
        mode: z.enum(["snapshot", "diff", "revert", "list"]),
        label: z.string().optional(),
        path: z.string().optional(),
        maxDepth: z.number().int().min(1).max(20).default(8),
      },
    },
    async ({ mode, label, path, maxDepth }) => {
      const reason = gateToolCall("snapshot_revert");
      if (reason) return blocked(reason);

      if (mode === "list") {
        const items = Array.from(snapshotStore.values()).map((s) => ({
          label: s.label,
          path: s.path,
          takenAt: s.takenAt,
          instanceCount: countBuildInstances(s.build),
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ count: items.length, cap: SNAPSHOT_CAP, snapshots: items }, null, 2),
            },
          ],
        };
      }

      if (!label) return blocked(`mode='${mode}' requires 'label'`);

      if (mode === "snapshot") {
        if (!path) return blocked("mode='snapshot' requires 'path'");
        const r = await enqueueAndAwait("export_build", "edit", { path, maxDepth }, QOL_STEP_TIMEOUT_MS);
        if (!r.ok) {
          return blocked(r.error ?? (r as { err?: string }).err ?? "export_build failed");
        }
        const { parentPath, name } = splitPath(path);
        const snap: BuildSnapshot = { label, path, parentPath, name, build: r.result, takenAt: new Date().toISOString() };
        storeSnapshot(label, snap);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `snapshot '${label}' taken at ${path} (${countBuildInstances(snap.build)} instance(s), ` +
                `${snapshotStore.size}/${SNAPSHOT_CAP} slots used)`,
            },
          ],
        };
      }

      const existing = snapshotStore.get(label);
      if (!existing) {
        return blocked(`no snapshot stored under label '${label}' (use mode='list' to see what's stored)`);
      }

      if (mode === "diff") {
        const r = await enqueueAndAwait("export_build", "edit", { path: existing.path, maxDepth }, QOL_STEP_TIMEOUT_MS);
        if (!r.ok) {
          return blocked(r.error ?? (r as { err?: string }).err ?? "export_build failed (path may no longer exist)");
        }
        const diff = diffBuildTrees(existing.build, r.result);
        const summary =
          `DIFF '${label}' @ ${existing.path}: +${diff.addedInstances.length} added, ` +
          `-${diff.removedInstances.length} removed, ~${diff.changedInstances.length} changed` +
          (diff.truncated ? " (truncated)" : "");
        return {
          content: [
            { type: "text" as const, text: summary },
            { type: "text" as const, text: JSON.stringify(diff, null, 2) },
          ],
        };
      }

      // mode === "revert"
      if (!existing.parentPath) {
        return blocked(
          `snapshot_revert: refusing to revert '${existing.path}' -- it has no parent segment ` +
            "(a top-level service or the DataModel itself); snapshot/revert a subtree instead"
        );
      }
      const delRes = await enqueueAndAwait("delete_instance", "edit", { path: existing.path }, QOL_STEP_TIMEOUT_MS);
      if (!delRes.ok) {
        return blocked(
          `revert '${label}': delete_instance failed (${delRes.error ?? "unknown error"}); ` +
            "snapshot NOT dropped, retry once the path issue is resolved"
        );
      }
      const impRes = await enqueueAndAwait(
        "import_build",
        "edit",
        { build: existing.build, parentPath: existing.parentPath, name: existing.name },
        QOL_STEP_TIMEOUT_MS
      );
      if (!impRes.ok) {
        return blocked(
          `revert '${label}': DELETED ${existing.path} but import_build failed ` +
            `(${impRes.error ?? "unknown error"}). The snapshot is still stored under '${label}' -- ` +
            "retry mode='revert' with the same label once the import issue is fixed."
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `reverted '${label}': restored ${existing.path} from the snapshot taken ${existing.takenAt}`,
          },
        ],
      };
    }
  );

  // multiplayer_eval feasibility verdict (investigated RuntimeAgentSource.luau +
  // ClientAgentSource.luau end-to-end before writing this):
  // (a) serverLuau: RuntimeAgentSource's run_luau branch runs arbitrary code in
  //     the F5 server DataModel, which can trivially enumerate every connected
  //     peer server-side (Players:GetPlayers()). Fully supported today, no new
  //     plugin code -- same mechanism run_luau context='server' already uses.
  // (b) clientQuery targeting a SPECIFIC peer: NOT supported. RuntimeAgentSource
  //     hard-binds the relay to `boundPlayer = Players:GetPlayers()[1]` and
  //     silently drops any OnServerEvent fire from a different player ("forged
  //     event from a non-bound client -- ignore") -- an anti-forgery measure,
  //     not an oversight, so any other client's LocalScript can't poison an
  //     in-flight query. client_query's own dispatch also hardcodes
  //     Players:GetPlayers()[1] as the FireClient target. Rearchitecting that
  //     binding to trust multiple named peers would weaken the exact guarantee
  //     it exists for, so this is registered honest-unsupported for allPeers/
  //     playerName rather than silently ignoring them or smuggling in per-peer
  //     targeting -- same decision rule as ui_capture/playtest_gif.
  server.registerTool(
    "multiplayer_eval",
    {
      title: "Multiplayer Eval",
      description:
        "Hybrid multiplayer introspection. serverLuau runs arbitrary code in the F5 SERVER " +
        "context (same mechanism as run_luau context='server') -- this sees EVERY connected " +
        "peer via Players:GetPlayers(), so per-peer SERVER-side state (leaderstats, position, " +
        "team, etc.) for all peers is fully available. clientQuery routes one of the existing " +
        "fixed queries (fps/camera/gui_tree/local_player/ping) to the F5 client, but the client " +
        "relay (RuntimeAgentSource.luau) hard-binds to a SINGLE player as an anti-forgery " +
        "measure -- allPeers:true or clientQuery.playerName are honored ONLY by being honestly " +
        "rejected: this tool does NOT add arbitrary client eval or true multi-client targeting " +
        "(a deliberate security boundary). Provide at least one of serverLuau/clientQuery.",
      inputSchema: {
        serverLuau: z.string().optional(),
        clientQuery: z
          .object({
            name: z.enum(["fps", "camera", "gui_tree", "local_player", "ping"]),
            args: objectArg().optional(),
            playerName: z.string().optional(),
          })
          .optional(),
        allPeers: z.boolean().default(false),
        skipAnalysis: z.boolean().default(false),
      },
    },
    async ({ serverLuau, clientQuery, allPeers, skipAnalysis }) => {
      const reason = gateToolCall("multiplayer_eval");
      if (reason) return blocked(reason);
      if (!serverLuau && !clientQuery) {
        return blocked("provide at least one of serverLuau or clientQuery");
      }

      const result: Record<string, unknown> = {};
      const errors: Record<string, string> = {};

      if (serverLuau) {
        const g = await gateLuau(serverLuau, skipAnalysis, "multiplayer_eval serverLuau");
        if (g.block) return g.block;
        const r = await enqueueAndAwait("run_luau", "server", { code: serverLuau }, QOL_STEP_TIMEOUT_MS);
        if (r.ok) result.serverLuau = { output: r.output, result: r.result };
        else errors.serverLuau = r.error ?? (r as { err?: string }).err ?? "run_luau failed";
      }

      if (clientQuery) {
        if (allPeers) {
          errors.clientQuery =
            "unsupported: allPeers requests multi-client targeting, but the F5 client relay " +
            "hard-binds to a single player (Players:GetPlayers()[1]) as an anti-forgery measure " +
            "-- only the one connected client can ever be queried";
        } else if (clientQuery.playerName) {
          errors.clientQuery =
            `unsupported: cannot target playerName='${clientQuery.playerName}' -- the F5 client ` +
            "relay hard-binds to a single player (Players:GetPlayers()[1]); use serverLuau + " +
            "Players:GetPlayers() to inspect a specific peer's SERVER-side state instead";
        } else if (!isAlive("server")) {
          errors.clientQuery = "client_query requires a running F5 play-mode playtest (agent not connected)";
        } else {
          const r = await enqueueAndAwait(
            "client_query",
            "server",
            { name: clientQuery.name, args: clientQuery.args },
            8000
          );
          if (r.ok) result.clientQuery = r.result;
          else errors.clientQuery = r.error ?? (r as { err?: string }).err ?? "client_query failed";
        }
      }

      const lines: string[] = [];
      if (result.serverLuau !== undefined) lines.push("serverLuau: ok");
      if (errors.serverLuau) lines.push(`serverLuau: FAILED (${errors.serverLuau})`);
      if (result.clientQuery !== undefined) lines.push("clientQuery: ok");
      if (errors.clientQuery) lines.push(`clientQuery: ${errors.clientQuery}`);

      return {
        content: [
          { type: "text" as const, text: lines.join("\n") || "(no operation performed)" },
          {
            type: "text" as const,
            text: JSON.stringify({ result, errors: Object.keys(errors).length ? errors : undefined }, null, 2),
          },
        ],
      };
    }
  );

  // ----- meta (ungated) -----------------------------------------------------
  // task 24: Node-local Luau analysis. The source variant never touches the
  // bridge; the path variant round-trips once for get_script_source (now via
  // the shared fetchScriptSource/analyzeSource helpers -- see Bucket 4 above).
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
        const r = await fetchScriptSource(path, chooseContext("auto"));
        if (!r.ok) return blocked(r.error);
        code = r.source;
      }
      const res = await analyzeSource(code as string);
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
