import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveManifestInput } from "../dist/environment-manifest.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tmp = mkdtempSync(join(tmpdir(), "nikmcp-env-test-"));
try {
  const good = join(tmp, "manifest.json");
  const bad = join(tmp, "bad.json");
  writeFileSync(good, JSON.stringify({ chunks: [{ name: "Terrain", intendedOrigin: [0, 5, 0] }] }));
  writeFileSync(bad, "{broken");

  assert.deepEqual(resolveManifestInput({ manifest: { chunks: [] } }), { chunks: [] });
  assert.equal(resolveManifestInput({}), undefined);
  assert.deepEqual(resolveManifestInput({ manifestPath: good }), {
    chunks: [{ name: "Terrain", intendedOrigin: [0, 5, 0] }],
  });
  assert.throws(() => resolveManifestInput({ manifestPath: join(tmp, "missing.json") }), /not found/);
  assert.throws(() => resolveManifestInput({ manifestPath: bad }), /not valid JSON/);
  assert.throws(
    () => resolveManifestInput({ manifestPath: good, manifest: {} }),
    /not both/
  );

  const mcp = readFileSync("src/mcp-server.ts", "utf8");
  const nodeSettings = readFileSync("src/settings.ts", "utf8");
  const pluginSettings = readFileSync("plugin/src/Settings.luau", "utf8");
  const executor = readFileSync("plugin/src/Executor.luau", "utf8");
  const environment = readFileSync("plugin/src/EnvironmentTools.luau", "utf8");
  const runtime = readFileSync("plugin/src/RuntimeAgentSource.luau", "utf8");
  const init = readFileSync("plugin/src/init.server.luau", "utf8");

  const tools = [
    "get_studio_targets",
    "select_studio_target",
    "assemble_imported_chunks",
    "audit_environment",
    "inspect_texture_health",
    "world_health_report",
    "backup_selection",
    "restore_backup",
    "get_settled_runtime_status",
    "stop_playtest_settled",
  ];
  for (const name of tools) {
    assert.match(mcp, new RegExp(`\\"${name}\\"`), `${name} missing from MCP registration`);
    assert.match(pluginSettings, new RegExp(`\\"${name}\\"`), `${name} missing from plugin settings`);
  }

  for (const name of ["assemble_imported_chunks", "backup_selection", "restore_backup", "stop_playtest_settled"]) {
    assert.match(nodeSettings, new RegExp(`\\"${name}\\"`), `${name} missing from write gate`);
  }
  for (const name of ["assemble_imported_chunks", "audit_environment", "inspect_texture_health", "backup_selection", "restore_backup"]) {
    assert.match(executor, new RegExp(`cmd\\.type == \\"${name}\\"`), `${name} missing from edit dispatch`);
  }

  assert.match(environment, /backup already exists:[\s\S]*replace=true/, "backup collision guard missing");
  assert.match(environment, /restore_backup mutates the place; pass confirm=true/, "restore opt-in guard missing");
  assert.match(environment, /maximumHorizontalDrift = 0/, "X\/Z preservation report missing");
  assert.match(environment, /NikMCP_OriginalPivot/, "original pivot attribute missing");
  assert.match(environment, /Roblox cannot repair invalid Blender UVs/, "UV limitation missing");
  assert.match(environment, /asset_fetch_failure/, "engine asset fetch failure evidence missing");
  assert.match(environment, /invisible_collision/, "collision health finding missing");
  assert.match(runtime, /runServiceIsRunning = RunService:IsRunning\(\)/, "runtime engine truth missing");
  assert.match(runtime, /targetId=\" \.\. HttpService:UrlEncode\(TARGET_ID\)/, "runtime target pin missing");
  assert.match(init, /targetId=\" \.\. HttpService:UrlEncode\(TARGET_ID\)/, "edit target pin missing");
  assert.match(mcp, /playtest stop did not settle before timeout/, "stop timeout diagnostic missing");
  assert.match(mcp, /stale_runtime_state_cleared/, "stale runtime state proof missing");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js", "--port=49680"],
    stderr: "pipe",
  });
  const client = new Client({ name: "environment-tooling-contract", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const name of tools) assert.equal(names.has(name), true, `${name} not exposed over MCP`);

    const noRoots = await client.callTool({ name: "assemble_imported_chunks", arguments: {} });
    assert.equal(noRoots.isError, true);
    assert.match(noRoots.content.map((c) => c.text ?? "").join("\n"), /provide importedRoots or paths/);

    const missingManifest = await client.callTool({
      name: "assemble_imported_chunks",
      arguments: { importedRoots: ["Terrain"], manifestPath: join(tmp, "absent.json") },
    });
    assert.equal(missingManifest.isError, true);
    assert.match(missingManifest.content.map((c) => c.text ?? "").join("\n"), /manifest file not found/);

    const missingSelection = await client.callTool({ name: "select_studio_target", arguments: {} });
    assert.equal(missingSelection.isError, true);
    assert.match(missingSelection.content.map((c) => c.text ?? "").join("\n"), /requires targetId or bridgePort/);
  } finally {
    await client.close();
  }

  console.log("environment-tooling: PASS (manifest errors, MCP contracts, parity, dry-run\/backup\/runtime guards)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
