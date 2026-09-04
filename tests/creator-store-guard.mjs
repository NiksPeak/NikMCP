import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCreatorStoreSearchBody,
  consumeAssetScanGrant,
  createAssetScanGrant,
  getCreatorStoreAsset,
  resetAssetScanGrantsForTests,
  searchCreatorStore,
  validateGuardedAssetTarget,
} from "../dist/creator-store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

assert.deepEqual(
  buildCreatorStoreSearchBody({
    query: "stylized tree",
    assetType: "Model",
    includeOnlyVerifiedCreators: true,
    creatorUserId: 123,
    sortCategory: "Ratings",
    sortDirection: "Descending",
    maxPageSize: 250,
    pageToken: "next",
  }),
  {
    query: "stylized tree",
    searchCategoryType: "Model",
    includeOnlyVerifiedCreators: true,
    userId: "123",
    sortCategory: "Ratings",
    sortDirection: "Descending",
    maxPageSize: 100,
    pageToken: "next",
    searchView: "Full",
  },
);
assert.throws(
  () => buildCreatorStoreSearchBody({ query: "x", creatorUserId: 1, creatorGroupId: 2 }),
  /mutually exclusive/,
);

assert.equal(validateGuardedAssetTarget("game.Workspace.AssetStaging").allowed, true);
assert.equal(validateGuardedAssetTarget("game.ServerStorage.ReviewedModels").allowed, true);
assert.equal(validateGuardedAssetTarget("game.ReplicatedStorage.Assets.Models").allowed, true);
assert.equal(validateGuardedAssetTarget("game.ReplicatedStorage.Remotes").allowed, false);
assert.equal(validateGuardedAssetTarget("game.ServerScriptService").allowed, false);
assert.equal(validateGuardedAssetTarget("game.StarterPlayer.StarterPlayerScripts").allowed, false);
assert.equal(validateGuardedAssetTarget("Workspace").allowed, false);

resetAssetScanGrantsForTests();
const grant = createAssetScanGrant(55, "game.Workspace.AssetStaging", "abc123");
assert.equal(
  consumeAssetScanGrant(grant.token, 55, "game.Workspace.AssetStaging").fingerprint,
  "abc123",
);
assert.throws(
  () => consumeAssetScanGrant(grant.token, 55, "game.Workspace.AssetStaging"),
  /already used/,
);
const boundGrant = createAssetScanGrant(56, "game.Workspace.AssetStaging", "def456");
assert.throws(
  () => consumeAssetScanGrant(boundGrant.token, 56, "game.ServerStorage.Models"),
  /different assetId or targetPath/,
);

const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), init });
  if (String(url).endsWith("assets:search")) {
    return new Response(JSON.stringify({
      creatorStoreAssets: [{ asset: { id: 77, name: "Tree" } }],
      totalResults: 1,
      nextPageToken: "p2",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ asset: { id: 77, name: "Tree" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
try {
  const search = await searchCreatorStore({ query: "tree", maxPageSize: 5 }, "test-key");
  assert.equal(search.resultCount, 1);
  assert.equal(search.nextPageToken, "p2");
  assert.equal(requests[0].url, "https://apis.roblox.com/toolbox-service/v2/assets:search");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["x-api-key"], "test-key");
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.query, "tree");
  assert.equal(body.maxPageSize, 5);
  assert.equal(body.searchView, "Full");

  const details = await getCreatorStoreAsset(77);
  assert.equal(details.asset.id, 77);
  assert.equal(requests[1].url, "https://apis.roblox.com/toolbox-service/v2/assets/77");
  assert.equal(requests[1].init.headers["x-api-key"], undefined);
} finally {
  globalThis.fetch = originalFetch;
}

const assetGuard = readFileSync("plugin/src/AssetGuardTools.luau", "utf8");
const executor = readFileSync("plugin/src/Executor.luau", "utf8");
const settings = readFileSync("plugin/src/Settings.luau", "utf8");
const nodeSettings = readFileSync("src/settings.ts", "utf8");
for (const marker of [
  "numeric_external_require",
  "dynamic_code_execution",
  "http_service_access",
  "possible_obfuscation",
  "NikMCPQuarantine",
  "expectedFingerprint",
  "postInsertScan",
]) {
  assert.match(assetGuard, new RegExp(marker), `asset guard missing ${marker}`);
}
assert.match(executor, /cmd\.type == "guarded_asset_scan"/);
assert.match(executor, /cmd\.type == "guarded_asset_insert"/);
assert.match(settings, /name = "inspect_creator_store_asset"/);
assert.match(settings, /name = "guarded_insert_asset"/);
assert.match(nodeSettings, /"guarded_insert_asset"/);

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--port=49681"],
  stderr: "pipe",
});
const client = new Client({ name: "creator-store-guard-contract", version: "1.0.0" });
await client.connect(transport);
try {
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const name of ["search_assets", "inspect_creator_store_asset", "guarded_insert_asset"]) {
    assert.equal(names.has(name), true, `${name} not exposed over MCP`);
  }
} finally {
  await client.close();
}

console.log("creator-store-guard: PASS (search request, target allowlist, one-time grants, quarantine contract, MCP exposure)");
