// v0.2.0 contract: registration/settings/gate/dispatch parity for the new tools
// plus the runtime/edit poller hardening markers, then (unless --static-only)
// a real MCP stdio session proving schema-level guards reject BEFORE Studio.
//   node tests/v020-contract.mjs [--static-only]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcp = readFileSync("src/mcp-server.ts", "utf8");
const bridge = readFileSync("src/bridge.ts", "utf8");
const nodeSettings = readFileSync("src/settings.ts", "utf8");
const pluginSettings = readFileSync("plugin/src/Settings.luau", "utf8");
const executor = readFileSync("plugin/src/Executor.luau", "utf8");
const runtime = readFileSync("plugin/src/RuntimeAgentSource.luau", "utf8");
const clientSource = readFileSync("plugin/src/ClientAgentSource.luau", "utf8");
const pluginEntry = readFileSync("plugin/src/init.server.luau", "utf8");
const luauGate = readFileSync("src/luau-gate.ts", "utf8");

const NEW_TOOLS = [
  "edit_script",
  "list_script_backups",
  "restore_script_backup",
  "get_luau_job",
  "run_harness",
  "server_query",
  "client_activate",
  "reconcile_manifest",
];
const NEW_WRITE_TOOLS = ["edit_script", "run_harness", "reconcile_manifest", "client_activate", "restore_script_backup"];

for (const name of NEW_TOOLS) {
  assert.match(mcp, new RegExp(`"${name}"`), `${name} missing from MCP registration`);
  assert.match(pluginSettings, new RegExp(`name = "${name}"`), `${name} missing from Studio settings catalog`);
}
for (const name of NEW_WRITE_TOOLS) {
  assert.match(nodeSettings, new RegExp(`"${name}"`), `${name} missing from WRITE_TOOLS`);
}
for (const name of ["list_script_backups", "get_luau_job", "server_query"]) {
  assert.doesNotMatch(nodeSettings, new RegExp(`"${name}"`), `${name} must stay a read tool`);
}

// Every Settings.luau catalog name must be registered server-side (no dead toggles).
for (const m of pluginSettings.matchAll(/name = "([a-z_0-9]+)"/g)) {
  assert.match(mcp, new RegExp(`"${m[1]}"`), `Settings.luau lists ${m[1]} but the server does not register it`);
}

// Node-side contracts
assert.match(mcp, /version: "0\.2\.0"/, "MCP handshake version must be 0.2.0");
assert.match(mcp, /applyExactReplace\(/);
assert.match(mcp, /applyUnifiedPatch\(/);
assert.match(mcp, /gateAs: "edit_script"/, "edit_script must ride the drift-safe transaction under its own gate");
assert.match(mcp, /expectedHash: beforeHash/, "edit_script write must be hash-checked");
assert.match(mcp, /backupScriptBeforeWrite\(path, "write_script"\)/);
assert.match(mcp, /backupScriptsBeforeWrite\(items\.map\(\(it\) => it\.path\), "import_scripts"\)/);
assert.match(mcp, /backupScriptsBeforeWrite\(plan\.items\.map\(\(item\) => item\.path\), "apply_script_patchset"\)/);
assert.match(mcp, /sliceLines\(res\.source, startLine, lineCount, maxBytes\)/);
assert.match(mcp, /sameIgnoringWhitespace\(studioSrc, diskSrc\)/, "sync status must detect whitespace-only conflicts");
assert.match(mcp, /force && !paths/, "import force requires a paths allowlist");
assert.match(mcp, /isProtectedSyncPath\(/);
assert.match(mcp, /phase === "starting"/, "playtest status must expose a starting phase");
assert.match(mcp, /ignoreInfo/, "lint gate must expose ignoreInfo");
assert.match(mcp, /"attributes_prefix"/);
assert.match(mcp, /doneAttribute \?\? `\$\{input\.resultPrefix\}_Done`/);
assert.match(mcp, /pinPattern/);
assert.match(mcp, /storeLuauJob\(/);
assert.match(luauGate, /infos: Diagnostic\[\]/);
assert.match(bridge, /req\.query\.busy === "1"/, "bridge must honor busy polls");
assert.match(bridge, /wouldAcceptTargetId\(targetId/, "heartbeat must be lease-aware");
assert.match(bridge, /base\.tokenOk = checkAuth/);
assert.match(bridge, /payload\?\.name === "activate_gui"/, "cross-port client activation must gate as client_activate");

// Plugin-side contracts
assert.match(pluginEntry, /busy: boolean/);
assert.match(pluginEntry, /if conn\.busy then "&busy=1" else ""/, "edit poller must keep polling while a command executes");
assert.match(pluginEntry, /task\.spawn\(function\(\)\s*\n\s*local result\s*\n\s*local startClock/, "edit commands must execute off the poll thread");
assert.match(pluginEntry, /AGENT_SOURCE_VERSION = "2026-09-03-v0\.2\.0/, "runtime source version must be bumped so stale agents refresh");
assert.match(runtime, /\/heartbeat\?context=" \.\. CONTEXT \.\. "&targetId="/, "runtime agent must probe with its target id");
assert.match(runtime, /info\.exact/);
assert.match(runtime, /rejectedUntil\[lane\.port\] = os\.clock\(\) \+ REJECT_COOLDOWN/, "409/401 must park the port");
assert.match(runtime, /lane\.lastStatus == 409 or lane\.lastStatus == 401 or lane\.lastStatus == 400/);
assert.match(runtime, /if lane\.busy then "&busy=1" else ""/);
// multi-lane agent: one poll lane per McpAgentPorts entry, per-lane output cursors
assert.match(runtime, /script:GetAttribute\("McpAgentPorts"\)/);
assert.match(runtime, /table\.insert\(lanes, newLane\(port\)\)/);
assert.match(runtime, /drained = \{ server = 0, client = 0, pinned = 0 \}/, "each lane drains output independently");
assert.match(runtime, /pcall\(execute, cmd, lane\)/);
assert.match(pluginEntry, /agent:SetAttribute\("McpAgentPorts", agentPortsCsv\(\)\)/, "edit plugin must stamp the served ports");
assert.match(pluginEntry, /status\.onToggleAgentPort = function/);
assert.match(readFileSync("plugin/src/StatusWidget.luau", "utf8"), /function StatusWidget:setAgentPorts/);
assert.match(runtime, /pinnedRing/);
assert.match(runtime, /McpPinPattern/);
assert.match(runtime, /CONSOLE_RING_CAP = 2000/);
assert.match(runtime, /cmd\.type == "client_activate"/);
assert.match(runtime, /relayClientQuery\("activate_gui", p, 12\)/);
assert.match(runtime, /poll HTTP status/, "poll status error text must be preserved for diagnostics");
assert.match(clientSource, /name == "activate_gui"/);
assert.match(clientSource, /inst\.Activated:Connect/, "activation must be evidenced by the Activated signal");
assert.match(clientSource, /GuiService\.SelectedObject = inst/);
assert.match(clientSource, /Enum\.KeyCode\.ButtonA/);
assert.match(executor, /PLAYTEST_CAP = 3000/);
assert.match(executor, /"McpPinPattern"/);

if (process.argv.includes("--static-only")) {
  console.log("v020-contract static: PASS (registration, settings, gates, poller/agent/client markers)");
  process.exit(0);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--port=49691"],
  stderr: "pipe",
});
const client = new Client({ name: "v020-contract", version: "1.0.0" });
await client.connect(transport);
try {
  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of NEW_TOOLS) assert.equal(byName.has(name), true, `${name} not exposed over MCP`);
  assert.ok(listed.tools.length >= 164, `expected >= 164 tools, got ${listed.tools.length}`);
  assert.equal(byName.get("server_query")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("list_script_backups")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("edit_script")?.annotations?.destructiveHint, true);
  assert.equal(byName.get("restore_script_backup")?.annotations?.destructiveHint, true);

  const text = (r) => r.content.map((entry) => entry.text ?? "").join("\n");

  // edit_script: mode validation happens before any Studio round-trip
  let r = await client.callTool({ name: "edit_script", arguments: { path: "ServerScriptService.X" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /exactly one edit mode/);
  r = await client.callTool({
    name: "edit_script",
    arguments: { path: "ServerScriptService.X", oldString: "a", newString: "b", patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
  });
  assert.equal(r.isError, true);
  assert.match(text(r), /exactly one edit mode/);
  r = await client.callTool({
    name: "edit_script",
    arguments: { path: "ServerScriptService.MCP_RuntimeAgent", oldString: "a", newString: "b" },
  });
  assert.equal(r.isError, true);
  assert.match(text(r), /bridge-managed/);

  // write_script: source XOR sourceFile, protected path refused
  r = await client.callTool({ name: "write_script", arguments: { path: "ServerScriptService.X" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /exactly one of source or sourceFile/);
  r = await client.callTool({ name: "write_script", arguments: { path: "ServerScriptService.X", sourceFile: "Z:/definitely/missing.luau" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /sourceFile unreadable/);

  // restore_script_backup: confirm + unknown backup
  r = await client.callTool({ name: "restore_script_backup", arguments: { path: "ServerScriptService.X" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /requires confirm:true/);
  r = await client.callTool({ name: "list_script_backups", arguments: {} });
  assert.equal(r.isError ?? false, false);
  assert.match(text(r), /"count": 0/);

  // get_luau_job: unknown id, empty list
  r = await client.callTool({ name: "get_luau_job", arguments: { jobId: "nope" } });
  assert.equal(r.isError, true);
  r = await client.callTool({ name: "get_luau_job", arguments: {} });
  assert.match(text(r), /"jobs": \[\]/);

  // get_playtest_output: invalid regex rejected Node-side
  r = await client.callTool({ name: "get_playtest_output", arguments: { pattern: "(" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /invalid pattern/);

  // run_harness / server_query / client_activate: refuse without a live runtime agent
  r = await client.callTool({ name: "server_query", arguments: { name: "attributes", path: "Workspace" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /requires a running playtest/);
  r = await client.callTool({ name: "client_activate", arguments: { path: "Gui.Button" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /requires a running F5/);
  r = await client.callTool({ name: "run_harness", arguments: { resultPrefix: "SF", outputPattern: "(" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /invalid outputPattern/);

  // import_scripts: force without paths is refused before any disk/Studio access
  r = await client.callTool({ name: "import_scripts", arguments: { dir: "Z:/nowhere", force: true } });
  assert.equal(r.isError, true);
  assert.match(text(r), /force:true requires an explicit paths allowlist/);

  // reconcile_manifest: no manifest -> clear error
  r = await client.callTool({ name: "reconcile_manifest", arguments: { dir: "Z:/nowhere" } });
  assert.equal(r.isError, true);
} finally {
  await client.close();
}

console.log("v020-contract: PASS (static markers + MCP stdio guards for the 8 new tools)");
