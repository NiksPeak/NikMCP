#!/usr/bin/env node
// Build RobloxStudioMCP.rbxmx from plugin/src/*.luau without Rojo.
// Root = Script (init.server.luau) with the modules as ModuleScript children.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "plugin", "src");
const ROOT_NAME = "RobloxStudioMCP";
const CHILDREN = ["Config", "Settings", "Serializer", "AnalysisTools", "EnvironmentTools", "AssetGuardTools", "QATools", "AgentTools", "Executor", "StatusWidget", "RuntimeAgentSource", "ClientAgentSource"];

// Luau's bytecode compiler caps a single lexical scope at 200 local-variable
// registers ("Out of local registers... exceeded limit 200" at compile time --
// luau-lsp's static analysis does NOT catch this). Count top-level `local`
// statements per module as a cheap proxy and fail the build before it ships a
// module that will not compile in Studio.
const LOCALS_LIMIT = 195;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function cdata(s) {
  if (s.includes("]]>")) throw new Error("source contains ]]> which breaks CDATA");
  return "<![CDATA[" + s + "]]>";
}
const read = (name) => readFileSync(join(SRC, name), "utf8");

let ref = 0;
const nextRef = () => `RBX${ref++}`;

function moduleItem(name) {
  const r = nextRef();
  const src = read(name + ".luau");
  const localCount = (src.match(/^local /gm) || []).length;
  if (localCount > LOCALS_LIMIT) {
    throw new Error(
      `${name}.luau has ${localCount} top-level local statements (limit ${LOCALS_LIMIT}) -- ` +
        `Luau's bytecode compiler caps a scope at 200 local registers. Split this module before building.`
    );
  }
  return `  <Item class="ModuleScript" referent="${r}">
   <Properties>
    <string name="Name">${esc(name)}</string>
    <ProtectedString name="Source">${cdata(src)}</ProtectedString>
   </Properties>
  </Item>
`;
}

const rootRef = nextRef();
const initSrc = read("init.server.luau");
const childXml = CHILDREN.map(moduleItem).join("");

const xml = `<roblox version="4">
 <Item class="Script" referent="${rootRef}">
  <Properties>
   <string name="Name">${ROOT_NAME}</string>
   <ProtectedString name="Source">${cdata(initSrc)}</ProtectedString>
   <token name="RunContext">0</token>
  </Properties>
${childXml} </Item>
</roblox>
`;

const out = join(ROOT, "RobloxStudioMCP.rbxmx");
writeFileSync(out, xml, "utf8");
console.log(`Built ${out} (${Buffer.byteLength(xml)} bytes) with modules: ${CHILDREN.join(", ")}`);
