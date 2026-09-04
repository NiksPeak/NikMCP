import assert from "node:assert/strict";
import {
  analyzeCodeHealth,
  buildChangeImpact,
  buildTaskContext,
} from "../dist/agent-analysis.js";
import { fnv1a32 } from "../dist/sync.js";

const scripts = [
  {
    path: "ServerScriptService.Main",
    className: "Script",
    source: [
      "-- TODO: remove legacy scheduling",
      "_G.wait(1)",
      "spawn(function() end)",
      "local module = require(123456)",
      "Store:SetAsync('profile', data)",
      "Remote:InvokeClient(player)",
      "local text = 'loadstring() wait() require(999)'",
      "-- getfenv() in a comment is not executable",
    ].join("\n"),
  },
  {
    path: "ReplicatedStorage.Shared.CopyA",
    className: "ModuleScript",
    source: "return {\r\n  value = 1\r\n}\r\n",
  },
  {
    path: "ReplicatedStorage.Shared.CopyB",
    className: "ModuleScript",
    source: "return {\n  value = 1\n}\n",
  },
  {
    path: "ReplicatedStorage.Shared.NotExact",
    className: "ModuleScript",
    source: "return {\n  value = 1 \n}\n",
  },
];

const health = analyzeCodeHealth(scripts, { largeScriptChars: 1_000, largeScriptLines: 50 });
assert.equal(health.duplicates.length, 1);
assert.deepEqual(health.duplicates[0].paths, [
  "ReplicatedStorage.Shared.CopyA",
  "ReplicatedStorage.Shared.CopyB",
]);
assert.equal(health.duplicates[0].confidence, "exact");
assert.equal(health.duplicates[0].totalMembers, 2);
assert.equal(
  health.duplicates[0].hash,
  fnv1a32("return {\n  value = 1\n}\n"),
  "ASCII duplicate hashes must use the repository UTF-8 FNV implementation",
);
assert.equal(
  health.findings.some(
    (finding) => finding.category === "numeric_require" && finding.confidence === "exact",
  ),
  true,
);
assert.equal(
  health.findings.some(
    (finding) => finding.category === "deprecated_global_wait" && finding.confidence === "exact",
  ),
  true,
);
assert.equal(
  health.findings.some(
    (finding) => finding.category === "deprecated_global_spawn" && finding.confidence === "heuristic",
  ),
  true,
);
assert.equal(
  health.findings.filter((finding) => finding.category === "numeric_require").length,
  1,
  "numeric require inside a string must not be classified",
);
assert.equal(
  health.findings.some((finding) => finding.category === "environment_access_getfenv"),
  false,
  "global-like text inside comments must not be classified",
);

const noFalseExact = analyzeCodeHealth([
  {
    path: "ServerScriptService.FalsePositives",
    source: [
      "task.wait(1)",
      "object.wait(1)",
      "local text = '_G.wait(1)'",
      "-- _G.wait(1)",
      "local function wait(seconds) return seconds end",
      "wait(1)",
    ].join("\n"),
  },
]);
assert.equal(
  noFalseExact.findings.some(
    (finding) => finding.category === "deprecated_global_wait" && finding.confidence === "exact",
  ),
  false,
  "method, string, comment, definition, and possibly-shadowed calls must not become exact findings",
);
assert.equal(
  noFalseExact.findings.filter((finding) => finding.category === "deprecated_global_wait").length,
  1,
);

const deterministicA = analyzeCodeHealth(scripts);
const deterministicB = analyzeCodeHealth([...scripts].reverse());
assert.deepEqual(deterministicA, deterministicB, "health output must not depend on input order");

const unicodeDuplicateSource = "return 'Cafe\u0301 \ud83c\udf31'\n";
const unicodeDuplicates = analyzeCodeHealth([
  { path: "ReplicatedStorage.UnicodeA", source: unicodeDuplicateSource },
  { path: "ReplicatedStorage.UnicodeB", source: unicodeDuplicateSource },
]);
assert.equal(unicodeDuplicates.duplicates.length, 1);
assert.equal(
  unicodeDuplicates.duplicates[0].hash,
  fnv1a32(unicodeDuplicateSource),
  "non-ASCII duplicate hashes must use UTF-8 byte parity with sync.ts and Studio",
);

const caseSensitiveDuplicates = analyzeCodeHealth([
  { path: "ReplicatedStorage.Foo", source: "return 'same'\n" },
  { path: "ReplicatedStorage.foo", source: "return 'same'\n" },
]);
assert.deepEqual(caseSensitiveDuplicates.duplicates[0].paths, [
  "ReplicatedStorage.foo",
  "ReplicatedStorage.Foo",
]);
assert.equal(
  caseSensitiveDuplicates.duplicates[0].totalMembers,
  2,
  "paths that differ only by case must coexist as distinct duplicate members",
);

const capped = analyzeCodeHealth(
  Array.from({ length: 8 }, (_, index) => ({
    path: `ServerScriptService.Cap${index}`,
    source: "-- TODO\n_G.wait(1)\n".repeat(20),
  })),
  {
    maxScripts: 3,
    maxTotalSourceChars: 80,
    maxSourceCharsPerScript: 50,
    maxFindings: 2,
  },
);
assert.equal(capped.summary.scriptsScanned, 3);
assert.equal(capped.summary.sourceCharsProcessed, 80);
assert.equal(capped.summary.sourceTruncatedScripts > 0, true);
assert.equal(capped.findings.length, 2);
assert.equal(capped.summary.findingsTruncated, true);

const contextScripts = [
  {
    path: "ServerScriptService.RoundService",
    source: "local Rewards = require(game.ReplicatedStorage.Shared.Rewards)\nreturn {}",
  },
  {
    path: "ReplicatedStorage.Shared.Rewards",
    source: "local COIN_REWARD = 25\nreturn function() return COIN_REWARD end",
  },
  {
    path: "StarterPlayer.StarterPlayerScripts.RewardClient",
    source: "RewardRemote.OnClientEvent:Connect(function(coins) end)",
  },
  {
    path: "ServerScriptService.Unrelated",
    source: "return function() print('weather') end",
  },
];
const requireGraph = {
  "ServerScriptService.RoundService": ["ReplicatedStorage.Shared.Rewards"],
};
const remoteInventory = {
  remotes: [
    {
      name: "RewardRemote",
      className: "RemoteEvent",
      path: "ReplicatedStorage.Remotes.RewardRemote",
      usages: [
        { script: "ServerScriptService.RoundService" },
        { script: "StarterPlayer.StarterPlayerScripts.RewardClient" },
      ],
    },
  ],
};
const datastoreInventory = {
  stores: [
    {
      name: "PlayerProfiles",
      className: "DataStore",
      declaredIn: [{ script: "ServerScriptService.RoundService" }],
      operations: [{ script: "ReplicatedStorage.Shared.Rewards" }],
    },
  ],
};
const context = buildTaskContext(
  "coin reward",
  ["ServerScriptService.RoundService"],
  contextScripts,
  requireGraph,
  remoteInventory,
  datastoreInventory,
);
assert.equal(context.scripts[0].path, "ServerScriptService.RoundService");
const reward = context.scripts.find((script) => script.path === "ReplicatedStorage.Shared.Rewards");
assert.ok(reward, "query match and require neighbor must be ranked");
assert.equal(
  reward.reasons.some((reason) => reason.includes("direct dependency")),
  true,
);
const client = context.scripts.find(
  (script) => script.path === "StarterPlayer.StarterPlayerScripts.RewardClient",
);
assert.ok(client, "remote peer of a seed must be ranked");
assert.equal(client.reasons.some((reason) => reason.includes("shares remote")), true);
assert.equal(reward.neighbors.datastores[0].name, "PlayerProfiles");

const literalRegexQuery = buildTaskContext(".*", [], [
  { path: "ServerScriptService.ActualLiteral", source: "local marker = '.*'" },
  { path: "ServerScriptService.WouldMatchRegex", source: "anything at all" },
]);
assert.deepEqual(
  literalRegexQuery.scripts.map((script) => script.path),
  ["ServerScriptService.ActualLiteral"],
  "regex-like query input must be treated as a literal string",
);

const contextDeterministic = buildTaskContext(
  "coin reward",
  ["ServerScriptService.RoundService"],
  [...contextScripts].reverse(),
  { result: { edges: [{ from: "ServerScriptService.RoundService", to: "ReplicatedStorage.Shared.Rewards" }] } },
  { result: remoteInventory },
  datastoreInventory,
);
assert.deepEqual(context, contextDeterministic);

const casePaths = [
  { path: "ReplicatedStorage.Foo", source: "return 'upper'" },
  { path: "ReplicatedStorage.foo", source: "return 'lower'" },
  { path: "ServerScriptService.ConsumerFoo", source: "return require(game.ReplicatedStorage.Foo)" },
  { path: "ServerScriptService.Consumerfoo", source: "return require(game.ReplicatedStorage.foo)" },
];
const caseGraph = {
  "ServerScriptService.ConsumerFoo": ["ReplicatedStorage.Foo"],
  "ServerScriptService.Consumerfoo": ["ReplicatedStorage.foo"],
};
const upperContext = buildTaskContext(
  "",
  ["ReplicatedStorage.Foo"],
  casePaths,
  caseGraph,
);
assert.equal(
  upperContext.scripts.some((script) => script.path === "ServerScriptService.ConsumerFoo"),
  true,
  "exact-case graph edges must route to the exact target",
);
assert.equal(
  upperContext.scripts.some((script) => script.path === "ServerScriptService.Consumerfoo"),
  false,
  "case-distinct graph edges must not leak into one another",
);

const upperImpact = buildChangeImpact("ReplicatedStorage.Foo", casePaths, caseGraph);
assert.deepEqual(upperImpact.dependents.direct, ["ServerScriptService.ConsumerFoo"]);
assert.equal(upperImpact.target.foundInScripts, true);
const lowerImpact = buildChangeImpact("ReplicatedStorage.foo", casePaths, caseGraph);
assert.deepEqual(lowerImpact.dependents.direct, ["ServerScriptService.Consumerfoo"]);
const ambiguousImpact = buildChangeImpact("REPLICATEDSTORAGE.FOO", casePaths, caseGraph);
assert.equal(
  ambiguousImpact.target.foundInScripts,
  false,
  "case-insensitive lookup must refuse an ambiguous path",
);
assert.deepEqual(ambiguousImpact.dependents.direct, []);

const cappedContext = buildTaskContext(
  "shared",
  [],
  Array.from({ length: 10 }, (_, index) => ({
    path: `ReplicatedStorage.Shared.Module${index}`,
    source: "return 'shared'",
  })),
  undefined,
  undefined,
  undefined,
  { maxResults: 3 },
);
assert.equal(cappedContext.scripts.length, 3);
assert.equal(cappedContext.summary.resultsTruncated, true);

const boundedContextInputs = buildTaskContext(
  "x".repeat(100),
  Array.from({ length: 10 }, (_, index) => `Seed${index}`),
  [{ path: "Seed0", source: "return true" }],
  undefined,
  undefined,
  undefined,
  { maxQueryChars: 8, maxSeedPaths: 3 },
);
assert.equal(boundedContextInputs.summary.query.length, 8);
assert.equal(boundedContextInputs.summary.queryTruncated, true);
assert.equal(boundedContextInputs.summary.seedPaths.length, 3);
assert.equal(boundedContextInputs.summary.seedPathsTruncated, true);

const cycleGraph = {
  "ReplicatedStorage.A": ["ReplicatedStorage.B"],
  "ReplicatedStorage.B": ["ReplicatedStorage.C"],
  "ReplicatedStorage.C": ["ReplicatedStorage.A"],
  "ServerScriptService.Consumer": ["ReplicatedStorage.A"],
};
const impactScripts = [
  { path: "ReplicatedStorage.A", source: "return require(script.Parent.B)" },
  { path: "ReplicatedStorage.B", source: "return require(script.Parent.C)" },
  { path: "ReplicatedStorage.C", source: "return require(script.Parent.A)" },
  {
    path: "ServerScriptService.Consumer",
    source: "local modulePath = 'ReplicatedStorage.A'\nlocal A = require(game.ReplicatedStorage.A)",
  },
  { path: "StarterPlayer.Client", source: "local A = game.ReplicatedStorage.A" },
];
const impact = buildChangeImpact(
  "replicatedstorage.a",
  impactScripts,
  cycleGraph,
  [{ name: "StateRemote", paths: ["ReplicatedStorage.A", "StarterPlayer.Client"] }],
  [{ name: "StateStore", paths: ["ReplicatedStorage.A", "ServerScriptService.Consumer"] }],
);
assert.equal(impact.target.resolvedPath, "ReplicatedStorage.A");
assert.equal(impact.summary.graphCycleDetected, true);
assert.deepEqual(impact.dependencies.direct, ["ReplicatedStorage.B"]);
assert.equal(
  impact.dependencies.transitive.some((node) => node.path === "ReplicatedStorage.C"),
  true,
);
assert.equal(
  impact.dependents.direct.includes("ServerScriptService.Consumer"),
  true,
);
assert.equal(
  impact.literalReferences.some(
    (reference) =>
      reference.path === "ServerScriptService.Consumer" &&
      reference.confidence === "exact" &&
      reference.matched === "full_path",
  ),
  true,
);
assert.equal(impact.remotePeers[0].peers.includes("StarterPlayer.Client"), true);
assert.equal(impact.datastorePeers[0].peers.includes("ServerScriptService.Consumer"), true);
assert.equal(impact.risk.score >= 25, true);
assert.equal(impact.recommendations.length > 0, true);
assert.equal(impact.dependencies.transitive.length < 10, true, "cycles must terminate");

const impactDeterministic = buildChangeImpact(
  "replicatedstorage.a",
  [...impactScripts].reverse(),
  cycleGraph,
  [{ name: "StateRemote", paths: ["StarterPlayer.Client", "ReplicatedStorage.A"] }],
  [{ name: "StateStore", paths: ["ServerScriptService.Consumer", "ReplicatedStorage.A"] }],
);
assert.deepEqual(impact, impactDeterministic);

const cappedImpact = buildChangeImpact(
  "ReplicatedStorage.Root",
  [
    { path: "ReplicatedStorage.Root", source: "return {}" },
    ...Array.from({ length: 12 }, (_, index) => ({
      path: `ServerScriptService.Ref${index}`,
      source: "local target = 'ReplicatedStorage.Root'",
    })),
  ],
  Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `ServerScriptService.Ref${index}`,
      ["ReplicatedStorage.Root"],
    ]),
  ),
  undefined,
  undefined,
  { maxGraphNodes: 3, maxLiteralReferences: 2 },
);
assert.equal(cappedImpact.dependents.direct.length, 3);
assert.equal(cappedImpact.dependents.truncated, true);
assert.equal(cappedImpact.literalReferences.length, 2);
assert.equal(cappedImpact.summary.literalReferencesTruncated, true);

const incompleteImpact = buildChangeImpact(
  "ReplicatedStorage.Root",
  [{ path: "ReplicatedStorage.Root", source: "return {}" }],
  [],
  [],
  [],
  {
    inputCompleteness: {
      scripts: { state: "complete", returned: 1, totalAvailable: 1 },
      requireGraph: { state: "truncated", returned: 0, reason: "edge cap reached" },
      remoteInventory: { state: "unknown", reason: "scan unavailable" },
      datastoreInventory: { state: "complete", returned: 0 },
    },
  },
);
assert.equal(incompleteImpact.summary.inputCompleteness.overall, "partial");
assert.equal(incompleteImpact.risk.score >= 25, true);
assert.notEqual(incompleteImpact.risk.level, "low");
assert.equal(
  incompleteImpact.risk.factors.some((factor) => factor.includes("input evidence is partial")),
  true,
);
assert.equal(
  incompleteImpact.risk.factors.includes("no supplied dependency or contract fan-out"),
  false,
);

const incompleteContext = buildTaskContext(
  "root",
  [],
  [{ path: "ReplicatedStorage.Root", source: "return {}" }],
  [],
  [],
  [],
  {
    inputCompleteness: {
      scripts: { state: "truncated", returned: 1, totalAvailable: 3 },
      requireGraph: { state: "complete", returned: 0 },
    },
  },
);
assert.equal(incompleteContext.summary.inputCompleteness.overall, "partial");

console.log(
  "agent-analysis-unit: PASS (determinism, caps, case-safe paths, UTF-8 hashes, completeness, cycles, impact)",
);
