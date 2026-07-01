// rojo detection + XML(.rbxmx) -> binary(.rbxm) conversion.
//
// Open Cloud rejects XML rbxmx for animations; the proven path is to build the XML
// with rojo (the binary rbxm format is proprietary -- do NOT hand-roll a writer).
// rojo is an external dependency: if it's missing we fail with a clear, actionable
// error rather than faking an upload.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

export const ROJO_INSTALL_HINT =
  "rojo not found. Install it (e.g. `rokit add rojo-rbx/rojo` or `aftman add rojo-rbx/rojo`, " +
  "or from https://rojo.space) and ensure it is on PATH, or set rojoPath in config.";

// Candidate rojo commands, in priority order: explicit override, PATH, rokit/aftman
// tool-storage shims. Returns the first that responds to `--version`, else null.
export function detectRojo(rojoPath?: string): string | null {
  const home = homedir();
  const exe = process.platform === "win32" ? "rojo.exe" : "rojo";
  const candidates = [
    rojoPath,
    "rojo",
    join(home, ".rokit", "bin", exe),
    join(home, ".aftman", "bin", exe),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);

  for (const cand of candidates) {
    try {
      execFileSync(cand, ["--version"], { stdio: "ignore" });
      return cand;
    } catch {
      // not this one -- try the next candidate
    }
  }
  return null;
}

// Convert an .rbxmx (XML) string to binary .rbxm bytes via `rojo build`. rojo needs
// a project file, so we wrap the model file in a one-line project whose tree IS the
// model ({"$path":"in.rbxmx"}); the built root is the KeyframeSequence. Throws with
// rojo's own stderr on failure.
export function buildBinary(rojoCmd: string, rbxmx: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "nikmcp-anim-"));
  try {
    const inFile = join(dir, "in.rbxmx");
    const projFile = join(dir, "default.project.json");
    const outFile = join(dir, "out.rbxm");
    writeFileSync(inFile, rbxmx, "utf8");
    writeFileSync(
      projFile,
      JSON.stringify({ name: "NikMCPAnimation", tree: { $path: "in.rbxmx" } }, null, 2),
      "utf8"
    );
    try {
      execFileSync(rojoCmd, ["build", "default.project.json", "--output", "out.rbxm"], {
        cwd: dir,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim();
      throw new Error("rojo build failed: " + (stderr || String(e)));
    }
    return readFileSync(outFile);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp cleanup best-effort
    }
  }
}
