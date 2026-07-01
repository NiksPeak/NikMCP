// upload_animation guard unit tests (run: `npm run selftest:upload`). NO network,
// NO Studio -- pure validation/resolution + rojo-missing detection. Exits non-zero on
// any failure. Requires `npm run build` first (imports compiled dist modules).
import { validateUploadInput, resolveCreator } from "../dist/open-cloud.js";
import { detectRojo } from "../dist/rojo.js";
import { readKey } from "../dist/credentials.js";

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) {
    pass++;
    console.log("PASS  " + label);
  } else {
    fail++;
    console.log("FAIL  " + label);
  }
}

// --- name validation ---
check("empty name rejected", validateUploadInput({ name: "" }).ok === false);
check("whitespace name rejected", validateUploadInput({ name: "   " }).ok === false);
check("51-char name rejected", validateUploadInput({ name: "x".repeat(51) }).ok === false);
check("good name accepted", validateUploadInput({ name: "  Walk  " }).ok === true);
{
  const r = validateUploadInput({ name: "  Walk  " });
  check("name trimmed", r.ok && r.value.name === "Walk");
}
check("1001-char description rejected", validateUploadInput({ name: "ok", description: "d".repeat(1001) }).ok === false);
check("1000-char description accepted", validateUploadInput({ name: "ok", description: "d".repeat(1000) }).ok === true);

// --- creator resolution (call arg > config; reject when neither) ---
check("no creator anywhere rejected", resolveCreator({}, undefined).ok === false);
{
  const r = resolveCreator({ creatorId: 123 }, undefined);
  check("arg creatorId -> userId default", r.ok && "userId" in r.value && r.value.userId === 123);
}
{
  const r = resolveCreator({ creatorId: 55, creatorType: "group" }, undefined);
  check("arg creatorType=group -> groupId", r.ok && "groupId" in r.value && r.value.groupId === 55);
}
{
  const r = resolveCreator({}, { userId: 999 });
  check("config userId used when no arg", r.ok && "userId" in r.value && r.value.userId === 999);
}
{
  const r = resolveCreator({ creatorId: 7 }, { userId: 999 });
  check("arg overrides config", r.ok && "userId" in r.value && r.value.userId === 7);
}

// --- rojo detection: never throws; returns a command string or null. A bogus
// explicit path falls back to PATH detection (null only when nothing is installed). ---
{
  let threw = false;
  let r;
  try {
    r = detectRojo("D:/definitely/not/rojo-xyzzy");
  } catch {
    threw = true;
  }
  check("detectRojo does not throw on a bogus path", threw === false);
  check("detectRojo returns string|null", r === null || typeof r === "string");
}

// --- key read with env unset + (likely) no file -> undefined, never throws ---
{
  const saved = process.env.ROBLOX_OPEN_CLOUD_KEY;
  delete process.env.ROBLOX_OPEN_CLOUD_KEY;
  let threw = false;
  let val;
  try {
    val = readKey();
  } catch {
    threw = true;
  }
  if (saved !== undefined) process.env.ROBLOX_OPEN_CLOUD_KEY = saved;
  check("readKey() does not throw with env unset", threw === false);
  check("readKey() returns string|undefined", val === undefined || typeof val === "string");
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
