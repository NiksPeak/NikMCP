import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// config.json was read/written CWD-relative, which silently dropped the entire
// file whenever the server was spawned from somewhere other than the repo (an
// MCP client sets cwd to the user's project dir) -- the port fell back to the
// default and rocreate.apiKey read as "not configured" while sitting right
// there on disk. Resolve the installed package's own copy (dist/../config.json,
// src/../config.json under ts-node), and still let an explicit cwd copy win so
// per-project overrides keep working.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// NIKMCP_CONFIG_PATH wins over everything: it is the ONLY safe way for a test (or
// a sandboxed run) to redirect the writer. Without it, a chdir-based test writes
// its dummy key straight into the real repo config -- which is exactly how a live
// Open Cloud key got clobbered once.
export function configPath(): string {
  const override = process.env.NIKMCP_CONFIG_PATH;
  if (override && override.trim()) return resolve(override.trim());
  const cwdCfg = resolve("config.json");
  if (existsSync(cwdCfg)) return cwdCfg;
  return join(PKG_ROOT, "config.json");
}

export interface AppConfig {
  port: number; // base port; the bridge binds the first free one in [port, port+portRange)
  portRange: number; // how many ports to try before giving up
  pollHoldMs: number; // 0 = short-poll (return immediately)
  commandTimeoutMs: number;
  openCloud: OpenCloudConfig;
  // task 24 validation layer (both fail OPEN: unavailable dump/binary = pass-through)
  apiValidation: boolean; // Part A: API-dump reflection checks pre-enqueue
  apiDumpTtlHours: number; // refetch when the cached dump is older / version changed
  luauGate: boolean; // Part B: luau-lsp analyze gate on Luau source
  luauLspPath?: string; // absolute path override for the analyzer binary
  syncDir?: string; // task 25: default export/import dir (the tool's dir param wins)
  rocreate: RoCreateConfig; // task 26
}

export interface OpenCloudConfig {
  apiKey?: string; // ROBLOX_API_KEY env > config.json openCloud.apiKey
  creatorUserId?: number;
  creatorGroupId?: number;
}

// Task 26 RoCreate: the Open Cloud key for reupload/monetization. Same key CLASS
// as openCloud.apiKey but kept in its own block so a RoCreate key can be scoped
// separately (assets:read+write, asset-permissions:write, developer-product,
// game-pass). The COOKIE never lives here -- it is encrypted in
// ~/.nikmcp/rocreate-secrets.json, password-gated.
export interface RoCreateConfig {
  apiKey?: string; // ROCREATE_API_KEY env > config.json rocreate.apiKey > openCloud.apiKey fallback
}

// Keep DEFAULT_PORT in sync with plugin/src/Config.luau.
// Base 58741 = boshyxd robloxstudio-mcp's port, so NikMCP is a drop-in replacement.
// Auto-walk 58741-58760 still lets multiple terminals each grab a free port.
const DEFAULT_PORT = 58741;

// Bind localhost only. This is a local dev tool; never expose it.
export const HOST = "127.0.0.1";

// Precedence: --port flag > ROBLOX_STUDIO_PORT/PORT env > config.json > default.
export function resolveConfig(argv: string[] = process.argv.slice(2)): AppConfig {
  let fileCfg: Partial<AppConfig> = {};
  try {
    fileCfg = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<AppConfig>;
  } catch {
    // no config.json — fine
  }

  const flagPort = parsePortFlag(argv);
  const envRaw = process.env.ROBLOX_STUDIO_PORT ?? process.env.PORT;
  const envPort = envRaw !== undefined ? Number(envRaw) : undefined;

  const candidate = flagPort ?? envPort ?? fileCfg.port ?? DEFAULT_PORT;
  const port = Number.isInteger(candidate) && candidate > 0 && candidate < 65536
    ? candidate
    : DEFAULT_PORT;

  const rawRange = fileCfg.portRange ?? 20;
  const portRange = Number.isInteger(rawRange) && rawRange > 0 ? rawRange : 20;

  // Precedence: ROBLOX_API_KEY env > config.json openCloud.apiKey. The key never
  // has a default -- missing means the upload_asset tool reports "not configured".
  const fileOpenCloud = fileCfg.openCloud ?? {};
  const openCloud: OpenCloudConfig = {
    apiKey: process.env.ROBLOX_API_KEY ?? fileOpenCloud.apiKey,
    // 0 is never a valid creator id -- coerce falsy to undefined so the shipped
    // example (both ids 0) reads as "not configured", and filling in just one id
    // works without deleting the other line.
    creatorUserId: fileOpenCloud.creatorUserId || undefined,
    creatorGroupId: fileOpenCloud.creatorGroupId || undefined,
  };

  return {
    port,
    // Auto-pick: try [port, port+portRange) so each terminal's bridge gets a free
    // port instead of crashing on EADDRINUSE.
    portRange,
    // Short-poll: /poll returns immediately (0 = no hold). Long holds starve
    // concurrent Studio connections (HttpService services few outstanding requests).
    pollHoldMs: fileCfg.pollHoldMs ?? 0,
    commandTimeoutMs: fileCfg.commandTimeoutMs ?? 30000,
    openCloud,
    apiValidation: fileCfg.apiValidation !== false,
    apiDumpTtlHours:
      typeof fileCfg.apiDumpTtlHours === "number" && fileCfg.apiDumpTtlHours > 0
        ? fileCfg.apiDumpTtlHours
        : 168,
    luauGate: fileCfg.luauGate !== false,
    luauLspPath:
      typeof fileCfg.luauLspPath === "string" && fileCfg.luauLspPath
        ? fileCfg.luauLspPath
        : undefined,
    syncDir:
      typeof fileCfg.syncDir === "string" && fileCfg.syncDir ? fileCfg.syncDir : undefined,
    rocreate: {
      // ROCREATE_API_KEY env > config.json rocreate.apiKey > openCloud.apiKey fallback.
      // Trailing `|| undefined` coerces an empty-string apiKey (the shipped example
      // ships "") to undefined so rocreateKey() honors its `string | null` contract
      // and an empty key can never reach the OC client -- same guard the openCloud
      // creator ids use above.
      // Trim before use: a key pasted with a stray leading/trailing space or
      // newline is sent verbatim in x-api-key and Roblox 401s it -- the exact
      // "my valid key doesn't work" trap. `|| undefined` still coerces empty.
      apiKey:
        ((process.env.ROCREATE_API_KEY ??
          fileCfg.rocreate?.apiKey ??
          process.env.ROBLOX_API_KEY ??
          fileOpenCloud.apiKey) || "").trim() || undefined,
    },
  };
}

export function setRoCreateApiKey(apiKey: string): void {
  const key = apiKey.trim();
  if (!key) throw new Error("api key required");

  const target = configPath();
  let fileCfg: Record<string, unknown> = {};
  if (existsSync(target)) {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config.json must contain a JSON object");
    }
    fileCfg = parsed as Record<string, unknown>;
  }

  const rocreate =
    fileCfg.rocreate && typeof fileCfg.rocreate === "object" && !Array.isArray(fileCfg.rocreate)
      ? { ...(fileCfg.rocreate as Record<string, unknown>) }
      : {};
  rocreate.apiKey = key;
  fileCfg.rocreate = rocreate;

  // Write the temp file NEXT TO the target, not into the cwd: renameSync across
  // volumes fails (EXDEV), and the target is now usually on a different drive
  // than wherever the client happened to spawn us.
  const tmp = join(
    dirname(target),
    `config.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  writeFileSync(tmp, JSON.stringify(fileCfg, null, 2) + "\n");
  renameSync(tmp, target);
}

function parsePortFlag(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && i + 1 < argv.length) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) return n;
    }
    if (a.startsWith("--port=")) {
      const n = Number(a.slice("--port=".length));
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}
