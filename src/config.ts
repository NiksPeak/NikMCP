import { readFileSync } from "node:fs";

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
}

export interface OpenCloudConfig {
  apiKey?: string; // ROBLOX_API_KEY env > config.json openCloud.apiKey
  creatorUserId?: number;
  creatorGroupId?: number;
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
    fileCfg = JSON.parse(readFileSync("config.json", "utf8")) as Partial<AppConfig>;
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
  };
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
