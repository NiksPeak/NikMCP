import { randomUUID } from "node:crypto";
import { redactKey } from "./open-cloud.js";

export const CREATOR_STORE_ASSET_TYPES = [
  "Audio",
  "Model",
  "Decal",
  "Plugin",
  "MeshPart",
  "Video",
  "FontFamily",
] as const;

export const CREATOR_STORE_SORT_CATEGORIES = [
  "Relevance",
  "Trending",
  "Top",
  "AudioDuration",
  "CreateTime",
  "UpdatedTime",
  "Ratings",
] as const;

export type CreatorStoreAssetType = (typeof CREATOR_STORE_ASSET_TYPES)[number];
export type CreatorStoreSortCategory = (typeof CREATOR_STORE_SORT_CATEGORIES)[number];

export interface CreatorStoreSearchInput {
  query: string;
  assetType?: CreatorStoreAssetType;
  includeOnlyVerifiedCreators?: boolean;
  creatorUserId?: number;
  creatorGroupId?: number;
  sortCategory?: CreatorStoreSortCategory;
  sortDirection?: "Ascending" | "Descending";
  maxPageSize?: number;
  pageToken?: string;
}

function creatorStoreHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey?.trim()) headers["x-api-key"] = apiKey.trim();
  return headers;
}

async function fetchCreatorStoreJson(
  url: string,
  init: RequestInit,
  apiKey?: string,
): Promise<Record<string, unknown>> {
  const key = apiKey?.trim() ?? "";
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(redactKey(error instanceof Error ? error.message : String(error), key));
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Creator Store request rejected (${response.status}). Public search may work without a key; ` +
        "authenticated search/details require creator-store-product:read.",
    );
  }
  if (!response.ok) {
    const body = redactKey(await response.text().catch(() => ""), key).slice(0, 500);
    throw new Error(
      redactKey(
        `Creator Store request failed: ${response.status} ${response.statusText} - ${body}`,
        key,
      ),
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

export function buildCreatorStoreSearchBody(input: CreatorStoreSearchInput): Record<string, unknown> {
  if (input.creatorUserId !== undefined && input.creatorGroupId !== undefined) {
    throw new Error("creatorUserId and creatorGroupId are mutually exclusive");
  }
  const maxPageSize = Math.max(1, Math.min(100, input.maxPageSize ?? 25));
  const body: Record<string, unknown> = {
    query: input.query.trim(),
    maxPageSize,
    searchView: "Full",
    includeOnlyVerifiedCreators: input.includeOnlyVerifiedCreators ?? false,
    sortCategory: input.sortCategory ?? "Relevance",
  };
  if (input.assetType) body.searchCategoryType = input.assetType;
  if (input.creatorUserId !== undefined) body.userId = String(input.creatorUserId);
  if (input.creatorGroupId !== undefined) body.groupId = String(input.creatorGroupId);
  if (input.sortDirection) body.sortDirection = input.sortDirection;
  if (input.pageToken?.trim()) body.pageToken = input.pageToken.trim();
  return body;
}

export async function searchCreatorStore(
  input: CreatorStoreSearchInput,
  apiKey?: string,
): Promise<Record<string, unknown>> {
  const raw = await fetchCreatorStoreJson(
    "https://apis.roblox.com/toolbox-service/v2/assets:search",
    {
      method: "POST",
      headers: creatorStoreHeaders(apiKey),
      body: JSON.stringify(buildCreatorStoreSearchBody(input)),
    },
    apiKey,
  );
  const assets = Array.isArray(raw.creatorStoreAssets) ? raw.creatorStoreAssets : [];
  return {
    query: input.query,
    assetType: input.assetType ?? null,
    authenticated: Boolean(apiKey?.trim()),
    resultCount: assets.length,
    totalResults: raw.totalResults ?? null,
    nextPageToken: raw.nextPageToken ?? null,
    assets,
    facets: raw.facets ?? null,
    correction: raw.correction ?? null,
  };
}

export async function getCreatorStoreAsset(
  assetId: number,
  apiKey?: string,
): Promise<Record<string, unknown>> {
  return fetchCreatorStoreJson(
    `https://apis.roblox.com/toolbox-service/v2/assets/${assetId}`,
    { headers: creatorStoreHeaders(apiKey) },
    apiKey,
  );
}

const ALWAYS_BLOCKED_SEGMENTS = new Set([
  "serverscriptservice",
  "starterplayer",
  "starterplayerscripts",
  "startercharacterscripts",
  "startergui",
  "starterpack",
  "replicatedfirst",
  "remotes",
  "remoteevents",
  "remotefunctions",
  "networking",
]);

const SAFE_DIRECT_ROOTS = new Set([
  "game.Workspace",
  "game.ServerStorage",
  "game.Lighting",
  "game.SoundService",
]);

const SAFE_REPLICATED_STORAGE_FOLDERS = new Set([
  "assets",
  "content",
  "models",
  "packages",
]);

export function validateGuardedAssetTarget(targetPath: string): {
  allowed: boolean;
  normalized: string;
  reason?: string;
} {
  const normalized = targetPath.trim().replace(/\.+$/g, "");
  if (!normalized.startsWith("game.")) {
    return { allowed: false, normalized, reason: "targetPath must be an explicit game.<Service> path" };
  }
  const segments = normalized.split(".");
  for (let index = 1; index < segments.length; index++) {
    const lower = segments[index].toLowerCase();
    if (ALWAYS_BLOCKED_SEGMENTS.has(lower)) {
      return {
        allowed: false,
        normalized,
        reason: `targetPath enters blocked executable/network surface '${segments[index]}'`,
      };
    }
  }
  for (const root of SAFE_DIRECT_ROOTS) {
    if (normalized === root || normalized.startsWith(`${root}.`)) {
      return { allowed: true, normalized };
    }
  }
  if (segments[1] === "ReplicatedStorage") {
    const safeFolder = segments[2]?.toLowerCase();
    if (safeFolder && SAFE_REPLICATED_STORAGE_FOLDERS.has(safeFolder)) {
      return { allowed: true, normalized };
    }
    return {
      allowed: false,
      normalized,
      reason:
        "ReplicatedStorage insertion is limited to explicit Assets, Content, Models, or Packages subfolders",
    };
  }
  return {
    allowed: false,
    normalized,
    reason:
      "targetPath is outside the guarded allowlist (Workspace, ServerStorage, Lighting, SoundService, or approved ReplicatedStorage asset folders)",
  };
}

export interface AssetScanGrant {
  token: string;
  assetId: number;
  targetPath: string;
  fingerprint: string;
  expiresAt: number;
  used: boolean;
}

const SCAN_TOKEN_TTL_MS = 10 * 60 * 1000;
const scanGrants = new Map<string, AssetScanGrant>();

export function createAssetScanGrant(
  assetId: number,
  targetPath: string,
  fingerprint: string,
): AssetScanGrant {
  const token = randomUUID();
  const grant: AssetScanGrant = {
    token,
    assetId,
    targetPath,
    fingerprint,
    expiresAt: Date.now() + SCAN_TOKEN_TTL_MS,
    used: false,
  };
  scanGrants.set(token, grant);
  return grant;
}

export function consumeAssetScanGrant(
  token: string,
  assetId: number,
  targetPath: string,
): AssetScanGrant {
  const grant = scanGrants.get(token);
  if (!grant) throw new Error("scanToken is unknown; inspect the asset again");
  if (grant.used) throw new Error("scanToken was already used; inspect the asset again");
  if (Date.now() > grant.expiresAt) {
    scanGrants.delete(token);
    throw new Error("scanToken expired; inspect the asset again");
  }
  if (grant.assetId !== assetId || grant.targetPath !== targetPath) {
    throw new Error("scanToken is bound to a different assetId or targetPath");
  }
  grant.used = true;
  return grant;
}

export function resetAssetScanGrantsForTests(): void {
  scanGrants.clear();
}
