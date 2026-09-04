import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const INTERNAL_ROUTE_HEADER = "x-nikmcp-route-token";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
let cachedToken: string | null = null;

function tokenPath(): string {
  const override = process.env.NIKMCP_INTERNAL_TOKEN_PATH;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".nikmcp", "internal-route-token");
}

function readValidToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const token = readFileSync(path, "utf8").trim().toLowerCase();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`NikMCP internal route token is invalid; remove '${path}' and restart NikMCP`);
  }
  return token;
}

export function internalRouteToken(): string {
  const fromEnvironment = process.env.NIKMCP_INTERNAL_ROUTING_TOKEN?.trim().toLowerCase();
  if (fromEnvironment) {
    if (!TOKEN_PATTERN.test(fromEnvironment)) {
      throw new Error("NIKMCP_INTERNAL_ROUTING_TOKEN must be exactly 64 hexadecimal characters");
    }
    return fromEnvironment;
  }
  if (cachedToken) return cachedToken;

  const path = tokenPath();
  const existing = readValidToken(path);
  if (existing) {
    cachedToken = existing;
    return existing;
  }

  mkdirSync(dirname(path), { recursive: true });
  const generated = randomBytes(32).toString("hex");
  try {
    writeFileSync(path, generated, { encoding: "utf8", flag: "wx", mode: 0o600 });
    cachedToken = generated;
  } catch (error) {
    const raced = readValidToken(path);
    if (!raced) throw error;
    cachedToken = raced;
  }
  return cachedToken;
}

export function verifyInternalRouteToken(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !TOKEN_PATTERN.test(candidate.toLowerCase())) return false;
  const expected = Buffer.from(internalRouteToken(), "hex");
  const actual = Buffer.from(candidate.toLowerCase(), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
