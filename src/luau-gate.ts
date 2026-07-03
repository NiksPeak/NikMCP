// Task 24 Part B: Luau analyze gate -- binary acquisition/resolution, spawn,
// diagnostic parsing. Dependency-free. Uses JohnnyMorganz/luau-lsp `analyze`
// (community-standard Roblox CI linter) with globalTypes.d.luau so `game`/`task`/
// `Instance` resolve. Fail-open: if the binary or definitions are unavailable the
// gate reports available:false and callers pass through (one stderr warn).

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nikmcpCacheDir } from "./api-dump.js";

// Pinned release: verified 2026-07-03. Do NOT float "latest" at runtime -- a
// floating analyzer can start flagging code Studio accepts.
const PINNED_TAG = "1.68.1";

const GLOBAL_TYPES_URL =
  "https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/main/scripts/globalTypes.d.luau";

function zipAssetName(): string {
  if (process.platform === "win32") return "luau-lsp-win64.zip";
  if (process.platform === "darwin") return "luau-lsp-macos.zip";
  return process.arch === "arm64" ? "luau-lsp-linux-arm64.zip" : "luau-lsp-linux-x86_64.zip";
}

function binaryName(): string {
  return process.platform === "win32" ? "luau-lsp.exe" : "luau-lsp";
}

export interface Diagnostic {
  line: number;
  col: number;
  kind: string;
  message: string;
}

export interface AnalyzeResult {
  available: boolean;
  ok: boolean; // no blocking errors (always true when unavailable)
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

interface GateState {
  binary: string;
  typesPath: string;
  luaurcPath: string;
}

let state: GateState | null = null;
let initPromise: Promise<boolean> | null = null;
let warnedUnavailable = false;

function warnOnce(msg: string): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.error(`[luau-gate] ${msg} -- Luau analyze gate passes through`);
}

async function fetchBuffer(url: string, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Dependency-free unzip is not worth writing: shell out to Expand-Archive on
// win32 / unzip elsewhere. Any failure -> gate unavailable, never fatal.
function extractZip(zipPath: string, destDir: string): boolean {
  try {
    if (process.platform === "win32") {
      const r = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destDir}'`,
        ],
        { timeout: 60000 }
      );
      return r.status === 0;
    }
    const r = spawnSync("unzip", ["-o", zipPath, "-d", destDir], { timeout: 60000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function binaryWorks(path: string): boolean {
  try {
    const r = spawnSync(path, ["--version"], { timeout: 10000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

// Resolution order: config path -> cache bin/ -> PATH lookup -> (optional)
// download the pinned release -> gate disabled with a single stderr warning.
async function resolveBinary(opts: {
  luauLspPath?: string;
  allowDownload: boolean;
}): Promise<string | null> {
  if (opts.luauLspPath) {
    if (binaryWorks(opts.luauLspPath)) return opts.luauLspPath;
    warnOnce(`configured luauLspPath does not run: ${opts.luauLspPath}`);
    return null;
  }

  const binDir = join(nikmcpCacheDir(), "bin");
  const cached = join(binDir, binaryName());
  if (existsSync(cached) && binaryWorks(cached)) return cached;

  if (binaryWorks("luau-lsp")) return "luau-lsp";

  if (!opts.allowDownload) return null;

  try {
    mkdirSync(binDir, { recursive: true });
    const asset = zipAssetName();
    const url = `https://github.com/JohnnyMorganz/luau-lsp/releases/download/${PINNED_TAG}/${asset}`;
    const zip = await fetchBuffer(url, 120000);
    const zipPath = join(binDir, asset);
    writeFileSync(zipPath, zip);
    if (!extractZip(zipPath, binDir)) {
      warnOnce(`could not extract ${asset}`);
      return null;
    }
    try {
      unlinkSync(zipPath);
    } catch {
      // leftover zip is harmless
    }
    if (process.platform !== "win32") {
      try {
        chmodSync(cached, 0o755);
      } catch {
        // chmod failure surfaces via binaryWorks below
      }
    }
    if (binaryWorks(cached)) {
      console.error(`[luau-gate] downloaded luau-lsp ${PINNED_TAG} -> ${cached}`);
      return cached;
    }
    warnOnce("downloaded binary does not run");
    return null;
  } catch (e) {
    warnOnce(`binary download failed (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

async function resolveDefinitions(allowDownload: boolean): Promise<string | null> {
  const dir = nikmcpCacheDir();
  const path = join(dir, "globalTypes.d.luau");
  if (existsSync(path)) return path;
  if (!allowDownload) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const buf = await fetchBuffer(GLOBAL_TYPES_URL, 60000);
    writeFileSync(path, buf);
    return path;
  } catch (e) {
    warnOnce(`globalTypes.d.luau download failed (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

function ensureLuaurc(): string | null {
  const dir = nikmcpCacheDir();
  const path = join(dir, ".luaurc");
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(path)) {
      // nonstrict default so untyped run_luau scratch snippets are not drowned in
      // strict-mode noise; a --!strict directive in the source still wins.
      writeFileSync(path, '{ "languageMode": "nonstrict" }\n');
    }
    return path;
  } catch {
    return null;
  }
}

// Idempotent init. allowDownload:false = resolve-only (used by the selftest so
// CI without the binary SKIPs instead of pulling a release).
export function initLuauGate(opts: {
  luauLspPath?: string;
  allowDownload?: boolean;
}): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const allowDownload = opts.allowDownload !== false;
    const binary = await resolveBinary({ luauLspPath: opts.luauLspPath, allowDownload });
    const typesPath = binary ? await resolveDefinitions(allowDownload) : null;
    const luaurcPath = binary && typesPath ? ensureLuaurc() : null;
    if (binary && typesPath && luaurcPath) {
      state = { binary, typesPath, luaurcPath };
      return true;
    }
    if (!binary) warnOnce("luau-lsp binary not found");
    else warnOnce("analyzer support files unavailable");
    return false;
  })();
  return initPromise;
}

// Fire-and-forget background start (never throws, never blocks MCP init).
export function startLuauGate(opts: { luauLspPath?: string }): void {
  void initLuauGate({ luauLspPath: opts.luauLspPath, allowDownload: true }).catch(() => {
    warnOnce("init error");
  });
}

// First gated call awaits readiness for at most maxWaitMs then passes through.
export async function luauGateReady(maxWaitMs: number): Promise<boolean> {
  if (state || !initPromise) return state !== null;
  await Promise.race([initPromise, new Promise((r) => setTimeout(r, maxWaitMs))]);
  return state !== null;
}

// Diagnostic lines look like: `file.luau(3,5): TypeError: Unknown global 'gme'`
// (verified against luau-lsp 1.68.1 output). SyntaxError/TypeError block;
// every other kind (LocalUnused, MultiLineStatement, ...) is a lint warning.
const DIAG_RE = /^.*\((\d+),(\d+)\): ([A-Za-z]+): (.*)$/;
const ERROR_KINDS = new Set(["SyntaxError", "TypeError"]);

// TypeErrors about DYNAMIC DataModel content are statically unknowable without a
// Rojo sourcemap (globalTypes declares Instance classes as closed extern types),
// so `game.Workspace.MyPart` -- the most common run_luau shape -- would false-
// positive. Demote exactly that class to warnings; real TypeErrors (unknown
// global, calling nil, bad arg types) still block.
const DEMOTED_TYPEERRORS = [
  /^Key '.+' not found in (external type|class|table) '/,
  /^Unknown require:/,
];

function parseDiagnostics(text: string): { errors: Diagnostic[]; warnings: Diagnostic[] } {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("[INFO]")) continue;
    const m = DIAG_RE.exec(line);
    if (!m) continue;
    const d: Diagnostic = {
      line: parseInt(m[1], 10),
      col: parseInt(m[2], 10),
      kind: m[3],
      message: m[4],
    };
    const demoted =
      d.kind === "TypeError" && DEMOTED_TYPEERRORS.some((re) => re.test(d.message));
    if (ERROR_KINDS.has(d.kind) && !demoted) errors.push(d);
    else warnings.push(d);
  }
  return { errors, warnings };
}

export async function analyzeLuau(source: string): Promise<AnalyzeResult> {
  const s = state;
  if (!s) return { available: false, ok: true, errors: [], warnings: [] };

  const tmp = join(
    tmpdir(),
    `nikmcp-analyze-${process.pid}-${Math.random().toString(36).slice(2)}.luau`
  );
  try {
    writeFileSync(tmp, source);
  } catch (e) {
    warnOnce(`temp file write failed (${e instanceof Error ? e.message : String(e)})`);
    return { available: false, ok: true, errors: [], warnings: [] };
  }

  try {
    const output = await new Promise<string | null>((resolve) => {
      // --no-strict-dm-types: without it, luau-lsp treats the DataModel as a
      // closed type and flags every dot-child access (game.Workspace.MyPart)
      // as a TypeError -- the most common run_luau shape would false-positive.
      const child = spawn(s.binary, [
        "analyze",
        "--no-strict-dm-types",
        `--definitions=${s.typesPath}`,
        `--base-luaurc=${s.luaurcPath}`,
        tmp,
      ]);
      let out = "";
      let done = false;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      // 10s cap: kill on expiry -> "gate unavailable" for THIS call only.
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        finish(null);
      }, 10000);
      child.stdout.on("data", (b: Buffer) => (out += b.toString()));
      child.stderr.on("data", (b: Buffer) => (out += b.toString()));
      child.on("error", () => finish(null));
      child.on("close", () => finish(out));
    });

    if (output === null) {
      console.error("[luau-gate] analyze timed out/failed for one call -- passing through");
      return { available: false, ok: true, errors: [], warnings: [] };
    }
    const { errors, warnings } = parseDiagnostics(output);
    return { available: true, ok: errors.length === 0, errors, warnings };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
  }
}

// Test hook: expose the parser so the selftest can exercise classification
// without spawning.
export const _internal = { parseDiagnostics };
