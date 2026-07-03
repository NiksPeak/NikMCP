// Self-check: Luau analyze gate (task 24 Part B). Resolve-only (never downloads):
// if the analyzer binary or definitions are not already available this prints
// SKIP and exits 0 (CI-friendly). Run after `npm run build`:
//   node tests/luau-gate.mjs
import assert from "node:assert";
import { initLuauGate, analyzeLuau, _internal } from "../dist/luau-gate.js";

// Parser classification works without the binary -- always assert it.
{
  const sample = [
    "[INFO] Loading definitions file: @roblox - globalTypes.d.luau",
    "x.luau(2,1): SyntaxError: Expected identifier when parsing expression, got <eof>",
    "x.luau(3,5): TypeError: Unknown global 'gme'",
    "x.luau(1,7): LocalUnused: Variable 'a' is never used; prefix with '_' to silence",
  ].join("\n");
  const { errors, warnings } = _internal.parseDiagnostics(sample);
  assert.strictEqual(errors.length, 2, "SyntaxError + TypeError must classify as errors");
  assert.strictEqual(warnings.length, 1, "lint kinds classify as warnings");
  // Dynamic-DataModel TypeErrors must be DEMOTED to warnings (dot-child access
  // like game.Workspace.MyPart is statically unknowable without a sourcemap).
  const demoted = _internal.parseDiagnostics(
    [
      "x.luau(1,11): TypeError: Key 'Baseplate' not found in external type 'Workspace'",
      "x.luau(2,1): TypeError: Unknown require: game/ReplicatedStorage/MyModule",
    ].join("\n")
  );
  assert.strictEqual(demoted.errors.length, 0, "DataModel-content TypeErrors must not block");
  assert.strictEqual(demoted.warnings.length, 2, "they ride along as warnings");
  assert.deepStrictEqual(
    { line: errors[1].line, col: errors[1].col, kind: errors[1].kind },
    { line: 3, col: 5, kind: "TypeError" }
  );
  console.log("  ok: diagnostic parsing + classification");
}

const available = await initLuauGate({ allowDownload: false });
if (!available) {
  console.log("luau-gate self-check: SKIP (analyzer not installed)");
  process.exit(0);
}

let n = 1;
async function expectErrors(name, source, predicate) {
  const res = await analyzeLuau(source);
  assert.strictEqual(res.available, true, `${name}: analyzer should be available`);
  assert.ok(predicate(res), `${name}: unexpected result ${JSON.stringify(res)}`);
  n++;
  console.log(`  ok: ${name}`);
}

// Syntax error blocks.
await expectErrors(
  "syntax error blocks",
  "local x = \n",
  (r) => !r.ok && r.errors.some((e) => e.kind === "SyntaxError")
);

// The leading-paren ambiguous-syntax class blocks (the exact bug class the gate
// exists for -- verified against luau-lsp 1.68.1).
await expectErrors(
  "leading-paren ambiguous syntax blocks",
  'local f = print\n(f)("hi")\n',
  (r) => !r.ok && r.errors.some((e) => e.message.toLowerCase().includes("ambiguous"))
);

// Unknown global (typo'd game) blocks.
await expectErrors(
  "unknown global 'gme' blocks",
  'gme.Workspace.Name = "x"\n',
  (r) => !r.ok && r.errors.some((e) => e.message.includes("gme"))
);

// A clean Roblox snippet passes with ZERO errors -- this proves the globalTypes
// definitions actually loaded (without them, `game`/`task`/`Instance` would all
// be unknown globals and this case would fail; that is the point).
await expectErrors(
  "clean Roblox snippet passes (definitions loaded)",
  'local p = Instance.new("Part")\np.Parent = game:GetService("Workspace")\ntask.wait(0.1)\nprint(p.Name)\n',
  (r) => r.ok && r.errors.length === 0
);

// Dot-child DataModel access (the most common run_luau shape) must pass even
// though globalTypes declares Workspace as a closed extern type.
await expectErrors(
  "dot-child DataModel access passes (demoted TypeError)",
  "workspace.Baseplate.Transparency = 0.5\nlocal m = game.Workspace.SomeModel\nprint(m)\n",
  (r) => r.ok && r.errors.length === 0
);

console.log(`luau-gate self-check: PASS (${n} analyze cases + parser)`);
