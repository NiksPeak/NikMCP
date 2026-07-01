import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { userDataDir } from "./credentials.js";

export interface CreatorConfig {
  userId?: number;
  groupId?: number;
}

// Non-secret, user-level config (creator + Open Cloud knobs). Stored under
// userDataDir()/config.json -- NEVER the secret key (that lives in credentials.ts).
export interface UserConfig {
  creator?: CreatorConfig;
  rojoPath?: string;
  openCloudAssetType?: string;
  openCloudFileContentType?: string;
}

export interface AppConfig {
  port: number; // base port; the bridge binds the first free one in [port, port+portRange)
  portRange: number; // how many ports to try before giving up
  pollHoldMs: number; // 0 = short-poll (return immediately)
  commandTimeoutMs: number;
  // Open Cloud (task 21); merged from the user-level config. Secret key is NOT here.
  creator?: CreatorConfig;
  rojoPath?: string;
  openCloudAssetType?: string;
  openCloudFileContentType?: string;
}

function userConfigPath(): string {
  return join(userDataDir(), "config.json");
}

// Read the user-level (non-secret) config. {} if absent/unreadable.
export function readUserConfig(): UserConfig {
  try {
    return JSON.parse(readFileSync(userConfigPath(), "utf8")) as UserConfig;
  } catch {
    return {};
  }
}

// Shallow-merge a patch into the user-level config and persist it. Used by the CLI
// (`set-creator`) and the bridge `/config/set-key` endpoint. Never writes the key.
export function writeUserConfig(patch: Partial<UserConfig>): UserConfig {
  const dir = userDataDir();
  mkdirSync(dir, { recursive: true });
  const merged: UserConfig = { ...readUserConfig(), ...patch };
  writeFileSync(userConfigPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
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

  // User-level (non-secret) config: creator id + Open Cloud knobs. Lives outside the
  // package so package updates don't wipe it. Does NOT affect port precedence above.
  const userCfg = readUserConfig();

  return {
    port,
    // Auto-pick: try [port, port+portRange) so each terminal's bridge gets a free
    // port instead of crashing on EADDRINUSE.
    portRange,
    // Short-poll: /poll returns immediately (0 = no hold). Long holds starve
    // concurrent Studio connections (HttpService services few outstanding requests).
    pollHoldMs: fileCfg.pollHoldMs ?? 0,
    commandTimeoutMs: fileCfg.commandTimeoutMs ?? 30000,
    creator: userCfg.creator,
    rojoPath: userCfg.rojoPath,
    openCloudAssetType: userCfg.openCloudAssetType,
    openCloudFileContentType: userCfg.openCloudFileContentType,
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
