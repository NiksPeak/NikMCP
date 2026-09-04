import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testsDir, "..");

async function read(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

const packageJson = JSON.parse(await read("package.json"));
const packageLock = JSON.parse(await read("package-lock.json"));
const version = packageJson.version;

assert.match(version, /^\d+\.\d+\.\d+$/, "package version must be semantic");
assert.equal(packageLock.version, version, "package-lock root version drifted");
assert.equal(packageLock.packages?.[""]?.version, version, "package-lock package version drifted");

const surfaces = [
  ["src/mcp-server.ts", `version: "${version}"`],
  ["plugin/src/StatusWidget.luau", `version.Text = "version ${version}"`],
  ["README.md", `**Version ${version}**`],
  ["Version_History.md", `## v${version} -`],
  ["RobloxStudioMCP.rbxmx", `version ${version}`],
];

for (const [relativePath, expectedText] of surfaces) {
  const source = await read(relativePath);
  assert.ok(
    source.includes(expectedText),
    `${relativePath} is missing current version marker: ${expectedText}`,
  );
}

const artifact = await read("RobloxStudioMCP.rbxmx");
const rootSource = artifact.match(
  /<Item class="Script"[^>]*>[\s\S]*?<ProtectedString name="Source"><!\[CDATA\[([\s\S]*?)\]\]><\/ProtectedString>/,
)?.[1];
assert.equal(
  rootSource,
  await read("plugin/src/init.server.luau"),
  "generated plugin root source is stale",
);

const moduleSources = new Map();
for (const match of artifact.matchAll(/<Item class="ModuleScript"[^>]*>([\s\S]*?)<\/Item>/g)) {
  const body = match[1];
  const name = body.match(/<string name="Name">([^<]+)<\/string>/)?.[1];
  const source = body.match(
    /<ProtectedString name="Source"><!\[CDATA\[([\s\S]*?)\]\]><\/ProtectedString>/,
  )?.[1];
  assert.ok(name && source !== undefined, "generated plugin contains a malformed ModuleScript");
  assert.ok(!moduleSources.has(name), `generated plugin contains duplicate module ${name}`);
  moduleSources.set(name, source);
}

const sourceFiles = (await readdir(path.join(rootDir, "plugin", "src")))
  .filter((name) => name.endsWith(".luau") && name !== "init.server.luau")
  .sort();
assert.deepEqual(
  [...moduleSources.keys()].sort(),
  sourceFiles.map((name) => name.slice(0, -".luau".length)),
  "generated plugin module list drifted from plugin/src",
);
for (const fileName of sourceFiles) {
  const moduleName = fileName.slice(0, -".luau".length);
  assert.equal(
    moduleSources.get(moduleName),
    await read(`plugin/src/${fileName}`),
    `generated plugin embeds stale ${moduleName} source`,
  );
}

console.log(`Version and artifact parity PASS: ${version} (${moduleSources.size} modules)`);
