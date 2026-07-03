#!/usr/bin/env node
// Build RobloxStudioMCP.rbxmx from plugin/src/*.luau without Rojo.
// Root = Script (init.server.luau) with the modules as ModuleScript children.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "plugin", "src");
const ROOT_NAME = "RobloxStudioMCP";
const CHILDREN = ["Config", "Settings", "Serializer", "Executor", "StatusWidget", "RuntimeAgentSource", "ClientAgentSource"];

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
  return `  <Item class="ModuleScript" referent="${r}">
   <Properties>
    <string name="Name">${esc(name)}</string>
    <ProtectedString name="Source">${cdata(read(name + ".luau"))}</ProtectedString>
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
