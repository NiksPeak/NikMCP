import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeLuau, luauGateReady, startLuauGate } from "../dist/luau-gate.js";

startLuauGate({});
assert.equal(await luauGateReady(30000), true, "luau-lsp gate did not become ready");

const sources = [
  ["AssetGuardTools", readFileSync("plugin/src/AssetGuardTools.luau", "utf8")],
  ["QATools", readFileSync("plugin/src/QATools.luau", "utf8")],
  ["EnvironmentTools", readFileSync("plugin/src/EnvironmentTools.luau", "utf8")],
  ["AgentTools", readFileSync("plugin/src/AgentTools.luau", "utf8")],
];
for (const file of ["RuntimeAgentSource", "ClientAgentSource"]) {
  const wrapper = readFileSync(`plugin/src/${file}.luau`, "utf8");
  const match = wrapper.match(/local SOURCE = \[==\[\r?\n([\s\S]*?)\r?\n\]==\]/);
  assert.ok(match, `${file} source wrapper missing`);
  sources.push([file, match[1].replaceAll("{{PORT}}", "58741")]);
}

const results = await Promise.all(
  sources.map(async ([name, source]) => [name, await analyzeLuau(source)]),
);
for (const [name, result] of results) {
  assert.equal(
    result.ok,
    true,
    `${name} compile gate failed: ${JSON.stringify(result.errors, null, 2)}`,
  );
}

console.log("qa-luau-compile: PASS (asset guard, device QA, environment, agent tools, runtime agent, client agent)");
