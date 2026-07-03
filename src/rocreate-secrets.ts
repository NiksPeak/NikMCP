// Task 26 Phase 1: RoCreate secrets -- password-gated cookie encryption, secrets
// file IO, and the in-memory unlock session. Dependency-free (node:crypto/fs/os/path).
// All logs to stderr. NOTHING sensitive is ever committed: the encrypted cookie
// lives in ~/.nikmcp/rocreate-secrets.json (outside the repo); the OC API key lives
// in the gitignored config.json rocreate block; the password lives NOWHERE on disk
// (a decrypt failure IS the wrong-password signal).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nikmcpCacheDir } from "./api-dump.js";

const SCRYPT_N = 16384; // CPU/memory cost; ~50-100ms derive, fine for an interactive unlock
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedBlob {
  salt: string; // base64
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
}

// key = scrypt(password, salt, 32); AES-256-GCM. Mirrors RoCreate's AES-256-GCM
// envelope but derives the key from the PASSWORD (RoCreate uses an env key; NikMCP
// has no server env and wants password-gated unlock).
export function encryptCookie(plaintext: string, password: string): EncryptedBlob {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ct.toString("base64"),
  };
}

// Throws on wrong password / tampering (GCM auth tag mismatch). Callers treat any
// throw as "wrong password" -- there is no separate password hash to check against.
export function decryptCookie(blob: EncryptedBlob, password: string): string {
  const salt = Buffer.from(blob.salt, "base64");
  const key = scryptSync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------- secrets file (~/.nikmcp/rocreate-secrets.json) --------------------

export interface RoCreateSecrets {
  cookieEnc?: EncryptedBlob;
  // targetCreator is per-run in v1 (passed as a tool arg); an optional stored
  // default is honored if present but never required.
  targetCreator?: { type: "user" | "group"; id: string };
}

function secretsPath(): string {
  return join(nikmcpCacheDir(), "rocreate-secrets.json");
}

export function readSecrets(): RoCreateSecrets {
  try {
    const s = JSON.parse(readFileSync(secretsPath(), "utf8")) as RoCreateSecrets;
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

export function writeSecrets(secrets: RoCreateSecrets): void {
  const dir = nikmcpCacheDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `rocreate-secrets.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(secrets, null, 2) + "\n");
  renameSync(tmp, secretsPath());
}

export function hasCookieSecret(): boolean {
  return !!readSecrets().cookieEnc;
}

// Encrypt + persist a freshly-entered cookie. Called by the set-credentials flow.
export function setCookieSecret(rawCookie: string, password: string): void {
  const secrets = readSecrets();
  secrets.cookieEnc = encryptCookie(rawCookie, password);
  writeSecrets(secrets);
}

// ---------- in-memory unlock session -----------------------------------------
// Node holds the decrypted cookie ONLY while unlocked; idle expiry clears it.

const IDLE_MS = 30 * 60 * 1000; // 30 min, refreshed on use

interface UnlockState {
  cookie: string;
  expiresAt: number;
}
let session: UnlockState | null = null;
let cookieExpiredFlag = false; // set when a cookie call 401s

// Returns { ok:true } on success, { ok:false, error } on wrong password / no secret.
export function unlock(password: string): { ok: true } | { ok: false; error: string } {
  const secrets = readSecrets();
  if (!secrets.cookieEnc) {
    return { ok: false, error: "no cookie set -- add credentials in the RoCreate tab first" };
  }
  let cookie: string;
  try {
    cookie = decryptCookie(secrets.cookieEnc, password);
  } catch {
    return { ok: false, error: "wrong password" };
  }
  session = { cookie, expiresAt: Date.now() + IDLE_MS };
  cookieExpiredFlag = false;
  return { ok: true };
}

export function lock(): void {
  session = null;
}

export function isUnlocked(): boolean {
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    session = null;
    return false;
  }
  return true;
}

// Returns the decrypted cookie and refreshes idle expiry, or null if locked/expired.
export function useCookie(): string | null {
  if (!isUnlocked() || !session) return null;
  session.expiresAt = Date.now() + IDLE_MS;
  return session.cookie;
}

export function markCookieExpired(): void {
  cookieExpiredFlag = true;
  session = null; // a 401'd cookie is useless; force re-entry
}

export function isCookieExpiredFlag(): boolean {
  return cookieExpiredFlag;
}

// Booleans only -- values NEVER leave Node (drives rocreate_status).
export function secretsStatus(cfgHasKey: boolean): {
  unlocked: boolean;
  hasKey: boolean;
  hasCookie: boolean;
  cookieExpired: boolean;
  targetCreator?: { type: "user" | "group"; id: string };
} {
  const secrets = readSecrets();
  return {
    unlocked: isUnlocked(),
    hasKey: cfgHasKey,
    hasCookie: !!secrets.cookieEnc,
    cookieExpired: cookieExpiredFlag,
    targetCreator: secrets.targetCreator,
  };
}
