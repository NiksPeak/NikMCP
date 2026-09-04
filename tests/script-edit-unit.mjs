// Self-check: v0.2.0 script-edit logic (exact replace, unified patch, line
// slices, whitespace-insensitive compare, backup ring). Pure Node, offline.
// Run after `npm run build`:  node tests/script-edit-unit.mjs
import assert from "node:assert/strict";
import {
  applyExactReplace,
  applyUnifiedPatch,
  parseUnifiedDiff,
  sliceLines,
  normalizeForCompare,
  sameIgnoringWhitespace,
  ScriptBackupRing,
} from "../dist/script-edit.js";
import { fnv1a32 } from "../dist/sync.js";

let n = 0;
function check(name, fn) {
  n++;
  fn();
  console.log(`  ok ${n}: ${name}`);
}

const SRC = [
  "local RoundService = {}",
  "",
  "function RoundService.RequestReady(player)",
  "\tif state ~= \"Intermission\" then",
  "\t\treturn false",
  "\tend",
  "\treturn true",
  "end",
  "",
  "return RoundService",
].join("\n");

// ---------------------------------------------------------------- exact replace
check("exact replace: single unique match", () => {
  const out = applyExactReplace(SRC, 'if state ~= "Intermission" then', 'if state ~= "Intermission" and state ~= "Lobby" then');
  assert.equal(out.matches, 1);
  assert.ok(out.source.includes('state ~= "Lobby"'));
  assert.equal(out.source.split("\n").length, SRC.split("\n").length);
});

check("exact replace: CRLF anchors normalize before matching", () => {
  const out = applyExactReplace(SRC.replace(/\n/g, "\r\n"), "\treturn false\r\n\tend", "\treturn nil\n\tend");
  assert.ok(out.source.includes("return nil"));
  assert.ok(!out.source.includes("\r"));
});

check("exact replace: zero matches names the nearest line", () => {
  assert.throws(
    () => applyExactReplace(SRC, 'if state ~= "Intermission"  then', "x"),
    (e) => /0 matches/.test(e.message) && /line 4/.test(e.message),
  );
});

check("exact replace: ambiguous anchor refuses unless replaceAll/expectedMatches", () => {
  const dup = "print(1)\nprint(1)\nprint(1)\n";
  assert.throws(() => applyExactReplace(dup, "print(1)", "print(2)"), /matched 3 time/);
  assert.equal(applyExactReplace(dup, "print(1)", "print(2)", { replaceAll: true }).matches, 3);
  assert.equal(applyExactReplace(dup, "print(1)", "print(2)", { expectedMatches: 3 }).source, "print(2)\nprint(2)\nprint(2)\n");
  assert.throws(() => applyExactReplace(dup, "print(1)", "print(2)", { expectedMatches: 2 }), /but 2 expected/);
});

check("exact replace: rejects empty and identical anchors", () => {
  assert.throws(() => applyExactReplace(SRC, "", "x"), /must not be empty/);
  assert.throws(() => applyExactReplace(SRC, "return true", "return true"), /identical/);
});

// ---------------------------------------------------------------- unified patch
const PATCH = [
  "--- a/RoundService.luau",
  "+++ b/RoundService.luau",
  "@@ -3,6 +3,7 @@",
  " function RoundService.RequestReady(player)",
  '-\tif state ~= "Intermission" then',
  '+\tif state ~= "Intermission" and state ~= "Lobby" then',
  "+\t\twarn(\"RequestReady refused\")",
  " \t\treturn false",
  " \tend",
  " \treturn true",
  " end",
].join("\n");

check("unified patch: parses headers + hunks", () => {
  const hunks = parseUnifiedDiff(PATCH);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].oldStart, 3);
  assert.equal(hunks[0].oldCount, 6);
  assert.equal(hunks[0].newCount, 7);
});

check("unified patch: applies at the exact position", () => {
  const out = applyUnifiedPatch(SRC, PATCH);
  assert.equal(out.hunks[0].offset, 0);
  assert.equal(out.hunks[0].fuzz, 0);
  assert.ok(out.source.includes('warn("RequestReady refused")'));
  assert.equal(out.source.split("\n").length, SRC.split("\n").length + 1);
});

check("unified patch: relocates a hunk whose line numbers drifted", () => {
  const shifted = "-- header\n-- more header\n" + SRC;
  const out = applyUnifiedPatch(shifted, PATCH);
  assert.equal(out.hunks[0].offset, 2);
  assert.ok(out.source.startsWith("-- header\n"));
  assert.ok(out.source.includes('state ~= "Lobby"'));
});

check("unified patch: whitespace-fuzzy match when indentation drifted", () => {
  const spaces = SRC.replace(/\t/g, "    ");
  const out = applyUnifiedPatch(spaces, PATCH);
  assert.equal(out.hunks[0].fuzz, 2);
  assert.ok(out.source.includes('state ~= "Lobby"'));
});

check("unified patch: unlocatable hunk aborts with the hunk id", () => {
  assert.throws(() => applyUnifiedPatch("totally different\n", PATCH), /hunk 1 .* does not match/);
});

check("unified patch: multiple hunks account for earlier deltas", () => {
  const src = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
  const patch = [
    "@@ -2,1 +2,3 @@",
    "-line 2",
    "+line 2a",
    "+line 2b",
    "+line 2c",
    "@@ -11,1 +13,1 @@",
    "-line 11",
    "+line eleven",
  ].join("\n");
  const out = applyUnifiedPatch(src, patch);
  const lines = out.source.split("\n");
  assert.equal(lines[1], "line 2a");
  assert.equal(lines[12], "line eleven");
  assert.equal(lines.length, 14);
});

check("unified patch: rejects text before any hunk / bad prefixes", () => {
  assert.throws(() => parseUnifiedDiff("hello\n@@ -1,1 +1,1 @@\n-a\n+b"), /before any @@/);
  assert.throws(() => parseUnifiedDiff("@@ -1,1 +1,1 @@\n?a"), /no \+\/-\/space prefix/);
  assert.throws(() => parseUnifiedDiff(""), /no @@ hunks/);
});

// ---------------------------------------------------------------- line slices
check("sliceLines: window + totals + truncated flag", () => {
  const s = sliceLines(SRC, 3, 4);
  assert.equal(s.startLine, 3);
  assert.equal(s.endLine, 6);
  assert.equal(s.totalLines, 10);
  assert.equal(s.truncated, true);
  assert.equal(s.source.split("\n")[0], "function RoundService.RequestReady(player)");
  const whole = sliceLines(SRC);
  assert.equal(whole.truncated, false);
  assert.equal(whole.source, SRC);
  const past = sliceLines(SRC, 999, 5);
  assert.equal(past.startLine, 10);
  assert.equal(past.endLine, 10);
});

check("sliceLines: maxBytes caps the window", () => {
  const s = sliceLines(SRC, 1, undefined, 30);
  assert.ok(Buffer.byteLength(s.source, "utf8") <= 30 + 1);
  assert.equal(s.truncated, true);
  assert.ok(s.endLine < 10);
});

// ---------------------------------------------------------------- whitespace compare
check("normalizeForCompare treats CRLF/tabs/trailing ws/trailing newlines as equal", () => {
  const a = "local x = 1\n\tprint(x)   \n\n\n";
  const b = "local x = 1\r\n    print(x)\r\n";
  assert.equal(normalizeForCompare(a), normalizeForCompare(b));
  assert.equal(sameIgnoringWhitespace(a, b), true);
  assert.equal(sameIgnoringWhitespace("local x = 1", "local x = 2"), false);
  assert.notEqual(fnv1a32(a), fnv1a32(b), "hashes differ, which is exactly the false-CONFLICT the compare fixes");
});

// ---------------------------------------------------------------- backup ring
check("ScriptBackupRing: newest-first, dedups identical, caps per path", () => {
  const ring = new ScriptBackupRing(2, 40);
  assert.ok(ring.record("SSS.A", "v1", "write_script"));
  assert.equal(ring.record("SSS.A", "v1", "write_script"), null, "identical newest is skipped");
  assert.ok(ring.record("SSS.A", "v2", "edit_script"));
  assert.ok(ring.record("SSS.A", "v3", "edit_script"));
  assert.equal(ring.size, 2);
  assert.equal(ring.get("SSS.A", 0).source, "v3");
  assert.equal(ring.get("SSS.A", 1).source, "v2");
  assert.equal(ring.get("SSS.A", 2), null);
  assert.equal(ring.list("SSS.A")[0].tool, "edit_script");
  assert.equal("source" in ring.list("SSS.A")[0], false, "list never returns bodies");
});

check("ScriptBackupRing: evicts least-recently-touched paths and enforces byte cap", () => {
  const ring = new ScriptBackupRing(5, 2, 40);
  ring.record("P1", "a".repeat(10), "t");
  ring.record("P2", "b".repeat(10), "t");
  ring.record("P3", "c".repeat(10), "t");
  assert.equal(ring.get("P1"), null, "oldest path evicted by maxPaths");
  assert.ok(ring.get("P2"));
  const ring2 = new ScriptBackupRing(5, 10, 25);
  ring2.record("Q1", "x".repeat(20), "t");
  ring2.record("Q2", "y".repeat(20), "t");
  assert.ok(ring2.totalBytes() <= 25, `byte cap enforced (${ring2.totalBytes()})`);
  assert.ok(ring2.get("Q2"), "newest survives the byte cap");
});

console.log(`script-edit self-check: PASS (${n} cases)`);
