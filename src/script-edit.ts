// v0.2.0: pure logic for edit_script (exact-string replace + unified-diff patch),
// get_script_source line ranges, whitespace-insensitive source comparison, and
// the in-memory pre-write script backup ring. Dependency-free so
// tests/script-edit-unit.mjs can exercise it offline; bridge calls stay in
// mcp-server.ts. All logs to stderr (stdout is MCP JSON-RPC).

import { fnv1a32, normalizeSource } from "./sync.js";

// ---------- exact-string replace ---------------------------------------------------

export interface ReplaceOptions {
  replaceAll?: boolean;
  expectedMatches?: number;
}

export interface ReplaceOutcome {
  source: string;
  matches: number;
}

function countOccurrences(source: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  for (;;) {
    const at = source.indexOf(needle, cursor);
    if (at < 0) return count;
    count += 1;
    cursor = at + needle.length;
  }
}

// Mirrors the file-Edit-tool contract: oldString must match EXACTLY once unless
// replaceAll (or an explicit expectedMatches) says otherwise. Zero matches is an
// error that names the closest line so the caller can re-anchor without a full
// re-read.
export function applyExactReplace(
  currentSource: string,
  oldString: string,
  newString: string,
  opts: ReplaceOptions = {},
): ReplaceOutcome {
  const source = normalizeSource(currentSource);
  const oldText = normalizeSource(oldString);
  const newText = normalizeSource(newString);
  if (oldText.length === 0) throw new Error("oldString must not be empty");
  if (oldText === newText) throw new Error("oldString and newString are identical (no-op)");
  const matches = countOccurrences(source, oldText);
  if (matches === 0) {
    throw new Error(
      `oldString not found in script (0 matches). ${nearestLineHint(source, oldText)}`,
    );
  }
  const expected = opts.replaceAll ? matches : (opts.expectedMatches ?? 1);
  if (!Number.isInteger(expected) || expected < 1 || expected > 1000) {
    throw new Error("expectedMatches must be an integer between 1 and 1000");
  }
  if (matches !== expected) {
    throw new Error(
      `oldString matched ${matches} time(s) but ${expected} expected; add more surrounding ` +
        "context to make it unique, or pass replaceAll:true / expectedMatches",
    );
  }
  return { source: source.split(oldText).join(newText), matches };
}

// When an anchor misses, the most common cause is a whitespace or one-token
// drift. Report the line whose trimmed text best matches the first non-blank
// line of the anchor so the caller can re-read just that region.
function nearestLineHint(source: string, oldText: string): string {
  const firstAnchor = oldText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstAnchor) return "";
  const lines = source.split("\n");
  const probe = firstAnchor.slice(0, 40);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(probe)) {
      return `Closest match for the anchor's first line is at line ${i + 1}: ${JSON.stringify(lines[i].trim().slice(0, 120))}`;
    }
  }
  const loose = probe.replace(/\s+/g, "");
  if (loose.length >= 8) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].replace(/\s+/g, "").includes(loose)) {
        return `A whitespace-different version of the anchor's first line is at line ${i + 1}: ${JSON.stringify(lines[i].trim().slice(0, 120))}`;
      }
    }
  }
  return "No line resembles the anchor's first line; re-read the script before retrying.";
}

// ---------- unified diff apply ----------------------------------------------------

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: { op: " " | "-" | "+"; text: string }[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(patchText: string): Hunk[] {
  const text = normalizeSource(patchText);
  const lines = text.split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("diff ") || raw.startsWith("index ")) {
      if (!current) continue; // file header
    }
    const m = HUNK_RE.exec(raw);
    if (m) {
      current = {
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (raw.trim() === "") continue;
      throw new Error(`patch line ${i + 1} appears before any @@ hunk header: ${JSON.stringify(raw.slice(0, 80))}`);
    }
    if (raw === "" && i === lines.length - 1) continue; // trailing newline
    if (raw.startsWith("\\ No newline")) continue;
    const op = raw[0];
    if (op === " " || op === "-" || op === "+") {
      current.lines.push({ op, text: raw.slice(1) });
    } else if (raw === "") {
      // Some producers emit an empty context line without the leading space.
      current.lines.push({ op: " ", text: "" });
    } else {
      throw new Error(`patch line ${i + 1} has no +/-/space prefix: ${JSON.stringify(raw.slice(0, 80))}`);
    }
  }
  if (hunks.length === 0) throw new Error("patch contains no @@ hunks");
  for (const h of hunks) {
    const oldSeen = h.lines.filter((l) => l.op !== "+").length;
    const newSeen = h.lines.filter((l) => l.op !== "-").length;
    // Tolerate off-by-header-count patches (hand-written), but not empty hunks.
    if (h.lines.length === 0) throw new Error("patch contains an empty hunk");
    h.oldCount = oldSeen;
    h.newCount = newSeen;
  }
  return hunks;
}

export interface PatchOutcome {
  source: string;
  hunks: { index: number; appliedAt: number; offset: number; fuzz: number }[];
}

function hunkOldLines(h: Hunk): string[] {
  return h.lines.filter((l) => l.op !== "+").map((l) => l.text);
}

function hunkNewLines(h: Hunk): string[] {
  return h.lines.filter((l) => l.op !== "-").map((l) => l.text);
}

function linesMatchAt(lines: string[], at: number, expected: string[], fuzz: number): boolean {
  if (at < 0 || at + expected.length > lines.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    const a = lines[at + i];
    const b = expected[i];
    if (a === b) continue;
    if (fuzz >= 1 && a.trimEnd() === b.trimEnd()) continue;
    if (fuzz >= 2 && a.trim() === b.trim()) continue;
    return false;
  }
  return true;
}

// Locate each hunk's old-side lines: exact position first, then the nearest
// offset in either direction, then whitespace-fuzzy variants. Hunks apply in
// order and later hunks account for earlier line-count deltas.
export function applyUnifiedPatch(currentSource: string, patchText: string): PatchOutcome {
  const hunks = parseUnifiedDiff(patchText);
  let lines = normalizeSource(currentSource).split("\n");
  let delta = 0;
  const applied: PatchOutcome["hunks"] = [];
  for (let index = 0; index < hunks.length; index += 1) {
    const h = hunks[index];
    const oldLines = hunkOldLines(h);
    const newLines = hunkNewLines(h);
    const anchor = Math.max(0, h.oldStart - 1 + delta);
    let found = -1;
    let usedFuzz = 0;
    if (oldLines.length === 0) {
      found = Math.min(anchor, lines.length);
    } else {
      search: for (let fuzz = 0; fuzz <= 2; fuzz += 1) {
        for (let radius = 0; radius <= lines.length; radius += 1) {
          const candidates = radius === 0 ? [anchor] : [anchor - radius, anchor + radius];
          for (const at of candidates) {
            if (linesMatchAt(lines, at, oldLines, fuzz)) {
              found = at;
              usedFuzz = fuzz;
              break search;
            }
          }
          if (anchor - radius < 0 && anchor + radius > lines.length) break;
        }
      }
    }
    if (found < 0) {
      const preview = oldLines.slice(0, 3).map((l) => JSON.stringify(l)).join(", ");
      throw new Error(
        `hunk ${index + 1} (@@ -${h.oldStart},${h.oldCount} @@) does not match the current source ` +
          `anywhere (first old lines: ${preview}); re-read the script and regenerate the patch`,
      );
    }
    lines = [...lines.slice(0, found), ...newLines, ...lines.slice(found + oldLines.length)];
    applied.push({ index: index + 1, appliedAt: found + 1, offset: found - anchor, fuzz: usedFuzz });
    delta += newLines.length - oldLines.length;
  }
  return { source: lines.join("\n"), hunks: applied };
}

// ---------- line ranges (get_script_source offset/limit) --------------------------

export interface LineSlice {
  source: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export function sliceLines(source: string, startLine?: number, lineCount?: number, maxBytes?: number): LineSlice {
  const lines = normalizeSource(source).split("\n");
  const total = lines.length;
  const start = Math.max(1, Math.min(total, Math.floor(startLine ?? 1)));
  const count = lineCount === undefined ? total - start + 1 : Math.max(0, Math.floor(lineCount));
  let end = Math.min(total, start + count - 1);
  let picked = lines.slice(start - 1, end);
  let truncated = end < total || start > 1;
  if (maxBytes !== undefined && maxBytes > 0) {
    let bytes = 0;
    let keep = 0;
    for (const l of picked) {
      const b = Buffer.byteLength(l, "utf8") + 1;
      if (bytes + b > maxBytes && keep > 0) break;
      bytes += b;
      keep += 1;
    }
    if (keep < picked.length) {
      picked = picked.slice(0, keep);
      end = start + keep - 1;
      truncated = true;
    }
  }
  return { source: picked.join("\n"), startLine: start, endLine: end, totalLines: total, truncated };
}

// ---------- whitespace-insensitive equality (manifest-stale detection) --------------

// CRLF->LF, tabs->4 spaces, trailing whitespace per line stripped, trailing
// blank lines dropped. Two sources equal under this are "the same code"; the
// sync manifest treats them as convergent instead of CONFLICT.
export function normalizeForCompare(source: string): string {
  return normalizeSource(source)
    .split("\n")
    .map((l) => l.replace(/\t/g, "    ").replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n+$/g, "");
}

export function sameIgnoringWhitespace(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

// ---------- pre-write backup ring -------------------------------------------------

export interface ScriptBackup {
  path: string;
  hash: string;
  source: string;
  takenAt: string;
  tool: string;
  bytes: number;
}

export class ScriptBackupRing {
  readonly #byPath = new Map<string, ScriptBackup[]>();

  constructor(
    private readonly perPath = 5,
    private readonly maxPaths = 40,
    private readonly maxTotalBytes = 25_000_000,
  ) {}

  // Skips a duplicate of the most recent backup for that path (same hash) so
  // repeated no-op writes do not churn the ring.
  record(path: string, source: string, tool: string, nowMs = Date.now()): ScriptBackup | null {
    const normalized = normalizeSource(source);
    const hash = fnv1a32(normalized);
    const list = this.#byPath.get(path) ?? [];
    if (list.length > 0 && list[0].hash === hash) {
      this.#touch(path, list);
      return null;
    }
    const entry: ScriptBackup = {
      path,
      hash,
      source: normalized,
      takenAt: new Date(nowMs).toISOString(),
      tool,
      bytes: Buffer.byteLength(normalized, "utf8"),
    };
    list.unshift(entry);
    while (list.length > this.perPath) list.pop();
    this.#touch(path, list);
    this.#enforceCaps();
    return entry;
  }

  #touch(path: string, list: ScriptBackup[]): void {
    this.#byPath.delete(path);
    this.#byPath.set(path, list);
  }

  #enforceCaps(): void {
    while (this.#byPath.size > this.maxPaths) {
      const oldest = this.#byPath.keys().next().value;
      if (oldest === undefined) break;
      this.#byPath.delete(oldest);
    }
    let total = this.totalBytes();
    while (total > this.maxTotalBytes && this.#byPath.size > 0) {
      const oldest = this.#byPath.keys().next().value;
      if (oldest === undefined) break;
      const list = this.#byPath.get(oldest) ?? [];
      const dropped = list.pop();
      if (dropped) total -= dropped.bytes;
      if (list.length === 0) this.#byPath.delete(oldest);
    }
  }

  totalBytes(): number {
    let total = 0;
    for (const list of this.#byPath.values()) for (const b of list) total += b.bytes;
    return total;
  }

  get(path: string, index = 0): ScriptBackup | null {
    const list = this.#byPath.get(path);
    if (!list || index < 0 || index >= list.length) return null;
    return list[index];
  }

  list(path?: string): Omit<ScriptBackup, "source">[] {
    const rows: Omit<ScriptBackup, "source">[] = [];
    for (const [p, list] of this.#byPath) {
      if (path && p !== path) continue;
      for (const b of list) {
        const { source: _source, ...rest } = b;
        rows.push(rest);
      }
    }
    return rows;
  }

  get size(): number {
    let n = 0;
    for (const list of this.#byPath.values()) n += list.length;
    return n;
  }
}
