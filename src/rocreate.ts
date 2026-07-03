// Task 26 Phase 2: RoCreate engine. Ports the PURE request logic from RoCreate
// (create/list/grant, key-only) and kartFr Asset-Reuploader (download + legacy
// animation/mesh upload, cookie-based), drops the web/DB layer, persists maps to
// JSON. Dependency-free (Node 18+ fetch/FormData/Blob, node:crypto/fs). All logs
// to stderr. See ROCREATE_CAPABILITY_MATRIX.md for the endpoint provenance.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { nikmcpCacheDir } from "./api-dump.js";
import { redactKey } from "./open-cloud.js";

export type Creator = { type: "user" | "group"; id: string };

// ---------- oldId -> newId map (~/.nikmcp/rocreate-map.json) -------------------

export type MapItemKind = "image" | "audio" | "mesh" | "animation" | "devproduct" | "gamepass";

export interface MapEntry {
  kind: MapItemKind;
  oldId: string;
  newId: string;
  status: "ok" | "failed" | "pending";
  note?: string;
}

interface RoCreateMap {
  updatedAt?: string;
  entries: Record<string, MapEntry>; // key = `${kind}:${oldId}`
}

function mapPath(): string {
  return join(nikmcpCacheDir(), "rocreate-map.json");
}

export function readMap(): RoCreateMap {
  try {
    const m = JSON.parse(readFileSync(mapPath(), "utf8")) as RoCreateMap;
    if (m && typeof m === "object" && m.entries) return m;
  } catch {
    // no/corrupt map
  }
  return { entries: {} };
}

export function mapKey(kind: MapItemKind, oldId: string): string {
  return `${kind}:${oldId}`;
}

// Merge entries and atomically persist. nowIso is passed in (Date.now is not
// available in some sandboxes and callers already have a timestamp).
export function writeMapEntries(entries: MapEntry[], nowIso: string): RoCreateMap {
  const m = readMap();
  for (const e of entries) m.entries[mapKey(e.kind, e.oldId)] = e;
  m.updatedAt = nowIso;
  const dir = nikmcpCacheDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `rocreate-map.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n");
  renameSync(tmp, mapPath());
  return m;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- cookie client (CSRF dance) ----------------------------------------
// Used ONLY by the download path and the legacy animation/mesh upload. The CSRF
// dance is reactive (kartFr precedent): first call may 403, read x-csrf-token from
// the response header, retry once with it.

const ROBLOX_UA = "RobloxStudio/WinInet";

export class CookieClient {
  private csrf = "";
  constructor(private cookie: string) {}

  // A cookie missing the standard warning prefix is not a real .ROBLOSECURITY.
  static looksValid(cookie: string): boolean {
    return cookie.includes("_|WARNING:-DO-NOT-SHARE-THIS.");
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      "User-Agent": ROBLOX_UA,
      Cookie: `.ROBLOSECURITY=${this.cookie}`,
      ...(this.csrf ? { "x-csrf-token": this.csrf } : {}),
      ...extra,
    };
  }

  // fetch with one reactive CSRF retry. Returns the Response (caller reads body).
  async fetch(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    let res = await fetch(url, { ...init, headers: this.headers(init.headers ?? {}) });
    if (res.status === 403) {
      const token = res.headers.get("x-csrf-token");
      if (token) {
        this.csrf = token;
        res = await fetch(url, { ...init, headers: this.headers(init.headers ?? {}) });
      }
    }
    return res;
  }

  // GET https://users.roblox.com/v1/users/authenticated -> { id, name, displayName }
  // 401 = cookie expired/invalid. Used to validate before a run.
  async whoAmI(): Promise<{ ok: true; userId: number; name: string } | { ok: false; status: number }> {
    const res = await this.fetch("https://users.roblox.com/v1/users/authenticated", { method: "GET" });
    if (res.status === 401) return { ok: false, status: 401 };
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json().catch(() => ({}))) as { id?: number; name?: string };
    if (typeof data.id !== "number") return { ok: false, status: res.status };
    return { ok: true, userId: data.id, name: data.name ?? "" };
  }
}

// ---------- download bytes from an existing asset ID --------------------------
// Public assets: cookieless GET assetdelivery v2. Restricted: cookie POST batch
// with the Roblox-Place-Id header (kartFr's confirmed path). placeId comes from
// the open place (game.PlaceId) or a per-run override.

export interface DownloadResult {
  ok: boolean;
  bytes?: Buffer;
  contentType?: string;
  error?: string;
  authRequired?: boolean; // asset needs the cookie / a place from its universe
}

async function fetchLocation(url: string, cookie: CookieClient | null, placeId?: string): Promise<
  { ok: true; location: string } | { ok: false; authRequired: boolean; error: string }
> {
  // Public shortcut first (no cookie): GET v2/assetId/{id}
  if (!cookie) {
    const res = await fetch(url, { headers: { "User-Agent": ROBLOX_UA }, redirect: "follow" });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as
        | { locations?: { location?: string }[]; errors?: { message?: string }[] }
        | null;
      const loc = data?.locations?.[0]?.location;
      if (loc) return { ok: true, location: loc };
      const msg = data?.errors?.[0]?.message ?? "no location in response";
      const authRequired = /authentication required/i.test(msg);
      return { ok: false, authRequired, error: msg };
    }
    return { ok: false, authRequired: res.status === 403 || res.status === 401, error: `assetdelivery ${res.status}` };
  }
  return { ok: false, authRequired: true, error: "cookie batch handled by caller" };
}

// Resolve id -> CDN location -> bytes. Tries public GET, then the cookie batch.
export async function downloadAssetBytes(opts: {
  assetId: string;
  cookie: CookieClient | null;
  placeId?: string;
}): Promise<DownloadResult> {
  const { assetId, cookie, placeId } = opts;

  // 1) public shortcut (cookieless)
  const pub = await fetchLocation(
    `https://assetdelivery.roblox.com/v2/assetId/${encodeURIComponent(assetId)}`,
    null
  );
  let location: string | null = pub.ok ? pub.location : null;
  const pubAuthRequired = pub.ok ? false : pub.authRequired;
  const pubError = pub.ok ? "" : pub.error;

  // 2) cookie batch fallback (restricted assets). Needs Roblox-Place-Id.
  if (!location && cookie) {
    const body = JSON.stringify([{ assetId: Number(assetId), requestId: "0" }]);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (placeId) headers["Roblox-Place-Id"] = placeId;
    const res = await cookie.fetch("https://assetdelivery.roblox.com/v2/assets/batch", {
      method: "POST",
      headers,
      body,
    });
    if (res.ok) {
      const arr = (await res.json().catch(() => null)) as
        | { locations?: { location?: string }[]; errors?: { message?: string }[] }[]
        | null;
      const first = Array.isArray(arr) ? arr[0] : undefined;
      location = first?.locations?.[0]?.location ?? null;
      if (!location) {
        const msg = first?.errors?.[0]?.message ?? "no location (asset may need a place from its universe)";
        return { ok: false, authRequired: /authentication required/i.test(msg), error: msg };
      }
    } else {
      return { ok: false, authRequired: res.status === 401 || res.status === 403, error: `batch ${res.status}` };
    }
  }

  if (!location) {
    return {
      ok: false,
      authRequired: pubAuthRequired,
      error: cookie ? pubError : `${pubError} (unlock a cookie to reach restricted assets)`,
    };
  }

  // 3) download the bytes from the CDN location (cookie rides along if present)
  const res = cookie
    ? await cookie.fetch(location, { method: "GET" })
    : await fetch(location, { headers: { "User-Agent": ROBLOX_UA } });
  if (!res.ok) return { ok: false, error: `CDN download ${res.status}` };
  const bytes = Buffer.from(await res.arrayBuffer());
  return { ok: true, bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

// ---------- key-side: asset permission grant (+ verify) -----------------------
// Port of RoCreate assetPermissions.ts. Grant-only; no revoke. A 200 does NOT
// prove the grant applied when the key lacks asset-permissions:write, so we
// surface the granted ids and let the caller verify.

const GRANT_URL = "https://apis.roblox.com/asset-permissions-api/v1/assets/permissions";

const GRANT_ERROR_MESSAGES: Record<string, string> = {
  UnknownError: "Roblox reported an unknown error for this asset.",
  InvalidRequest: "Roblox rejected the grant request as invalid.",
  AssetNotFound: "Roblox could not find this asset.",
  CannotManageAsset: "This API key's owner cannot manage this asset (different user or group).",
  PublicAssetCannotBeGrantedTo: "This asset is public -- it does not need a grant.",
  CannotManageSubject: "This API key's owner cannot grant to this subject (check universe/user/group ID).",
  SubjectNotFound: "Roblox could not find that universe, user, or group ID.",
  AssetTypeNotEnabled: "This asset type does not support permission grants.",
  PermissionLimitReached: "This asset has reached its permission grant limit.",
  DependenciesLimitReached: "This asset has reached its dependency-grant limit.",
};

export async function grantAssetPermission(opts: {
  apiKey: string;
  assetId: string;
  subjectType: "Universe" | "User" | "Group";
  subjectId: string;
  grantToDependencies?: boolean;
}): Promise<{ ok: boolean; grantedAssetIds: string[]; error?: string }> {
  const { apiKey, assetId, subjectType, subjectId } = opts;
  let res: Response;
  try {
    res = await fetch(GRANT_URL, {
      method: "PATCH",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        subjectType,
        subjectId,
        action: "Use",
        requests: [{ assetId: Number(assetId), grantToDependencies: opts.grantToDependencies ?? false }],
      }),
    });
  } catch {
    return { ok: false, grantedAssetIds: [], error: "could not reach the Asset Permissions API" };
  }
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const code = data?.error?.code;
    const msg =
      (typeof data?.error?.message === "string" && data.error.message) ||
      GRANT_ERROR_MESSAGES[code] ||
      `grant failed (${res.status})`;
    return { ok: false, grantedAssetIds: [], error: redactKey(String(msg), apiKey) };
  }
  const granted = Array.isArray(data?.successAssetIds) ? data.successAssetIds.map(String) : [];
  // Verify-don't-trust-the-200: if the asset id is not echoed in successAssetIds,
  // the grant likely did NOT apply (missing asset-permissions:write scope).
  const applied = granted.includes(String(assetId));
  return {
    ok: applied,
    grantedAssetIds: granted,
    error: applied ? undefined : "grant returned 200 but did not confirm this asset (check asset-permissions:write scope)",
  };
}

// ---------- key-side: create asset (reuses open-cloud.uploadAsset) ------------
// Re-exported wrapper so the engine has one entry point; images/audio go here.
export { uploadAsset } from "./open-cloud.js";

// ---------- key-side: dev products + game passes ------------------------------
// Ports of RoCreate developer-products/game-passes routes (NEW OC endpoints,
// verified live). Create returns a NEW id (no ownership transfer -- platform).

const RETRY_BACKOFF_MS = [1000, 2000, 4000];

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function ocCreateMultipart(
  url: string,
  apiKey: string,
  fields: Record<string, string>,
  icon?: { bytes: Buffer; contentType: string; field: string }
): Promise<{ ok: true; data: any } | { ok: false; status: number; error: string }> {
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    if (icon) {
      const ext = icon.contentType.split("/")[1]?.toLowerCase() ?? "png";
      form.set(icon.field, new Blob([new Uint8Array(icon.bytes)], { type: icon.contentType }), `icon.${ext}`);
    }
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "x-api-key": apiKey, Accept: "application/json" }, body: form });
    } catch {
      return { ok: false, status: 502, error: "could not reach Roblox" };
    }
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (res.ok) return { ok: true, data };
    if (!isRetryable(res.status) || attempt === RETRY_BACKOFF_MS.length - 1) {
      const msg = data?.message ?? data?.error ?? `${res.status}`;
      return { ok: false, status: res.status, error: redactKey(`create failed: ${msg}`, apiKey) };
    }
    const ra = Number(res.headers.get("Retry-After"));
    const delay = Math.min(Math.max(Number.isFinite(ra) ? ra * 1000 : RETRY_BACKOFF_MS[attempt], 250), 8000);
    await sleep(delay);
  }
  return { ok: false, status: 500, error: "create exhausted retries" };
}

async function ocListByUniverse(
  base: string,
  key: string,
  apiKey: string
): Promise<{ ok: true; items: any[] } | { ok: false; error: string }> {
  const items: any[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(base);
    url.searchParams.set("pageSize", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let res: Response;
    try {
      res = await fetch(url.toString(), { headers: { "x-api-key": apiKey, Accept: "application/json" } });
    } catch {
      return { ok: false, error: "could not reach Roblox" };
    }
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
    if (!res.ok) return { ok: false, error: redactKey(`list failed (${res.status})`, apiKey) };
    const arr = Array.isArray(data[key]) ? data[key] : [];
    items.push(...arr);
    pageToken = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : null;
    if (!pageToken) break;
  }
  return { ok: true, items };
}

export async function createDeveloperProduct(opts: {
  apiKey: string;
  universeId: string;
  name: string;
  description?: string;
  priceInRobux: number;
}) {
  const url = `https://apis.roblox.com/developer-products/v2/universes/${opts.universeId}/developer-products`;
  return ocCreateMultipart(url, opts.apiKey, {
    name: opts.name,
    description: opts.description ?? "",
    isForSale: "true",
    price: String(opts.priceInRobux),
    isRegionalPricingEnabled: "false",
  });
}

export async function listDeveloperProducts(apiKey: string, universeId: string) {
  return ocListByUniverse(
    `https://apis.roblox.com/developer-products/v2/universes/${universeId}/developer-products/creator`,
    "developerProducts",
    apiKey
  );
}

export async function createGamePass(opts: {
  apiKey: string;
  universeId: string;
  name: string;
  description?: string;
  priceInRobux: number;
}) {
  const url = `https://apis.roblox.com/game-passes/v1/universes/${opts.universeId}/game-passes`;
  return ocCreateMultipart(url, opts.apiKey, {
    name: opts.name,
    description: opts.description ?? "",
    isForSale: "true",
    price: String(opts.priceInRobux),
    isRegionalPricingEnabled: "false",
  });
}

export async function listGamePasses(apiKey: string, universeId: string) {
  return ocListByUniverse(
    `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes/creator`,
    "gamePasses",
    apiKey
  );
}

// ---------- cookie-side: legacy animation / mesh upload -----------------------
// Open Cloud cannot reupload an animation from existing bytes, so the raw
// KeyframeSequence binary (from downloadAssetBytes) is POSTed to the legacy
// endpoint. kartFr's confirmed path. Response 200 body = new asset id (integer).

export async function uploadAnimationLegacy(opts: {
  cookie: CookieClient;
  bytes: Buffer;
  name: string;
  description?: string;
  groupId?: string;
}): Promise<{ ok: true; assetId: string } | { ok: false; error: string; cookieExpired?: boolean }> {
  const params = new URLSearchParams({
    assetTypeName: "Animation",
    name: opts.name,
    description: opts.description ?? "",
  });
  if (opts.groupId) params.set("groupId", opts.groupId);
  const url = `https://www.roblox.com/ide/publish/UploadNewAnimation?${params.toString()}`;
  const res = await opts.cookie.fetch(url, {
    method: "POST",
    body: new Uint8Array(opts.bytes),
  });
  const text = await res.text();
  if (res.ok) {
    const id = text.trim();
    if (/^\d+$/.test(id)) return { ok: true, assetId: id };
    return { ok: false, error: `unexpected upload response: ${text.slice(0, 120)}` };
  }
  if (text.includes("NotLoggedIn") || res.status === 401) {
    return { ok: false, error: "cookie expired -- re-enter in the RoCreate tab", cookieExpired: true };
  }
  if (text.includes("Inappropriate name or description")) {
    return { ok: false, error: "animation name/description was moderated" };
  }
  return { ok: false, error: `animation upload failed (${res.status}): ${text.slice(0, 120)}` };
}

export async function uploadMeshLegacy(opts: {
  cookie: CookieClient;
  bytes: Buffer;
  name: string;
  description?: string;
  groupId?: string;
}): Promise<{ ok: true; assetId: string } | { ok: false; error: string; cookieExpired?: boolean }> {
  const params = new URLSearchParams({
    assetTypeName: "Mesh",
    name: opts.name,
    description: opts.description ?? "",
  });
  if (opts.groupId) params.set("groupId", opts.groupId);
  const url = `https://data.roblox.com/ide/publish/UploadNewMesh?${params.toString()}`;
  const res = await opts.cookie.fetch(url, { method: "POST", body: new Uint8Array(opts.bytes) });
  const text = await res.text();
  if (res.ok) {
    const id = text.trim();
    if (/^\d+$/.test(id)) return { ok: true, assetId: id };
    return { ok: false, error: `unexpected mesh response: ${text.slice(0, 120)}` };
  }
  if (text.includes("NotLoggedIn") || res.status === 401) {
    return { ok: false, error: "cookie expired -- re-enter in the RoCreate tab", cookieExpired: true };
  }
  return { ok: false, error: `mesh upload failed (${res.status}): ${text.slice(0, 120)}` };
}
