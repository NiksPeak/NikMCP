// Self-check: API-dump validators (task 24 Part A) against the checked-in
// fixture. Pure Node -- NO network, NO Studio. Run after `npm run build`:
//   node tests/api-dump-validation.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ApiDumpIndex,
  didYouMean,
  validateCreate,
  validatePropertyWrite,
  classInfo,
} from "../dist/api-dump.js";

const here = dirname(fileURLToPath(import.meta.url));
const dump = JSON.parse(readFileSync(join(here, "fixtures", "api-dump.min.json"), "utf8"));
const idx = new ApiDumpIndex(dump);

let n = 0;
function check(name, fn) {
  n++;
  fn();
  console.log(`  ok ${n}: ${name}`);
}

// --- didYouMean --------------------------------------------------------------
check("didYouMean finds distance-1 typo", () => {
  assert.strictEqual(didYouMean("Trasparency", ["Transparency", "Anchored"]), "Transparency");
});
check("didYouMean rejects far strings", () => {
  assert.strictEqual(didYouMean("Zzzzzzz", ["Transparency", "Anchored"]), null);
});

// --- validateCreate ----------------------------------------------------------
check("unknown class rejected with didYouMean", () => {
  const err = validateCreate(idx, "Prt");
  assert.ok(err && err.includes("unknown class 'Prt'"), err);
  assert.ok(err.includes("'Part'"), err);
});
check("NotCreatable class rejected", () => {
  const err = validateCreate(idx, "BasePart");
  assert.ok(err && err.includes("NotCreatable"), err);
});
check("Service class rejected", () => {
  const err = validateCreate(idx, "Workspace");
  assert.ok(err && err.includes("Service"), err);
});
check("creatable class passes", () => {
  assert.strictEqual(validateCreate(idx, "Part"), null);
});

// --- validatePropertyWrite (class unknown -- the set_property path) -----------
check("'Trasparency' rejected with suggestion 'Transparency'", () => {
  const err = validatePropertyWrite(idx, "Trasparency", 0.5);
  assert.ok(err && err.includes("Trasparency"), err);
  assert.ok(err.includes("'Transparency'"), err);
});
check("bool into number-typed unambiguous property rejected", () => {
  const err = validatePropertyWrite(idx, "Transparency", true);
  assert.ok(err && err.includes("number"), err);
});
check("correct number passes", () => {
  assert.strictEqual(validatePropertyWrite(idx, "Transparency", 0.5), null);
});
check("bool property accepts bool", () => {
  assert.strictEqual(validatePropertyWrite(idx, "Anchored", true), null);
});
check("ambiguous property passes through ('Value' int64 vs string)", () => {
  assert.strictEqual(validatePropertyWrite(idx, "Value", "hello"), null);
  assert.strictEqual(validatePropertyWrite(idx, "Value", 5), null);
});
check("read-only property rejected", () => {
  const err = validatePropertyWrite(idx, "Mass", 5);
  assert.ok(err && err.toLowerCase().includes("read-only"), err);
});
check("RobloxScriptSecurity write rejected", () => {
  const err = validatePropertyWrite(idx, "SourceAssetId", 5);
  assert.ok(err, "expected a rejection");
});
check("enum typo rejected with suggestion", () => {
  const err = validatePropertyWrite(idx, "Material", "Neno");
  assert.ok(err && err.includes("Enum.Material"), err);
  assert.ok(err.includes("'Neon'"), err);
});
check("valid enum value passes (short and Enum.X.Y forms)", () => {
  assert.strictEqual(validatePropertyWrite(idx, "Material", "Neon"), null);
  assert.strictEqual(validatePropertyWrite(idx, "Material", "Enum.Material.Wood"), null);
});
check("complex type (Class-valued Parent) passes through", () => {
  assert.strictEqual(validatePropertyWrite(idx, "Parent", { __t: "Instance" }), null);
});

// --- validatePropertyWrite (class known -- the create_instance path) ----------
check("class-known: unknown property rejected with class-scoped suggestion", () => {
  const err = validatePropertyWrite(idx, "Trasparency", 0.5, "Part");
  assert.ok(err && err.includes("'Part'"), err);
  assert.ok(err.includes("'Transparency'"), err);
});
check("class-known: read-only rejected", () => {
  const err = validatePropertyWrite(idx, "Mass", 5, "Part");
  assert.ok(err && err.toLowerCase().includes("read-only"), err);
});
check("class-known: inherited property accepted", () => {
  assert.strictEqual(validatePropertyWrite(idx, "Name", "Thing", "Part"), null);
});
check("class-known: enum typo rejected", () => {
  const err = validatePropertyWrite(idx, "Material", "Neno", "Part");
  assert.ok(err && err.includes("'Neon'"), err);
});

// --- dump-absent -> everything passes through ----------------------------------
check("dump absent: validateCreate passes through", () => {
  assert.strictEqual(validateCreate(null, "TotalGarbageClass"), null);
});
check("dump absent: validatePropertyWrite passes through", () => {
  assert.strictEqual(validatePropertyWrite(null, "Trasparency", true), null);
  assert.strictEqual(validatePropertyWrite(null, "Mass", 1, "Part"), null);
});

// --- classInfo (get_class_info backing) ----------------------------------------
check("classInfo: inherited members with declaring class", () => {
  const info = classInfo(idx, { className: "Part", includeInherited: true });
  assert.ok(!("error" in info), JSON.stringify(info));
  const name = info.members.find((m) => m.name === "Name");
  assert.ok(name, "inherited Name missing");
  assert.strictEqual(name.declaredIn, "Instance");
  const shape = info.members.find((m) => m.name === "Shape");
  assert.ok(shape && shape.declaredIn === "Part");
  assert.strictEqual(info.creatable, true);
});
check("classInfo: includeInherited=false excludes ancestors", () => {
  const info = classInfo(idx, { className: "Part", includeInherited: false });
  assert.ok(!("error" in info));
  assert.ok(info.members.every((m) => m.declaredIn === "Part"), JSON.stringify(info.members));
});
check("classInfo: memberType filter", () => {
  const info = classInfo(idx, { className: "Part", includeInherited: true, memberType: "Function" });
  assert.ok(!("error" in info));
  assert.ok(info.members.every((m) => m.memberType === "Function"));
  assert.ok(info.members.some((m) => m.name === "AddTag"));
});
check("classInfo: unknown class error with suggestion", () => {
  const info = classInfo(idx, { className: "Prt", includeInherited: true });
  assert.ok("error" in info && info.error.includes("'Part'"), JSON.stringify(info));
});

console.log(`api-dump-validation self-check: PASS (${n} cases)`);
