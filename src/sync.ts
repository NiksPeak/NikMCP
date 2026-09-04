// Task 25: disk<->Studio script sync -- Node orchestration. Dependency-free.
// Pure logic (hashing, mapping, drift classification, diff, manifest shapes)
// lives here so tests/sync-unit.mjs can exercise it offline; the bridge calls
// happen in mcp-server.ts. All logs to stderr (stdout is MCP JSON-RPC).

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, dirname, sep } from "node:path";

// ---------- FNV-1a 32-bit ------------------------------------------------------
// MUST stay bit-identical to fnv1a32 in plugin/src/Executor.luau.
// Test vectors: "" = 811c9dc5, "a" = e40c292c, "hello" = 4f9f2cab, "foobar" = bf9cf968.
export function fnv1a32(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// CRLF -> LF on disk-read AND before every hash on BOTH sides -- otherwise
// Windows editors create false drift on every file.
export function normalizeSource(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

// ---------- disk mapping (Rojo-compatible naming) --------------------------------

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "").trim();
  return cleaned === "" ? "_" : cleaned;
}

export function scriptFileName(name: string, className: string, asInit: boolean): string {
  const ext =
    className === "Script"
      ? ".server.luau"
      : className === "LocalScript"
        ? ".client.luau"
        : ".luau";
  return asInit ? `init${ext}` : `${sanitizeName(name)}${ext}`;
}

export interface SyncListEntry {
  path: string; // DataModel path from GetFullName (no "game." prefix)
  className: string;
  hash: string;
  hasChildren: boolean; // has a LuaSourceContainer descendant
}

export interface PlannedFile {
  relPath: string; // POSIX-style relative path inside the export dir
  entry: SyncListEntry;
}

export interface ExportPlan {
  files: PlannedFile[];
  // Same-named siblings share one GetFullName, and the whole transport is
  // path-addressed (FindFirstChild resolves the first only), so only the FIRST
  // sibling is exportable; the rest are reported here, never silently dropped.
  duplicates: { path: string; count: number }[];
}

interface TreeNode {
  children: Map<string, TreeNode>; // key = raw child segment name (+ #n for dup ordinal)
  entry?: SyncListEntry;
}

// entries -> disk tree. Scripts with script-descendants become folders with an
// init.*.luau; containers appear as plain folders (only script-bearing paths
// ever reach this function). Sibling disk-name collisions get __2/__3 suffixes.
export function planExport(entries: SyncListEntry[]): ExportPlan {
  const root: TreeNode = { children: new Map() };
  const byPath = new Map<string, SyncListEntry[]>();
  for (const e of entries) {
    const arr = byPath.get(e.path) ?? [];
    arr.push(e);
    byPath.set(e.path, arr);
  }
  const duplicates: { path: string; count: number }[] = [];
  for (const [p, arr] of byPath) {
    if (arr.length > 1) duplicates.push({ path: p, count: arr.length });
  }

  // Only the first entry per identical path is placeable (see ExportPlan note).
  for (const [path, arr] of byPath) {
    const e = arr[0];
    const segs = path.split(".");
    let node = root;
    for (const seg of segs) {
      let child = node.children.get(seg);
      if (!child) {
        child = { children: new Map() };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.entry = e;
  }

  const files: PlannedFile[] = [];
  function walk(node: TreeNode, diskPath: string) {
    // Assign disk names for this node's children with sibling dedup.
    const used = new Map<string, number>(); // diskName(lower) -> count
    for (const [seg, child] of node.children) {
      const isScript = child.entry !== undefined;
      const hasScriptKids = child.children.size > 0;
      const base = sanitizeName(seg);
      // Disk identity this child claims at this level:
      const claim = isScript && !hasScriptKids
        ? scriptFileName(seg, child.entry!.className, false)
        : base; // folder (container, or script-with-children folder)
      const key = claim.toLowerCase();
      const n = (used.get(key) ?? 0) + 1;
      used.set(key, n);
      const suffix = n > 1 ? `__${n}` : "";

      if (isScript && !hasScriptKids) {
        const fileName = suffix
          ? claim.replace(/(\.server\.luau|\.client\.luau|\.luau)$/, `${suffix}$1`)
          : claim;
        files.push({ relPath: diskPath ? `${diskPath}/${fileName}` : fileName, entry: child.entry! });
      } else {
        const folder = base + suffix;
        const folderPath = diskPath ? `${diskPath}/${folder}` : folder;
        if (isScript) {
          files.push({
            relPath: `${folderPath}/${scriptFileName(seg, child.entry!.className, true)}`,
            entry: child.entry!,
          });
        }
        walk(child, folderPath);
      }
    }
  }
  walk(root, "");
  return { files, duplicates };
}

// ---------- manifest -------------------------------------------------------------

export const MANIFEST_NAME = "nikmcp-sync.json";

export interface ManifestEntry {
  dataModelPath: string;
  className: string;
  hash: string;
}

export interface Manifest {
  roots: string[];
  exportedAt: string;
  placeName: string;
  files: Record<string, ManifestEntry>; // key = relPath
}

export function readManifest(dir: string): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), "utf8")) as Manifest;
    if (m && typeof m === "object" && m.files && typeof m.files === "object") return m;
    return null;
  } catch {
    return null;
  }
}

export function writeManifestAtomic(dir: string, manifest: Manifest): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${MANIFEST_NAME}.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, join(dir, MANIFEST_NAME));
}

// ---------- drift classification ---------------------------------------------------

export type DriftState =
  | "clean"
  | "diskAhead"
  | "studioAhead"
  | "conflict"
  | "missingInStudio"
  | "missingOnDisk";

// Three-way: manifest hash is the common ancestor; null disk/studio hash = gone.
export function classify(
  manifestHash: string,
  diskHash: string | null,
  studioHash: string | null
): DriftState {
  if (studioHash === null) return "missingInStudio";
  if (diskHash === null) return "missingOnDisk";
  const diskChanged = diskHash !== manifestHash;
  const studioChanged = studioHash !== manifestHash;
  if (diskChanged && studioChanged) {
    // Both moved to the SAME content = convergent edit, importable as clean.
    return diskHash === studioHash ? "clean" : "conflict";
  }
  if (diskChanged) return "diskAhead";
  if (studioChanged) return "studioAhead";
  return "clean";
}

export interface StatusEntry {
  relPath: string;
  dataModelPath: string;
  className: string;
  state: DriftState;
}

export interface ImportDecision {
  action: "abort" | "proceed";
  conflicts: StatusEntry[];
  apply: StatusEntry[]; // diskAhead
  skippedStudioAhead: StatusEntry[];
  missing: StatusEntry[]; // missingInStudio + missingOnDisk
}

// The drift doctrine as code: ANY conflict aborts the ENTIRE import; studioAhead
// and missing entries are reported and skipped but never block.
export function decideImport(status: StatusEntry[]): ImportDecision {
  const conflicts = status.filter((s) => s.state === "conflict");
  const apply = status.filter((s) => s.state === "diskAhead");
  const skippedStudioAhead = status.filter((s) => s.state === "studioAhead");
  const missing = status.filter(
    (s) => s.state === "missingInStudio" || s.state === "missingOnDisk"
  );
  return {
    action: conflicts.length > 0 ? "abort" : "proceed",
    conflicts,
    apply,
    skippedStudioAhead,
    missing,
  };
}

// ---------- v0.2.0: protected paths + manifest rebase --------------------------------

// Bridge-critical scripts the plugin injects itself. Sync must never export
// them as user code or overwrite them from disk: a stale on-disk copy of
// MCP_RuntimeAgent would strand the F5 agent on a dead port/token.
const PROTECTED_LEAF_RE = /^(MCP_RuntimeAgent|NikMCP_ClientAgent|NikMCP_ClientRelay|__MCP_CommandListener|__MCP_[A-Za-z0-9_]+)$/;

export function isProtectedSyncPath(dataModelPath: string): boolean {
  const leaf = dataModelPath.split(".").pop() ?? "";
  return PROTECTED_LEAF_RE.test(leaf);
}

export interface RebaseRow {
  relPath: string;
  dataModelPath: string;
  state: DriftState;
  diskHash: string | null;
  studioHash: string | null;
  whitespaceEqual?: boolean;
}

export type RebaseAccept = "equal" | "studio" | "disk";

export interface RebaseOutcome {
  rebased: { relPath: string; dataModelPath: string; from: string; to: string; reason: string }[];
  skipped: { relPath: string; dataModelPath: string; state: DriftState; reason: string }[];
}

// Rewrites manifest baseline hashes WITHOUT touching any file content.
//   equal : only rows whose disk and Studio content already agree (byte or
//           whitespace-equal) -> they become clean. Safe default.
//   studio: baseline := Studio hash. Disk edits then read as diskAhead.
//   disk  : baseline := disk hash. Studio edits then read as studioAhead.
// Rows outside `paths` (when given) are untouched. Missing sides are skipped.
export function rebaseManifest(
  manifest: Manifest,
  rows: RebaseRow[],
  accept: RebaseAccept,
  paths?: Set<string>,
): RebaseOutcome {
  const out: RebaseOutcome = { rebased: [], skipped: [] };
  for (const row of rows) {
    const entry = manifest.files[row.relPath];
    if (!entry) continue;
    if (paths && !paths.has(row.relPath) && !paths.has(row.dataModelPath)) continue;
    const skip = (reason: string) =>
      out.skipped.push({ relPath: row.relPath, dataModelPath: row.dataModelPath, state: row.state, reason });
    if (row.studioHash === null && accept !== "disk") {
      skip("script missing in Studio");
      continue;
    }
    if (row.diskHash === null && accept !== "studio") {
      skip("file missing on disk");
      continue;
    }
    let to: string | null = null;
    let reason = "";
    if (accept === "equal") {
      if (row.diskHash !== null && row.diskHash === row.studioHash) {
        to = row.diskHash;
        reason = "disk and Studio hashes already agree";
      } else if (row.whitespaceEqual) {
        // Both sides are the same code modulo whitespace; take Studio's hash so
        // the next status reads clean against the live place.
        to = row.studioHash;
        reason = "disk and Studio are whitespace-equal";
      } else {
        skip(row.state === "clean" ? "already clean" : "disk and Studio differ (use accept:'studio' or 'disk')");
        continue;
      }
    } else if (accept === "studio") {
      to = row.studioHash;
      reason = "accepted Studio as baseline";
    } else {
      to = row.diskHash;
      reason = "accepted disk as baseline";
    }
    if (to === null) {
      skip("no hash available on the accepted side");
      continue;
    }
    if (entry.hash === to) {
      skip("baseline already matches");
      continue;
    }
    out.rebased.push({ relPath: row.relPath, dataModelPath: row.dataModelPath, from: entry.hash, to, reason });
    entry.hash = to;
  }
  return out;
}

// ---------- diff (conflict reporting) ------------------------------------------------
// Whitespace-normalized per the drift doctrine: tabs expanded, LF-normalized.
// Deliberately simple: trim common prefix/suffix, emit one unified-style hunk
// with the changed middle. This is a REVIEW aid, not a merge tool.

function normalizeForDiff(s: string): string[] {
  return normalizeSource(s)
    .replace(/\t/g, "    ")
    .split("\n");
}

export function unifiedDiff(aText: string, bText: string, cap = 120): string {
  const a = normalizeForDiff(aText);
  const b = normalizeForDiff(bText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  if (removed.length === 0 && added.length === 0) {
    return "(no line-level difference after whitespace normalization)";
  }
  const lines: string[] = [
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
  ];
  const push = (prefix: string, arr: string[]) => {
    const shown = arr.slice(0, cap);
    for (const l of shown) lines.push(prefix + l);
    if (arr.length > cap) lines.push(`${prefix}... (${arr.length - cap} more lines)`);
  };
  push("-", removed);
  push("+", added);
  return lines.join("\n");
}

// ---------- disk IO helpers -----------------------------------------------------------

export function readDiskSource(dir: string, relPath: string): string | null {
  try {
    return normalizeSource(readFileSync(join(dir, relPath), "utf8"));
  } catch {
    return null;
  }
}

export function writeDiskSource(dir: string, relPath: string, source: string): number {
  const full = join(dir, relPath.split("/").join(sep));
  mkdirSync(dirname(full), { recursive: true });
  const data = normalizeSource(source);
  writeFileSync(full, data);
  return Buffer.byteLength(data, "utf8");
}

// *.luau files under dir that the manifest does not know about (reported, never
// touched -- v1 import updates existing scripts only).
export function findUnknownFiles(dir: string, manifest: Manifest): string[] {
  const known = new Set(Object.keys(manifest.files));
  const out: string[] = [];
  function walk(sub: string) {
    let names: string[];
    try {
      names = readdirSync(join(dir, sub.split("/").join(sep)));
    } catch {
      return;
    }
    for (const name of names) {
      const rel = sub ? `${sub}/${name}` : name;
      if (rel === MANIFEST_NAME || name.startsWith(`${MANIFEST_NAME}.tmp-`)) continue;
      let st;
      try {
        st = statSync(join(dir, rel.split("/").join(sep)));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(rel);
      else if (name.endsWith(".luau") && !known.has(rel)) out.push(rel);
    }
  }
  walk("");
  return out.sort();
}
