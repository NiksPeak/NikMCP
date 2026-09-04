import assert from "node:assert/strict";
import {
  applyScriptPatchOperations,
  buildScriptPatchItems,
  ScriptPatchPlanStore,
} from "../dist/script-patchset.js";

const original = "local a = 1\r\nlocal b = 2\r\nreturn a + b\r\n";
const patched = applyScriptPatchOperations("ReplicatedStorage.Math", original, [
  { kind: "replace", oldText: "local b = 2", newText: "local b = 3" },
  { kind: "replace_lines", startLine: 3, endLine: 3, newText: "return a * b" },
]);
assert.equal(patched, "local a = 1\nlocal b = 3\nreturn a * b\n");

assert.throws(
  () =>
    applyScriptPatchOperations("ReplicatedStorage.Math", original, [
      { kind: "replace", oldText: "missing", newText: "x" },
    ]),
  /expected 1 literal match\(es\), found 0/,
);
assert.throws(
  () =>
    applyScriptPatchOperations("ReplicatedStorage.Math", original, [
      { kind: "replace_lines", startLine: 9, endLine: 9, newText: "x" },
    ]),
  /invalid line range/,
);

const items = buildScriptPatchItems(
  [
    {
      path: "ReplicatedStorage.Math",
      operations: [{ kind: "full_source", source: patched }],
    },
  ],
  new Map([["ReplicatedStorage.Math", original]]),
);
assert.equal(items.length, 1);
assert.equal(items[0].beforeHash, "6017252f");
assert.equal(items[0].changed, true);
assert.match(items[0].diff, /-local b = 2/);
assert.match(items[0].diff, /\+local b = 3/);

assert.throws(
  () =>
    buildScriptPatchItems(
      [
        { path: "A", operations: [{ kind: "full_source", source: "a" }] },
        { path: "A", operations: [{ kind: "full_source", source: "b" }] },
      ],
      new Map([["A", "old"]]),
    ),
  /duplicate patch path/,
);
assert.throws(
  () =>
    buildScriptPatchItems(
      [{ path: "Huge", operations: [{ kind: "full_source", source: "x".repeat(1_000_001) }] }],
      new Map([["Huge", "old"]]),
    ),
  /1,000,000-byte cap/,
);

const store = new ScriptPatchPlanStore(1000, 2);
const first = store.create("target-a", items, 1000);
assert.equal(store.size, 1);
assert.throws(() => store.consume(first.token, "target-b", 1100), /bound to Studio target/);
assert.equal(store.consume(first.token, "target-a", 1100).token, first.token);
assert.equal(store.size, 0);
assert.throws(() => store.consume(first.token, "target-a", 1100), /unknown, expired, or already used/);

const expired = store.create("target-a", items, 2000);
assert.throws(() => store.consume(expired.token, "target-a", 3001), /unknown, expired, or already used/);

console.log("script-patchset-unit: PASS");
