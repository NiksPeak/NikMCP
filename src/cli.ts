// One-time setup subcommands for the single `nikmcp` bin. Persist the Open Cloud
// key (secret, separate credentials file) and creator (non-secret user config), and
// report configuration status with the key masked. Returns true if argv was a known
// subcommand (so index.ts skips starting the server).
import { writeKey, readKey, maskKey } from "./credentials.js";
import { writeUserConfig, resolveConfig } from "./config.js";
import { detectRojo } from "./rojo.js";

export function runCli(argv: string[]): boolean {
  const cmd = argv[0];

  if (cmd === "set-key") {
    const key = argv[1];
    if (!key) {
      console.error("usage: nikmcp set-key <KEY>");
      process.exitCode = 1;
      return true;
    }
    writeKey(key);
    console.log(`Open Cloud key saved (${maskKey(key)}).`);
    return true;
  }

  if (cmd === "set-creator") {
    const id = Number(argv[1]);
    if (!argv[1] || !Number.isFinite(id) || id <= 0) {
      console.error("usage: nikmcp set-creator <id> [--group]");
      process.exitCode = 1;
      return true;
    }
    const group = argv.includes("--group");
    const creator = group ? { groupId: Math.floor(id) } : { userId: Math.floor(id) };
    writeUserConfig({ creator });
    console.log(`Creator saved: ${group ? "group" : "user"} ${Math.floor(id)}.`);
    return true;
  }

  if (cmd === "doctor") {
    const key = readKey();
    const cfg = resolveConfig([]); // ignore doctor's own args as port flags
    const rojo = detectRojo(cfg.rojoPath);
    let creatorStr = "not set";
    if (cfg.creator?.userId) {
      creatorStr = `user ${cfg.creator.userId}`;
    } else if (cfg.creator?.groupId) {
      creatorStr = `group ${cfg.creator.groupId}`;
    }
    console.log("nikmcp doctor");
    console.log(`  key:     ${key ? maskKey(key) : "not set (run `nikmcp set-key <KEY>`)"}`);
    console.log(`  creator: ${creatorStr}`);
    console.log(`  rojo:    ${rojo ?? "not found (rokit add rojo-rbx/rojo)"}`);
    console.log(`  port:    ${cfg.port}`);
    return true;
  }

  return false;
}
