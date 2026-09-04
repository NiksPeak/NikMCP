import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcp = readFileSync("src/mcp-server.ts", "utf8");
const bridge = readFileSync("src/bridge.ts", "utf8");
const queue = readFileSync("src/queue.ts", "utf8");
const nodeSettings = readFileSync("src/settings.ts", "utf8");
const pluginSettings = readFileSync("plugin/src/Settings.luau", "utf8");
const executor = readFileSync("plugin/src/Executor.luau", "utf8");
const agentTools = readFileSync("plugin/src/AgentTools.luau", "utf8");
const runtime = readFileSync("plugin/src/RuntimeAgentSource.luau", "utf8");
const clientSource = readFileSync("plugin/src/ClientAgentSource.luau", "utf8");
const pluginEntry = readFileSync("plugin/src/init.server.luau", "utf8");
const buildPlugin = readFileSync("scripts/build-plugin.mjs", "utf8");

const tools = [
  "task_context_bundle",
  "change_impact_report",
  "code_health_report",
  "plan_script_patchset",
  "apply_script_patchset",
  "wait_for_state",
  "client_input_sequence",
  "scene_analysis_snapshot",
  "capture_script_profile",
];

for (const name of tools) {
  assert.match(mcp, new RegExp(`\\"${name}\\"`), `${name} missing from MCP registration`);
  assert.match(
    pluginSettings,
    new RegExp(`\\"${name}\\"`),
    `${name} missing from Studio settings catalog`,
  );
}
for (const name of ["apply_script_patchset", "client_input_sequence"]) {
  assert.match(nodeSettings, new RegExp(`\\"${name}\\"`), `${name} missing from write gate`);
}

assert.match(buildPlugin, /"AgentTools"/, "AgentTools missing from generated plugin children");
assert.match(executor, /local AgentTools = require\(script\.Parent\.AgentTools\)/);
assert.match(executor, /cmd\.type == "apply_script_patchset"/);
assert.match(executor, /cmd\.type == "capture_script_profile"/);
assert.match(executor, /AgentTools\.applyScriptPatchset\(\{/);
assert.match(agentTools, /apply_script_patchset requires confirm=true/);
assert.match(agentTools, /source drifted inside UpdateSourceAsync/);
assert.doesNotMatch(agentTools, /GetService\("ChangeHistoryService"\)|TryBeginRecording|FinishRecording/);
assert.match(agentTools, /CRITICAL: transactional rollback was incomplete/);
assert.match(agentTools, /ScriptProfilerService:ServerStart/);
assert.match(agentTools, /ScriptProfilerService:DeserializeJSON/);
assert.match(runtime, /cmd\.type == "client_input_sequence"/);
assert.match(runtime, /cmd\.type == "scene_analysis_snapshot"/);
assert.match(clientSource, /CreateVirtualInput/);
assert.match(clientSource, /SendMouseButton/);
assert.match(clientSource, /SendPointerAction/);
assert.match(clientSource, /scene_analysis_snapshot/);
assert.match(mcp, /annotations: READ_ONLY_ANNOTATIONS/);
assert.match(mcp, /destructiveHint: true/);
assert.match(mcp, /expectedHash: studioHashByRelPath\.get\(row\.relPath\)/);
assert.match(mcp, /line\.level === expectedLevel/);
assert.match(mcp, /path not found\(\?:/);
assert.match(mcp, /item\.kind === "resolved"/);
assert.match(mcp, /inputCompleteness:/);
assert.match(bridge, /verifyInternalRouteToken/);
assert.match(queue, /queues\[context\]\.splice/);
assert.match(queue, /expectedTargetId/);
assert.match(mcp, /plan\.targetId/);
assert.match(pluginEntry, /command target mismatch/);
assert.match(runtime, /command target mismatch/);
assert.match(runtime, /local levelMatch = \{/);

if (process.argv.includes("--static-only")) {
  console.log(
    "agent-tools-contract static: PASS (registration, settings, dispatch, safety guards, runtime/client contracts)",
  );
  process.exit(0);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--port=49683"],
  stderr: "pipe",
});
const client = new Client({ name: "agent-tools-contract", version: "1.0.0" });
await client.connect(transport);
try {
  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of tools) assert.equal(byName.has(name), true, `${name} not exposed over MCP`);

  for (const name of [
    "task_context_bundle",
    "change_impact_report",
    "code_health_report",
    "plan_script_patchset",
    "wait_for_state",
    "scene_analysis_snapshot",
    "capture_script_profile",
  ]) {
    assert.equal(
      byName.get(name)?.annotations?.readOnlyHint,
      true,
      `${name} missing readOnlyHint`,
    );
  }
  assert.equal(byName.get("apply_script_patchset")?.annotations?.destructiveHint, true);
  assert.equal(byName.get("client_input_sequence")?.annotations?.readOnlyHint, false);
  assert.equal(
    byName.get("plan_script_patchset")?.annotations?.idempotentHint,
    false,
    "plan creation mutates the bounded token store and is not idempotent",
  );

  const missingConfirm = await client.callTool({
    name: "apply_script_patchset",
    arguments: { token: "00000000-0000-4000-8000-000000000000", confirm: false },
  });
  assert.equal(missingConfirm.isError, true);
  assert.match(
    missingConfirm.content.map((entry) => entry.text ?? "").join("\n"),
    /requires confirm:true/,
  );

  const tooManySteps = await client.callTool({
    name: "client_input_sequence",
    arguments: {
      steps: Array.from({ length: 41 }, () => ({ kind: "wait", seconds: 0 })),
    },
  });
  assert.equal(tooManySteps.isError, true, "input flow cap must reject before Studio");

  const emptyReplace = await client.callTool({
    name: "plan_script_patchset",
    arguments: {
      patches: [
        {
          path: "ServerScriptService.Main",
          operations: [{ kind: "replace", oldText: "", newText: "x" }],
        },
      ],
    },
  });
  assert.equal(emptyReplace.isError, true, "empty literal anchor must reject before Studio");
} finally {
  await client.close();
}

console.log(
  "agent-tools-contract: PASS (9 tools, settings/write parity, annotations, dispatch, rollback, input and schema guards)",
);
