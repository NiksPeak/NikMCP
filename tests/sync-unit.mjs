// Self-check: task 25 sync logic (hashing, mapping, drift classification,
// manifest, diff). Pure Node, offline, no Studio. Run after `npm run build`:
//   node tests/sync-unit.mjs
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fnv1a32,
  normalizeSource,
  sanitizeName,
  planExport,
  readManifest,
  writeManifestAtomic,
  readDiskSource,
  findUnknownFiles,
  classify,
  decideImport,
  unifiedDiff,
  MANIFEST_NAME,
} from "../dist/sync.js";

let n = 0;
function check(name, fn) {
  n++;
  fn();
  console.log(`  ok ${n}: ${name}`);
}

// --- FNV-1a 32-bit: known vectors (SAME vectors are in a comment next to the
// Luau impl in plugin/src/Executor.luau for eyeball verification) -------------
check("fnv1a32 test vectors", () => {
  assert.strictEqual(fnv1a32(""), "811c9dc5");
  assert.strictEqual(fnv1a32("a"), "e40c292c");
  assert.strictEqual(fnv1a32("hello"), "4f9f2cab");
  assert.strictEqual(fnv1a32("foobar"), "bf9cf968");
});

// --- CRLF normalization -> identical hash -------------------------------------
check("CRLF and LF sources hash identically after normalization", () => {
  const lf = "local x = 1\nprint(x)\n";
  const crlf = "local x = 1\r\nprint(x)\r\n";
  assert.strictEqual(fnv1a32(normalizeSource(crlf)), fnv1a32(normalizeSource(lf)));
  assert.notStrictEqual(fnv1a32(crlf), fnv1a32(lf)); // proves normalization matters
});

// --- filename sanitization -----------------------------------------------------
check("filename sanitization strips forbidden chars, empty -> _", () => {
  assert.strictEqual(sanitizeName('a<b>:c"d/e\\f|g?h*i'), "abcdefghi");
  assert.strictEqual(sanitizeName("  spaced  "), "spaced");
  assert.strictEqual(sanitizeName('???'), "_");
});

// --- disk mapping ---------------------------------------------------------------
function entry(path, className, hasChildren = false) {
  return { path, className, hash: "00000000", hasChildren };
}

check("mapping: extensions by className", () => {
  const plan = planExport([
    entry("ServerScriptService.Main", "Script"),
    entry("StarterGui.UI", "LocalScript"),
    entry("ReplicatedStorage.Util", "ModuleScript"),
  ]);
  const rels = plan.files.map((f) => f.relPath).sort();
  assert.deepStrictEqual(rels, [
    "ReplicatedStorage/Util.luau",
    "ServerScriptService/Main.server.luau",
    "StarterGui/UI.client.luau",
  ]);
});

check("mapping: script with script-children becomes init folder", () => {
  const plan = planExport([
    entry("ServerScriptService.Main", "Script", true),
    entry("ServerScriptService.Main.Helper", "ModuleScript"),
  ]);
  const rels = plan.files.map((f) => f.relPath).sort();
  assert.deepStrictEqual(rels, [
    "ServerScriptService/Main/Helper.luau",
    "ServerScriptService/Main/init.server.luau",
  ]);
});

check("mapping: non-script containers become plain folders", () => {
  const plan = planExport([entry("ReplicatedStorage.Modules.Deep.Util", "ModuleScript")]);
  assert.deepStrictEqual(
    plan.files.map((f) => f.relPath),
    ["ReplicatedStorage/Modules/Deep/Util.luau"]
  );
});

check("mapping: sanitization collisions get stable __2 suffix", () => {
  const plan = planExport([
    entry("ReplicatedStorage.a?b", "ModuleScript"),
    entry("ReplicatedStorage.a*b", "ModuleScript"),
  ]);
  const rels = plan.files.map((f) => f.relPath).sort();
  assert.deepStrictEqual(rels, ["ReplicatedStorage/ab.luau", "ReplicatedStorage/ab__2.luau"]);
});

check("mapping: duplicate sibling paths -> first exported, rest reported", () => {
  const plan = planExport([
    entry("Workspace.Twin", "ModuleScript"),
    entry("Workspace.Twin", "ModuleScript"),
  ]);
  assert.strictEqual(plan.files.length, 1);
  assert.deepStrictEqual(plan.duplicates, [{ path: "Workspace.Twin", count: 2 }]);
});

// --- drift classification: full 2x2 + missing + convergent ------------------------
check("classify: full matrix", () => {
  const M = "aaaa1111";
  assert.strictEqual(classify(M, M, M), "clean");
  assert.strictEqual(classify(M, "d1ff0000", M), "diskAhead");
  assert.strictEqual(classify(M, M, "57ud0000"), "studioAhead");
  assert.strictEqual(classify(M, "d1ff0000", "57ud0000"), "conflict");
  assert.strictEqual(classify(M, "same0000", "same0000"), "clean"); // convergent edit
  assert.strictEqual(classify(M, "d1ff0000", null), "missingInStudio");
  assert.strictEqual(classify(M, null, M), "missingOnDisk");
  assert.strictEqual(classify(M, null, null), "missingInStudio");
});

// --- decideImport: conflict -> abort-all semantics ---------------------------------
check("decideImport: any conflict aborts everything", () => {
  const rows = [
    { relPath: "a.luau", dataModelPath: "W.a", className: "Script", state: "diskAhead" },
    { relPath: "b.luau", dataModelPath: "W.b", className: "Script", state: "conflict" },
    { relPath: "c.luau", dataModelPath: "W.c", className: "Script", state: "studioAhead" },
  ];
  const d = decideImport(rows);
  assert.strictEqual(d.action, "abort");
  assert.strictEqual(d.conflicts.length, 1);
  assert.strictEqual(d.apply.length, 1); // still listed, but action=abort gates it
});

check("decideImport: studioAhead and missing never block", () => {
  const rows = [
    { relPath: "a.luau", dataModelPath: "W.a", className: "Script", state: "diskAhead" },
    { relPath: "b.luau", dataModelPath: "W.b", className: "Script", state: "studioAhead" },
    { relPath: "c.luau", dataModelPath: "W.c", className: "Script", state: "missingInStudio" },
    { relPath: "d.luau", dataModelPath: "W.d", className: "Script", state: "missingOnDisk" },
  ];
  const d = decideImport(rows);
  assert.strictEqual(d.action, "proceed");
  assert.deepStrictEqual(d.apply.map((r) => r.relPath), ["a.luau"]);
  assert.strictEqual(d.skippedStudioAhead.length, 1);
  assert.strictEqual(d.missing.length, 2);
});

// --- unified diff (whitespace-normalized) --------------------------------------------
check("unifiedDiff: tabs expanded + CRLF normalized, changed middle only", () => {
  const studio = "local a = 1\nlocal b = 2\nlocal c = 3\n";
  const disk = "local a = 1\r\nlocal b = 99\r\nlocal c = 3\r\n";
  const d = unifiedDiff(studio, disk);
  assert.ok(d.includes("-local b = 2"), d);
  assert.ok(d.includes("+local b = 99"), d);
  assert.ok(!d.includes("local a = 1"), "common prefix must be trimmed");
  const tabsOnly = unifiedDiff("\tx = 1\n", "    x = 1\n");
  assert.ok(tabsOnly.includes("no line-level difference"), tabsOnly);
});

// --- manifest round-trip + unknown-file scan -------------------------------------------
check("manifest round-trip (atomic write) + findUnknownFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "nikmcp-sync-test-"));
  try {
    const manifest = {
      roots: ["ReplicatedStorage"],
      exportedAt: "2026-07-03T00:00:00.000Z",
      placeName: "TestPlace",
      files: {
        "ReplicatedStorage/Util.luau": {
          dataModelPath: "ReplicatedStorage.Util",
          className: "ModuleScript",
          hash: fnv1a32("return {}\n"),
        },
      },
    };
    writeManifestAtomic(dir, manifest);
    const back = readManifest(dir);
    assert.deepStrictEqual(back, manifest);

    mkdirSync(join(dir, "ReplicatedStorage"), { recursive: true });
    writeFileSync(join(dir, "ReplicatedStorage", "Util.luau"), "return {}\r\n");
    writeFileSync(join(dir, "ReplicatedStorage", "Rogue.luau"), "-- new\n");
    writeFileSync(join(dir, "notes.txt"), "not a luau file");

    // disk read normalizes CRLF -> hash matches the manifest (clean)
    const disk = readDiskSource(dir, "ReplicatedStorage/Util.luau");
    assert.strictEqual(fnv1a32(disk), manifest.files["ReplicatedStorage/Util.luau"].hash);

    const unknown = findUnknownFiles(dir, back);
    assert.deepStrictEqual(unknown, ["ReplicatedStorage/Rogue.luau"]);
    assert.ok(!unknown.includes(MANIFEST_NAME));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- empty source round-trips -----------------------------------------------------------
check("empty source: valid, hashes to the FNV offset basis", () => {
  assert.strictEqual(fnv1a32(normalizeSource("")), "811c9dc5");
  const plan = planExport([entry("ReplicatedStorage.Empty", "ModuleScript")]);
  assert.strictEqual(plan.files.length, 1);
});

console.log(`sync-unit self-check: PASS (${n} cases)`);
