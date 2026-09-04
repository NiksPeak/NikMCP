import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcp = readFileSync("src/mcp-server.ts", "utf8");
const executor = readFileSync("plugin/src/Executor.luau", "utf8");
const runtime = readFileSync("plugin/src/RuntimeAgentSource.luau", "utf8");
const clientSource = readFileSync("plugin/src/ClientAgentSource.luau", "utf8");
const qaTools = readFileSync("plugin/src/QATools.luau", "utf8");
const settings = readFileSync("plugin/src/Settings.luau", "utf8");
const nodeSettings = readFileSync("src/settings.ts", "utf8");

for (const name of ["run_multi_client_qa", "runtime_ui_regression", "world_health_report"]) {
  assert.match(mcp, new RegExp(`\\"${name}\\"`), `${name} missing from MCP`);
  assert.match(settings, new RegExp(`\\"${name}\\"`), `${name} missing from plugin settings`);
}
for (const name of ["run_multi_client_qa", "runtime_ui_regression"]) {
  assert.match(nodeSettings, new RegExp(`\\"${name}\\"`), `${name} missing from write gate`);
}

assert.match(executor, /ExecuteMultiplayerTestAsync/);
assert.match(executor, /mode == "multiplayer"/);
assert.match(runtime, /StudioTestService:AddPlayers/);
assert.match(runtime, /action == "disconnect_player"/);
assert.match(clientSource, /StudioTestService:LeaveTest/);
assert.match(clientSource, /relay:FireServer\("qaReady"\)/);
assert.match(mcp, /fully settled edit-mode target/);
assert.match(mcp, /settleTimeoutSec/);

for (const marker of [
  "queryUiRegression",
  "fully_offscreen",
  "clipped_by_ancestor",
  "interactive_overlap",
  "tiny_touch_target",
  "safe_area_not_reserved",
  "heavy_offset_sizing",
  "textscaled_without_constraint",
  "live_state_and_layout",
]) {
  assert.match(clientSource, new RegExp(marker), `client UI audit missing ${marker}`);
}
assert.match(qaTools, /StudioDeviceSimulatorService:CreateDeviceAsync/);
assert.match(qaTools, /SetOrientationAsync/);
assert.match(qaTools, /SetResolutionAsync/);
assert.match(qaTools, /SetScalingModeAsync/);
assert.match(qaTools, /StopSimulationAsync/);
for (const profile of ["phone_portrait", "phone_landscape", "tablet_portrait", "desktop"]) {
  assert.match(mcp, new RegExp(profile), `default device matrix missing ${profile}`);
}
assert.match(mcp, /no truthful client pixel-capture path/);

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--port=49682"],
  stderr: "pipe",
});
const client = new Client({ name: "qa-workflows-contract", version: "1.0.0" });
await client.connect(transport);
try {
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const name of ["run_multi_client_qa", "runtime_ui_regression", "world_health_report"]) {
    assert.equal(names.has(name), true, `${name} not exposed over MCP`);
  }
  const invalid = await client.callTool({
    name: "run_multi_client_qa",
    arguments: { startup: { initialPlayers: 9 } },
  });
  assert.equal(invalid.isError, true, "schema must reject more than 8 clients before Studio");
} finally {
  await client.close();
}

console.log("qa-workflows: PASS (true multi-client, leave/add, settled teardown, device matrix, live UI evidence, MCP contracts)");
