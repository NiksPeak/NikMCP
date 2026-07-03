// Object-arg regression guard (run: `npm run selftest`).
//
// Guards the "Bug 1" class: the MCP client JSON-stringifies object-valued args for
// top-level z.any() params, so serialized datatypes ({__t:"Color3"...}, build/scene/
// tree/spec objects) arrive as STRINGS. src/mcp-server.ts must coerce them back via
// objectArg(). This test sends every such param as a JSON STRING and fails if Studio
// doesn't apply it -- so the class can't silently regress.
//
// Requirements: build first (`npm run build`); Studio open with the plugin connected
// (edit context polling) and NOTHING else bound to 58741 -- this spawns its own
// `node dist/index.js`, which Studio then polls. Exits non-zero on any failure.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  stderr: "inherit",
});
const client = new Client({ name: "object-arg-regression", version: "1.0.0" });
await client.connect(transport);

const M = "game.Workspace._MCP_ObjArgTest";
const rows = [];
async function T(label, name, args, check) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content || []).map((c) => c.text ?? `[${c.type}]`).join("\n");
    let ok = !r.isError;
    if (ok && check) ok = check(text);
    rows.push({ tool: label, ok, err: ok ? "" : (text.slice(0, 200) || "isError") });
    return { ok, text };
  } catch (e) {
    rows.push({ tool: label, ok: false, err: String(e?.message || e).slice(0, 200) });
    return { ok: false, text: "" };
  }
}
// Negative assertion: expect the tool to ERROR and its message to match rx.
async function TErr(label, name, args, rx) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content || []).map((c) => c.text ?? `[${c.type}]`).join("\n");
    const ok = !!r.isError && rx.test(text);
    rows.push({ tool: label, ok, err: ok ? "" : `expected error /${rx.source}/, got: ${text.slice(0, 160)}` });
  } catch (e) {
    rows.push({ tool: label, ok: false, err: String(e?.message || e).slice(0, 200) });
  }
}
const V3 = (x, y, z) => JSON.stringify({ __t: "Vector3", x, y, z });
const C3 = (r, g, b) => JSON.stringify({ __t: "Color3", r, g, b });
const CF = (...c) => JSON.stringify({ __t: "CFrame", comps: c });

try {
  await new Promise((r) => setTimeout(r, 1500)); // let the plugin bind to this bridge

  const boot = await T("create scratch model", "create_instance", {
    className: "Model", parentPath: "game.Workspace", name: "_MCP_ObjArgTest",
  });
  if (!boot.ok) {
    console.error(
      "\nCannot reach Studio. Open Studio with the plugin connected (edit context), " +
      "run `npm run build`, and ensure nothing else holds 58741, then retry.\n"
    );
    throw new Error("studio-unreachable");
  }
  await T("create P (blue)", "create_instance", {
    className: "Part", parentPath: M, name: "P",
    properties: { Anchored: true, Color: { __t: "Color3", r: 0, g: 0, b: 1 } },
  });

  // --- single-instance property datatypes via STRING ---
  await T("set_property.value", "set_property", { path: M + ".P", property: "Color", value: C3(1, 0, 0) },
    () => true);
  await T("  verify Color applied", "get_properties", { path: M + ".P", propertyNames: ["Color"] },
    (t) => /"r":\s*1\b/.test(t) && /"g":\s*0\b/.test(t));
  await T("move_instance.position", "move_instance", { path: M + ".P", position: V3(5, 5, 5) });
  await T("set_attribute.value", "set_attribute", { path: M + ".P", name: "Tint", value: C3(0, 1, 0) });
  await T("  verify attr is Color3", "get_attribute", { path: M + ".P", name: "Tint" },
    (t) => /Color3/.test(t) && /"g":\s*1\b/.test(t));
  await T("set_camera.cframe", "set_camera", { cframe: CF(30, 30, 30, 1, 0, 0, 0, 1, 0, 0, 0, 1) });

  // --- bulk / mass property datatypes via STRING ---
  await T("create Q", "create_instance", { className: "Part", parentPath: M, name: "Q", properties: { Anchored: true } });
  await T("bulk_set_property.value", "bulk_set_property", { paths: [M + ".P", M + ".Q"], property: "Color", value: C3(0, 0, 1) });
  await T("mass_set_property.value", "mass_set_property", { paths: [M + ".P", M + ".Q"], property: "Color", value: C3(0, 0, 1) });
  await T("search_by_property.value", "search_by_property", { property: "Color", value: C3(0, 0, 1), root: M },
    (t) => /\.P\b|\.Q\b/.test(t));

  // --- duplicate offset/spacing via STRING (effect-checked through run_luau) ---
  await T("create Dup", "create_instance", { className: "Part", parentPath: M, name: "Dup", properties: { Anchored: true, Position: { __t: "Vector3", x: 0, y: 0, z: 0 } } });
  await T("mass_duplicate.offset", "mass_duplicate", { path: M + ".Dup", count: 3, offset: V3(0, 0, 10) });
  await T("  verify offset applied", "run_luau", {
    code: `local m=game.Workspace._MCP_ObjArgTest local zs={} for _,c in ipairs(m:GetChildren()) do if c.Name=="Dup" and c:IsA("BasePart") then zs[math.floor(c.Position.Z)]=true end end local n=0 for _ in pairs(zs) do n+=1 end return n`,
  }, (t) => /\b([2-9]|\d\d)\b/.test(t));
  await T("create Tile", "create_instance", { className: "Part", parentPath: M, name: "Tile", properties: { Anchored: true, Position: { __t: "Vector3", x: 0, y: 0, z: 0 } } });
  await T("smart_duplicate.spacing", "smart_duplicate", { path: M + ".Tile", count: 4, mode: "grid", columns: 2, spacing: V3(6, 0, 6) });
  await T("  verify spacing applied", "run_luau", {
    code: `local m=game.Workspace._MCP_ObjArgTest local xs={} for _,c in ipairs(m:GetChildren()) do if c.Name=="Tile" and c:IsA("BasePart") then xs[math.floor(c.Position.X)]=true end end local n=0 for _ in pairs(xs) do n+=1 end return n`,
  }, (t) => /\b([2-9]|\d\d)\b/.test(t));

  // --- whole-object builds via STRING ---
  await T("import_build.build", "import_build", {
    parentPath: M, name: "Imported",
    build: JSON.stringify({ className: "Part", name: "Imported", properties: { Anchored: true, Color: { __t: "Color3", r: 0, g: 1, b: 0 } } }),
  });
  await T("  verify Imported exists", "search_instances", { query: "Imported", root: M }, (t) => /Imported/.test(t));
  await T("generate_build.spec", "generate_build", {
    spec: JSON.stringify({ kind: "grid", className: "Part", rows: 2, cols: 2, spacing: 4, parentPath: M, properties: { Anchored: true } }),
  });
  await T("create_keyframe_sequence.keyframes", "create_keyframe_sequence", {
    parentPath: M, name: "ObjArgAnim", registerPreview: false,
    keyframes: JSON.stringify([
      { time: 0, poses: [{ part: "Root", cframe: { __t: "CFrame", comps: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } }] },
      { time: 1, poses: [{ part: "Root", cframe: { __t: "CFrame", comps: [0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } }] },
    ]),
  }, (t) => /"keyframeCount":\s*2\b/.test(t) && /"poseCount":\s*2\b/.test(t));
  // --- task 22: create_sound (coerced id) + set_lighting (tagged Color3 round-trip) ---
  await T("create_sound (bare-number id coerced)", "create_sound", {
    parentPath: M, name: "SFX", soundId: 9112824440, volume: 0.7,
  });
  await T("  verify SoundId coerced to rbxassetid", "get_properties",
    { path: M + ".SFX", propertyNames: ["SoundId", "Volume"] },
    (t) => /rbxassetid:\/\/9112824440/.test(t));
  await TErr("create_sound rejects empty soundId", "create_sound",
    { parentPath: M, soundId: "" }, /invalid soundId/);

  // set_lighting: tagged Color3 must round-trip (not silently black). Self-restoring
  // (snapshot -> apply -> verify -> restore), and only destroys an Atmosphere we made.
  await T("snapshot Lighting", "run_luau", {
    code: `local L=game:GetService("Lighting") _G.__oa=L.OutdoorAmbient _G.__ct=L.ClockTime _G.__hadAtmo=L:FindFirstChildOfClass("Atmosphere")~=nil return true`,
  });
  await T("set_lighting.properties+effects", "set_lighting", {
    properties: JSON.stringify({ ClockTime: 6, OutdoorAmbient: { __t: "Color3", r: 1, g: 0, b: 0 } }),
    effects: JSON.stringify({ Atmosphere: { Density: 0.3 } }),
  }, (t) => /"applied"/.test(t) && /"effects"/.test(t));
  await T("  verify OutdoorAmbient red (tagged Color3 not black)", "get_properties",
    { path: "game.Lighting", propertyNames: ["OutdoorAmbient"] },
    (t) => /"r":\s*1\b/.test(t) && /"g":\s*0\b/.test(t) && /"b":\s*0\b/.test(t));
  await TErr("set_lighting rejects unknown property", "set_lighting",
    { properties: JSON.stringify({ NotARealProp: 1 }) }, /unknown Lighting property/);
  await TErr("set_lighting rejects unknown effect class", "set_lighting",
    { effects: JSON.stringify({ NotAnEffect: { X: 1 } }) }, /unknown effect class/);
  await T("restore Lighting", "run_luau", {
    code: `local L=game:GetService("Lighting") L.OutdoorAmbient=_G.__oa L.ClockTime=_G.__ct if not _G.__hadAtmo then local a=L:FindFirstChildOfClass("Atmosphere") if a then a:Destroy() end end return true`,
  });

  await T("import_scene.scene", "import_scene", {
    scene: JSON.stringify({ roots: [{ parentPath: M, build: { className: "Part", name: "SceneP", properties: { Anchored: true } } }] }),
  });
  await T("  verify SceneP exists", "search_instances", { query: "SceneP", root: M }, (t) => /SceneP/.test(t));
  await T("create_ui_tree.tree", "create_ui_tree", {
    parentPath: M,
    tree: JSON.stringify({ className: "ScreenGui", properties: { Name: "ST_UI" }, children: [{ className: "Frame", properties: { Name: "Body" } }] }),
  });
  await T("  verify ST_UI exists", "search_instances", { query: "ST_UI", root: M }, (t) => /ST_UI/.test(t));

  // --- task 23: outer-array/object objectArg coercion via STRING ---
  await T("verify_playtest.clientChecks (string array)", "verify_playtest", {
    mode: "run",
    assertScript: "return { passed = true, failures = {} }",
    clientChecks: JSON.stringify([{ name: "objArgCheck" }]),
    timeoutSec: 30,
  }, (t) => /"passed":\s*true/.test(t) && /"objArgCheck"/.test(t) && /"skipped"/.test(t));

  await T("verify_playtest.clientChecks (nested args string)", "verify_playtest", {
    mode: "run",
    assertScript: "return { passed = true, failures = {} }",
    clientChecks: JSON.stringify([{ name: "objArgNested", args: JSON.stringify({ foo: "bar" }) }]),
    timeoutSec: 30,
  }, (t) => /"passed":\s*true/.test(t) && /"objArgNested"/.test(t));

  await TErr("upload_asset.applyTo (string)", "upload_asset", {
    assetType: "Image", displayName: "objArgTest",
    applyTo: JSON.stringify({ path: M + ".P", property: "Color" }),
  }, /provide exactly one of filePath or content/);

  await TErr("upload_capture.applyTo (string)", "upload_capture", {
    displayName: "objArgTest",
    applyTo: JSON.stringify({ path: M + ".P", property: "Color" }),
  }, /not configured/);

  // NOTE: character_navigation.position is the same objectArg() class but needs a
  // running playtest with a character, so it isn't exercised here (code-only coverage).

  // --- task 26: RoCreate object/array objectArg coercion via STRING ---
  // creator (object) + ids (array of objects) passed as JSON strings. Coercion
  // proof: the response must be a domain result (no-key error OR the dry-run plan
  // echoing what we sent), NOT a zod "Expected object, received string" schema error.
  await T("rocreate_reupload_assets.creator+ids (strings)", "rocreate_reupload_assets", {
    creator: JSON.stringify({ type: "user", id: "1" }),
    ids: JSON.stringify([{ kind: "image", id: "123" }]),
    dryRun: true,
  }, (t) => !/Expected object|invalid_type|Expected array/i.test(t) &&
           /(no RoCreate API key|"wouldProcess"|"image")/.test(t));

  await T("rocreate_apply_asset_map.scan (string)", "rocreate_apply_asset_map", {
    scan: JSON.stringify({ references: [{ path: "game.Workspace.P", prop: "Color", id: "123" }] }),
    dryRun: true,
  }, (t) => !/Expected object|invalid_type/i.test(t) &&
           /(no applicable map entries|"propertyChanges"|"scriptReplacements")/.test(t));
} catch (e) {
  if (e?.message !== "studio-unreachable") rows.push({ tool: "FATAL", ok: false, err: String(e?.stack || e).slice(0, 300) });
} finally {
  await T("delete cleanup", "delete_instance", { path: M });
  await client.close().catch(() => {});
}

const pass = rows.filter((r) => r.ok).length;
console.log("\nCHECK".padEnd(34), "RESULT");
for (const r of rows) console.log(r.tool.padEnd(34), r.ok ? "PASS" : "FAIL  " + r.err);
console.log(`\n${pass}/${rows.length} passed`);
process.exit(rows.length > 0 && rows.every((r) => r.ok) ? 0 : 1);
