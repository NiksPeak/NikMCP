// Secret handling for the Open Cloud API key. The key lives ONLY here (env var or
// a restrictive credentials file) -- never in the place, the plugin, or the
// non-secret user-level config.json (which holds creator/rojoPath). Read on demand;
// never logged or echoed.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ENV_KEY = "ROBLOX_OPEN_CLOUD_KEY";

// Per-user data dir, OUTSIDE the npm package (so `npx nikmcp@latest` never wipes it).
// Windows: %APPDATA%/nikmcp ; else: $XDG_CONFIG_HOME or ~/.config /nikmcp.
export function userDataDir(): string {
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "nikmcp");
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "nikmcp");
}

function credentialsPath(): string {
  return join(userDataDir(), "credentials.json");
}

// Resolve the key: env var first, then the credentials file. undefined if neither.
export function readKey(): string | undefined {
  const env = process.env[ENV_KEY];
  if (env && env.trim()) {
    return env.trim();
  }
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(), "utf8")) as { openCloudKey?: string };
    const k = raw.openCloudKey;
    return k && k.trim() ? k.trim() : undefined;
  } catch {
    return undefined;
  }
}

// Persist the key to the credentials file with restrictive perms (best-effort 0600).
// Kept separate from config.json so the secret never lands in the non-secret config.
export function writeKey(key: string): void {
  const dir = userDataDir();
  mkdirSync(dir, { recursive: true });
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify({ openCloudKey: key }, null, 2), "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is a no-op / unsupported on some platforms (e.g. Windows FAT) -- harmless.
  }
}

// "****" + last 4 chars, for status display. Never returns the full key.
export function maskKey(key: string): string {
  const tail = key.length >= 4 ? key.slice(-4) : key;
  return "****" + tail;
}
