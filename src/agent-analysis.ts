// Deterministic, dependency-free analysis helpers for agent-facing MCP tools.
// These functions deliberately perform no filesystem, network, or Studio I/O.

import { fnv1a32 } from "./sync.js";

export interface AgentScript {
  path: string;
  source: string;
  className?: string;
  name?: string;
}

export interface RequireEdge {
  from: string;
  to: string;
}

export interface RequireGraphObject {
  edges?: readonly RequireEdge[];
  dependencies?: Readonly<Record<string, readonly string[]>>;
  result?: RequireGraphObject;
}

export type RequireGraph =
  | readonly RequireEdge[]
  | Readonly<Record<string, readonly string[]>>
  | RequireGraphObject;

export interface RelationshipInventoryItem {
  name: string;
  path?: string;
  paths?: readonly string[];
  users?: readonly string[];
  readers?: readonly string[];
  writers?: readonly string[];
  producers?: readonly string[];
  consumers?: readonly string[];
  locations?: readonly string[];
  scripts?: readonly string[];
  kind?: string;
}

export interface RemoteInventoryEntry {
  name: string;
  path?: string;
  className?: string;
  usages?: readonly { script?: string }[];
}

export interface DatastoreInventoryEntry {
  name: string;
  className?: string;
  declaredIn?: readonly { script?: string }[];
  operations?: readonly { script?: string }[];
}

export interface RelationshipInventoryObject {
  remotes?: readonly RemoteInventoryEntry[];
  stores?: readonly DatastoreInventoryEntry[];
  result?: RelationshipInventoryObject;
}

export type RelationshipInventory =
  | readonly RelationshipInventoryItem[]
  | Readonly<Record<string, readonly string[]>>
  | RelationshipInventoryObject;

export interface SourceProcessingOptions {
  maxScripts?: number;
  maxTotalSourceChars?: number;
  maxSourceCharsPerScript?: number;
}

export type InputCompletenessState = "complete" | "truncated" | "unknown";

export interface InputCompletenessEntry {
  state: InputCompletenessState;
  returned?: number;
  totalAvailable?: number;
  reason?: string;
}

export interface AnalysisInputCompleteness {
  scripts?: InputCompletenessEntry;
  requireGraph?: InputCompletenessEntry;
  remoteInventory?: InputCompletenessEntry;
  datastoreInventory?: InputCompletenessEntry;
}

export interface NormalizedInputCompleteness {
  scripts?: InputCompletenessEntry;
  requireGraph?: InputCompletenessEntry;
  remoteInventory?: InputCompletenessEntry;
  datastoreInventory?: InputCompletenessEntry;
  overall: "complete" | "partial" | "unknown";
}

export type AnalysisConfidence = "exact" | "heuristic";
export type FindingSeverity = "info" | "warning" | "high";

export type CodeHealthCategory =
  | "deprecated_global_wait"
  | "deprecated_global_spawn"
  | "deprecated_global_delay"
  | "numeric_require"
  | "dynamic_code_loadstring"
  | "environment_access_getfenv"
  | "environment_access_setfenv"
  | "datastore_setasync"
  | "remote_invokeclient"
  | "todo_marker"
  | "very_large_script";

export interface CodeHealthFinding {
  category: CodeHealthCategory;
  path: string;
  line: number;
  column: number;
  confidence: AnalysisConfidence;
  severity: FindingSeverity;
  message: string;
  excerpt: string;
}

export interface DuplicateSourceGroup {
  confidence: "exact";
  hash: string;
  normalizedChars: number;
  totalMembers: number;
  paths: string[];
  pathsTruncated: boolean;
}

export interface CodeHealthOptions extends SourceProcessingOptions {
  maxFindings?: number;
  maxDuplicateGroups?: number;
  maxDuplicateMembers?: number;
  largeScriptChars?: number;
  largeScriptLines?: number;
  maxExcerptChars?: number;
}

export interface CodeHealthResult {
  summary: {
    scriptsReceived: number;
    scriptsScanned: number;
    scriptsSkipped: number;
    sourceCharsReceived: number;
    sourceCharsProcessed: number;
    sourceTruncatedScripts: number;
    findingsDetected: number;
    findingsReturned: number;
    findingsTruncated: boolean;
    duplicateGroupsDetected: number;
    duplicateGroupsReturned: number;
    duplicateGroupsTruncated: boolean;
    exactFindings: number;
    heuristicFindings: number;
    countsByCategory: Partial<Record<CodeHealthCategory, number>>;
  };
  findings: CodeHealthFinding[];
  duplicates: DuplicateSourceGroup[];
}

export interface ContextOptions extends SourceProcessingOptions {
  maxResults?: number;
  maxReasons?: number;
  maxExcerptChars?: number;
  maxNeighborsPerType?: number;
  maxAnchors?: number;
  maxSeedPaths?: number;
  maxQueryChars?: number;
  inputCompleteness?: AnalysisInputCompleteness;
}

export interface NamedNeighbor {
  name: string;
  kind?: string;
  peers: string[];
  peersTruncated: boolean;
}

export interface RankedContextScript {
  path: string;
  className?: string;
  score: number;
  reasons: string[];
  excerpt?: {
    line: number;
    text: string;
    truncated: boolean;
  };
  neighbors: {
    dependencies: string[];
    dependents: string[];
    remotes: NamedNeighbor[];
    datastores: NamedNeighbor[];
  };
}

export interface TaskContextResult {
  summary: {
    query: string;
    seedPaths: string[];
    scriptsReceived: number;
    scriptsScanned: number;
    sourceCharsProcessed: number;
    sourceTruncatedScripts: number;
    queryTruncated: boolean;
    seedPathsTruncated: boolean;
    candidatesMatched: number;
    resultsReturned: number;
    resultsTruncated: boolean;
    inputCompleteness?: NormalizedInputCompleteness;
  };
  scripts: RankedContextScript[];
}

export interface ImpactOptions extends SourceProcessingOptions {
  maxDepth?: number;
  maxGraphNodes?: number;
  maxPeersPerRelationship?: number;
  maxRelationships?: number;
  maxLiteralReferences?: number;
  maxExcerptChars?: number;
  inputCompleteness?: AnalysisInputCompleteness;
}

export interface ImpactNode {
  path: string;
  depth: number;
}

export interface LiteralReference {
  path: string;
  confidence: AnalysisConfidence;
  matched: "full_path" | "name";
  line: number;
  excerpt: string;
}

export interface ImpactRelationship {
  name: string;
  kind?: string;
  peers: string[];
  peersTruncated: boolean;
}

export interface ChangeImpactResult {
  target: {
    requestedPath: string;
    resolvedPath: string | null;
    foundInScripts: boolean;
  };
  dependencies: {
    direct: string[];
    transitive: ImpactNode[];
    truncated: boolean;
  };
  dependents: {
    direct: string[];
    transitive: ImpactNode[];
    truncated: boolean;
  };
  remotePeers: ImpactRelationship[];
  datastorePeers: ImpactRelationship[];
  literalReferences: LiteralReference[];
  risk: {
    score: number;
    level: "low" | "medium" | "high" | "critical";
    factors: string[];
  };
  recommendations: string[];
  summary: {
    scriptsReceived: number;
    scriptsScanned: number;
    sourceCharsProcessed: number;
    sourceTruncatedScripts: number;
    graphCycleDetected: boolean;
    literalReferencesDetected: number;
    literalReferencesTruncated: boolean;
    relationshipsTruncated: boolean;
    inputCompleteness?: NormalizedInputCompleteness;
  };
}

interface ProcessedScript extends AgentScript {
  processedSource: string;
  sourceComplete: boolean;
  ordinal: number;
}

interface ProcessedScripts {
  scripts: ProcessedScript[];
  received: number;
  skipped: number;
  sourceCharsReceived: number;
  sourceCharsProcessed: number;
  truncatedScripts: number;
}

interface NormalizedGraph {
  dependencies: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
  displayPath: Map<string, string>;
}

interface NormalizedInventory {
  name: string;
  kind?: string;
  paths: string[];
}

interface CommentSpan {
  start: number;
  end: number;
  text: string;
}

const HARD_MAX_SCRIPTS = 2_000;
const HARD_MAX_TOTAL_SOURCE_CHARS = 8_000_000;
const HARD_MAX_SOURCE_CHARS_PER_SCRIPT = 500_000;
const HARD_MAX_FINDINGS = 1_000;
const HARD_MAX_RESULTS = 100;
const HARD_MAX_GRAPH_NODES = 500;
const HARD_MAX_RELATIONSHIPS = 100;
const HARD_MAX_EXCERPT_CHARS = 2_000;

function boundedInt(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function pathKey(path: string): string {
  return path.trim();
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "case", numeric: false });
}

function stableUnique(values: Iterable<string>): string[] {
  const byKey = new Map<string, string>();
  for (const raw of values) {
    const value = String(raw).trim();
    if (value === "") continue;
    const key = pathKey(value);
    const prior = byKey.get(key);
    if (prior === undefined || compareText(value, prior) < 0) byKey.set(key, value);
  }
  return [...byKey.values()].sort(compareText);
}

interface PathResolver {
  exact: Set<string>;
  folded: Map<string, string[]>;
}

function createPathResolver(paths: Iterable<string>): PathResolver {
  const exact = new Set<string>();
  const foldedSets = new Map<string, Set<string>>();
  for (const raw of paths) {
    const path = pathKey(raw);
    if (path === "") continue;
    exact.add(path);
    const foldedKey = path.toLowerCase();
    const candidates = foldedSets.get(foldedKey) ?? new Set<string>();
    candidates.add(path);
    foldedSets.set(foldedKey, candidates);
  }
  const folded = new Map<string, string[]>();
  for (const [key, candidates] of foldedSets) {
    folded.set(key, [...candidates].sort(compareText));
  }
  return { exact, folded };
}

function resolvePath(raw: string, resolver: PathResolver): string {
  const path = pathKey(raw);
  if (resolver.exact.has(path)) return path;
  const candidates = resolver.folded.get(path.toLowerCase()) ?? [];
  return candidates.length === 1 ? candidates[0] : path;
}

function normalizeInputCompleteness(
  input: AnalysisInputCompleteness | undefined,
  processed: ProcessedScripts,
): NormalizedInputCompleteness | undefined {
  const copy = (entry: InputCompletenessEntry | undefined): InputCompletenessEntry | undefined => {
    if (!entry) return undefined;
    return {
      state: entry.state,
      returned:
        typeof entry.returned === "number" && Number.isFinite(entry.returned)
          ? Math.max(0, Math.floor(entry.returned))
          : undefined,
      totalAvailable:
        typeof entry.totalAvailable === "number" && Number.isFinite(entry.totalAvailable)
          ? Math.max(0, Math.floor(entry.totalAvailable))
          : undefined,
      reason: typeof entry.reason === "string" ? entry.reason.slice(0, 500) : undefined,
    };
  };

  const scripts = copy(input?.scripts);
  const localTruncated = processed.skipped > 0 || processed.truncatedScripts > 0;
  const normalized: Omit<NormalizedInputCompleteness, "overall"> = {
    scripts: localTruncated
      ? {
          state: "truncated",
          returned: processed.scripts.length,
          totalAvailable: scripts?.totalAvailable ?? processed.received,
          reason: [
            scripts?.reason,
            processed.skipped > 0 ? `${processed.skipped} scripts skipped by local cap` : undefined,
            processed.truncatedScripts > 0
              ? `${processed.truncatedScripts} script sources locally truncated`
              : undefined,
          ]
            .filter((value): value is string => !!value)
            .join("; "),
        }
      : scripts,
    requireGraph: copy(input?.requireGraph),
    remoteInventory: copy(input?.remoteInventory),
    datastoreInventory: copy(input?.datastoreInventory),
  };
  const entries = Object.values(normalized).filter(
    (entry): entry is InputCompletenessEntry => !!entry,
  );
  if (entries.length === 0) return undefined;
  const overall: NormalizedInputCompleteness["overall"] = entries.some(
    (entry) => entry.state === "truncated",
  )
    ? "partial"
    : entries.some((entry) => entry.state === "unknown")
      ? "unknown"
      : "complete";
  return { ...normalized, overall };
}

function processScripts(input: readonly AgentScript[], options: SourceProcessingOptions): ProcessedScripts {
  const maxScripts = boundedInt(options.maxScripts, 500, 1, HARD_MAX_SCRIPTS);
  const maxTotal = boundedInt(
    options.maxTotalSourceChars,
    2_000_000,
    1,
    HARD_MAX_TOTAL_SOURCE_CHARS,
  );
  const maxPerScript = boundedInt(
    options.maxSourceCharsPerScript,
    200_000,
    1,
    HARD_MAX_SOURCE_CHARS_PER_SCRIPT,
  );
  const canonical = input
    .map((script, ordinal) => ({
      path: typeof script.path === "string" ? script.path.trim() : "",
      source: typeof script.source === "string" ? script.source : "",
      className: script.className,
      name: script.name,
      ordinal,
    }))
    .filter((script) => script.path !== "")
    .sort((a, b) => {
      const byPath = compareText(a.path, b.path);
      if (byPath !== 0) return byPath;
      const byClass = compareText(a.className ?? "", b.className ?? "");
      if (byClass !== 0) return byClass;
      const byName = compareText(a.name ?? "", b.name ?? "");
      if (byName !== 0) return byName;
      return compareText(a.source, b.source);
    });

  const selected = canonical.slice(0, maxScripts);
  const sourceCharsReceived = canonical.reduce((sum, script) => sum + script.source.length, 0);
  let remaining = maxTotal;
  let sourceCharsProcessed = 0;
  let truncatedScripts = 0;
  const scripts: ProcessedScript[] = selected.map((script, ordinal) => {
    const take = Math.max(0, Math.min(script.source.length, maxPerScript, remaining));
    const processedSource = script.source.slice(0, take);
    remaining -= take;
    sourceCharsProcessed += take;
    const sourceComplete = take === script.source.length;
    if (!sourceComplete) truncatedScripts += 1;
    return { ...script, processedSource, sourceComplete, ordinal };
  });

  return {
    scripts,
    received: input.length,
    skipped: Math.max(0, input.length - scripts.length),
    sourceCharsReceived,
    sourceCharsProcessed,
    truncatedScripts,
  };
}

function detectLongBracket(source: string, index: number): { equals: number; contentStart: number } | null {
  if (source[index] !== "[") return null;
  let cursor = index + 1;
  while (source[cursor] === "=") cursor += 1;
  if (source[cursor] !== "[") return null;
  return { equals: cursor - index - 1, contentStart: cursor + 1 };
}

function findLongBracketEnd(source: string, from: number, equals: number): number {
  const closer = `]${"=".repeat(equals)}]`;
  const found = source.indexOf(closer, from);
  return found === -1 ? source.length : found + closer.length;
}

function maskRange(chars: string[], source: string, start: number, end: number): void {
  for (let i = start; i < end; i += 1) {
    if (source[i] !== "\n" && source[i] !== "\r") chars[i] = " ";
  }
}

function maskLuau(source: string): { code: string; comments: CommentSpan[] } {
  const chars = source.split("");
  const comments: CommentSpan[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "-" && source[cursor + 1] === "-") {
      const long = detectLongBracket(source, cursor + 2);
      if (long) {
        const end = findLongBracketEnd(source, long.contentStart, long.equals);
        comments.push({ start: cursor, end, text: source.slice(cursor, end) });
        maskRange(chars, source, cursor, end);
        cursor = end;
        continue;
      }
      const newline = source.indexOf("\n", cursor + 2);
      const end = newline === -1 ? source.length : newline;
      comments.push({ start: cursor, end, text: source.slice(cursor, end) });
      maskRange(chars, source, cursor, end);
      cursor = end;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      const start = cursor;
      cursor += 1;
      let escaped = false;
      while (cursor < source.length) {
        const current = source[cursor];
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      maskRange(chars, source, start, cursor);
      continue;
    }
    if (char === "[") {
      const long = detectLongBracket(source, cursor);
      if (long) {
        const end = findLongBracketEnd(source, long.contentStart, long.equals);
        maskRange(chars, source, cursor, end);
        cursor = end;
        continue;
      }
    }
    cursor += 1;
  }
  return { code: chars.join(""), comments };
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function positionAt(starts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= index) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  return { line: lineIndex + 1, column: index - starts[lineIndex] + 1 };
}

function excerptAt(source: string, index: number, maxChars: number): string {
  const start = Math.max(0, source.lastIndexOf("\n", Math.max(0, index - 1)) + 1);
  const foundEnd = source.indexOf("\n", index);
  const end = foundEnd === -1 ? source.length : foundEnd;
  const line = source.slice(start, end).trim();
  return line.length <= maxChars ? line : `${line.slice(0, Math.max(0, maxChars - 3))}...`;
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") count += 1;
  return count;
}

function normalizedExactSource(source: string): string {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return withoutBom.replace(/\r\n?/g, "\n");
}

function isFunctionDefinition(code: string, callIndex: number): boolean {
  const prefix = code.slice(Math.max(0, callIndex - 40), callIndex);
  return /(?:^|\s)(?:local\s+)?function\s*$/.test(prefix);
}

export function analyzeCodeHealth(
  scripts: readonly AgentScript[],
  options: CodeHealthOptions = {},
): CodeHealthResult {
  const processed = processScripts(scripts, options);
  const maxFindings = boundedInt(options.maxFindings, 250, 1, HARD_MAX_FINDINGS);
  const maxDuplicateGroups = boundedInt(options.maxDuplicateGroups, 40, 1, 200);
  const maxDuplicateMembers = boundedInt(options.maxDuplicateMembers, 20, 2, 100);
  const maxExcerptChars = boundedInt(options.maxExcerptChars, 180, 40, HARD_MAX_EXCERPT_CHARS);
  const largeScriptChars = boundedInt(options.largeScriptChars, 60_000, 1_000, 500_000);
  const largeScriptLines = boundedInt(options.largeScriptLines, 1_200, 50, 20_000);
  const findings: CodeHealthFinding[] = [];
  const countsByCategory: Partial<Record<CodeHealthCategory, number>> = {};
  let findingsDetected = 0;
  let exactFindings = 0;
  let heuristicFindings = 0;

  const addFinding = (
    script: ProcessedScript,
    starts: readonly number[],
    category: CodeHealthCategory,
    index: number,
    confidence: AnalysisConfidence,
    severity: FindingSeverity,
    message: string,
  ): void => {
    findingsDetected += 1;
    countsByCategory[category] = (countsByCategory[category] ?? 0) + 1;
    if (confidence === "exact") exactFindings += 1;
    else heuristicFindings += 1;
    if (findings.length >= maxFindings) return;
    const position = positionAt(starts, Math.max(0, index));
    findings.push({
      category,
      path: script.path,
      line: position.line,
      column: position.column,
      confidence,
      severity,
      message,
      excerpt: excerptAt(script.processedSource, index, maxExcerptChars),
    });
  };

  for (const script of processed.scripts) {
    const source = script.processedSource;
    const starts = lineStarts(source);
    const masked = maskLuau(source);
    const code = masked.code;

    const globalNames = [
      ["wait", "deprecated_global_wait"],
      ["spawn", "deprecated_global_spawn"],
      ["delay", "deprecated_global_delay"],
    ] as const;
    for (const [name, category] of globalNames) {
      const explicit = new RegExp(`\\b_G\\s*\\.\\s*${name}\\s*\\(`, "g");
      for (const match of code.matchAll(explicit)) {
        addFinding(
          script,
          starts,
          category,
          match.index ?? 0,
          "exact",
          "warning",
          `Explicit _G.${name} call uses a deprecated scheduler global; use task.${name}.`,
        );
      }
      const bare = new RegExp(`(^|[^A-Za-z0-9_.:])(${name})\\s*\\(`, "gm");
      for (const match of code.matchAll(bare)) {
        const index = (match.index ?? 0) + match[1].length;
        if (isFunctionDefinition(code, index)) continue;
        addFinding(
          script,
          starts,
          category,
          index,
          "heuristic",
          "warning",
          `Bare ${name} call likely uses the deprecated scheduler global; verify it is not locally shadowed.`,
        );
      }
    }

    const numericRequire = /(^|[^A-Za-z0-9_.:])(require)\s*\(\s*\d[\d_]*\s*(?=\))/gm;
    for (const match of code.matchAll(numericRequire)) {
      const index = (match.index ?? 0) + match[1].length;
      if (isFunctionDefinition(code, index)) continue;
      addFinding(
        script,
        starts,
        "numeric_require",
        index,
        "exact",
        "high",
        "Numeric require loads an asset-backed module and should be reviewed for ownership and supply-chain risk.",
      );
    }

    const riskyGlobals = [
      ["loadstring", "dynamic_code_loadstring", "Dynamic code execution"],
      ["getfenv", "environment_access_getfenv", "Environment inspection"],
      ["setfenv", "environment_access_setfenv", "Environment mutation"],
    ] as const;
    for (const [name, category, label] of riskyGlobals) {
      const explicit = new RegExp(`\\b_G\\s*\\.\\s*${name}\\s*\\(`, "g");
      for (const match of code.matchAll(explicit)) {
        addFinding(
          script,
          starts,
          category,
          match.index ?? 0,
          "exact",
          "high",
          `${label} through _G.${name} requires explicit security review.`,
        );
      }
      const bare = new RegExp(`(^|[^A-Za-z0-9_.:])(${name})\\s*\\(`, "gm");
      for (const match of code.matchAll(bare)) {
        const index = (match.index ?? 0) + match[1].length;
        if (isFunctionDefinition(code, index)) continue;
        addFinding(
          script,
          starts,
          category,
          index,
          "heuristic",
          "high",
          `${label} through bare ${name} likely uses the global; verify local shadowing before remediation.`,
        );
      }
    }

    const methodPatterns = [
      [
        /:\s*SetAsync\s*\(/g,
        "datastore_setasync",
        "SetAsync method call may overwrite concurrent DataStore updates; prefer UpdateAsync when merging state.",
      ],
      [
        /:\s*InvokeClient\s*\(/g,
        "remote_invokeclient",
        "InvokeClient can indefinitely yield or trust a client response; prefer event-based or timeout-bounded flow.",
      ],
    ] as const;
    for (const [pattern, category, message] of methodPatterns) {
      for (const match of code.matchAll(pattern)) {
        addFinding(script, starts, category, match.index ?? 0, "heuristic", "high", message);
      }
    }

    for (const comment of masked.comments) {
      const marker = /\b(?:TODO|FIXME|HACK|XXX)\b/gi;
      for (const match of comment.text.matchAll(marker)) {
        addFinding(
          script,
          starts,
          "todo_marker",
          comment.start + (match.index ?? 0),
          "exact",
          "info",
          `Unresolved ${match[0].toUpperCase()} marker is present in a comment.`,
        );
      }
    }

    const lines = countLines(script.processedSource);
    if (script.source.length >= largeScriptChars || lines >= largeScriptLines) {
      const lineLabel = script.sourceComplete ? String(lines) : `${lines}+`;
      addFinding(
        script,
        starts,
        "very_large_script",
        0,
        "exact",
        "warning",
        `Script is large (${script.source.length} chars, ${lineLabel} lines); split cohesive systems before agent edits become brittle.`,
      );
    }
  }

  findings.sort(
    (a, b) =>
      compareText(a.path, b.path) ||
      a.line - b.line ||
      a.column - b.column ||
      compareText(a.category, b.category) ||
      compareText(a.confidence, b.confidence),
  );

  const duplicateMap = new Map<string, string[]>();
  for (const script of processed.scripts) {
    if (!script.sourceComplete) continue;
    const normalized = normalizedExactSource(script.source);
    if (normalized.trim() === "") continue;
    const members = duplicateMap.get(normalized) ?? [];
    members.push(script.path);
    duplicateMap.set(normalized, members);
  }
  const allDuplicates: DuplicateSourceGroup[] = [];
  for (const [normalized, members] of duplicateMap) {
    const paths = stableUnique(members);
    if (paths.length < 2) continue;
    allDuplicates.push({
      confidence: "exact",
      hash: fnv1a32(normalized),
      normalizedChars: normalized.length,
      totalMembers: paths.length,
      paths: paths.slice(0, maxDuplicateMembers),
      pathsTruncated: paths.length > maxDuplicateMembers,
    });
  }
  allDuplicates.sort(
    (a, b) =>
      b.totalMembers - a.totalMembers ||
      compareText(a.paths[0] ?? "", b.paths[0] ?? "") ||
      compareText(a.hash, b.hash),
  );
  const duplicates = allDuplicates.slice(0, maxDuplicateGroups);

  return {
    summary: {
      scriptsReceived: processed.received,
      scriptsScanned: processed.scripts.length,
      scriptsSkipped: processed.skipped,
      sourceCharsReceived: processed.sourceCharsReceived,
      sourceCharsProcessed: processed.sourceCharsProcessed,
      sourceTruncatedScripts: processed.truncatedScripts,
      findingsDetected,
      findingsReturned: findings.length,
      findingsTruncated: findingsDetected > findings.length,
      duplicateGroupsDetected: allDuplicates.length,
      duplicateGroupsReturned: duplicates.length,
      duplicateGroupsTruncated: allDuplicates.length > duplicates.length,
      exactFindings,
      heuristicFindings,
      countsByCategory,
    },
    findings,
    duplicates,
  };
}

function normalizeRequireGraph(
  graph: RequireGraph | undefined,
  knownPaths: readonly string[],
): NormalizedGraph {
  const resolver = createPathResolver(knownPaths);
  const displayPath = new Map<string, string>();
  for (const path of knownPaths) displayPath.set(pathKey(path), path);
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const addEdge = (rawFrom: unknown, rawTo: unknown): void => {
    if (typeof rawFrom !== "string" || typeof rawTo !== "string") return;
    const from = resolvePath(rawFrom, resolver);
    const to = resolvePath(rawTo, resolver);
    if (from === "" || to === "") return;
    const fromKey = pathKey(from);
    const toKey = pathKey(to);
    if (!displayPath.has(fromKey)) displayPath.set(fromKey, from);
    if (!displayPath.has(toKey)) displayPath.set(toKey, to);
    const deps = dependencies.get(fromKey) ?? new Set<string>();
    deps.add(toKey);
    dependencies.set(fromKey, deps);
    const users = dependents.get(toKey) ?? new Set<string>();
    users.add(fromKey);
    dependents.set(toKey, users);
  };

  if (Array.isArray(graph)) {
    for (const edge of graph) {
      if (edge && typeof edge === "object") {
        const candidate = edge as RequireEdge;
        addEdge(candidate.from, candidate.to);
      }
    }
  } else if (graph && typeof graph === "object") {
    const outer = graph as RequireGraphObject & Record<string, unknown>;
    const object =
      outer.result && typeof outer.result === "object"
        ? (outer.result as RequireGraphObject & Record<string, unknown>)
        : outer;
    if (Array.isArray(object.edges)) {
      for (const edge of object.edges) addEdge(edge.from, edge.to);
    }
    const record =
      object.dependencies && typeof object.dependencies === "object"
        ? object.dependencies
        : object.edges === undefined
          ? object
          : undefined;
    if (record) {
      for (const [from, tos] of Object.entries(record)) {
        if (!Array.isArray(tos)) continue;
        for (const to of tos) addEdge(from, to);
      }
    }
  }

  return { dependencies, dependents, displayPath };
}

function normalizeInventory(
  inventory: RelationshipInventory | undefined,
  knownPaths: readonly string[] = [],
): NormalizedInventory[] {
  if (!inventory) return [];
  const resolver = createPathResolver(knownPaths);
  const normalizePaths = (paths: Iterable<string>): string[] =>
    stableUnique([...paths].map((path) => resolvePath(path, resolver)));
  const output: NormalizedInventory[] = [];
  if (Array.isArray(inventory)) {
    for (const raw of inventory) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as RelationshipInventoryItem;
      const candidates: unknown[] = [
        item.path,
        ...(item.paths ?? []),
        ...(item.users ?? []),
        ...(item.readers ?? []),
        ...(item.writers ?? []),
        ...(item.producers ?? []),
        ...(item.consumers ?? []),
        ...(item.locations ?? []),
        ...(item.scripts ?? []),
      ];
      const paths = normalizePaths(
        candidates.filter((value): value is string => typeof value === "string"),
      );
      if (typeof item.name === "string" && item.name.trim() !== "" && paths.length > 0) {
        output.push({ name: item.name.trim(), kind: item.kind, paths });
      }
    }
  } else if (typeof inventory === "object") {
    const outer = inventory as RelationshipInventoryObject & Record<string, unknown>;
    const object =
      outer.result && typeof outer.result === "object"
        ? (outer.result as RelationshipInventoryObject & Record<string, unknown>)
        : outer;
    if (Array.isArray(object.remotes)) {
      const remoteEntries = object.remotes as readonly RemoteInventoryEntry[];
      for (const remote of remoteEntries) {
        if (!remote || typeof remote !== "object" || typeof remote.name !== "string") continue;
        const paths = normalizePaths([
          ...(typeof remote.path === "string" ? [remote.path] : []),
          ...(remote.usages ?? [])
            .map((usage) => usage.script)
            .filter((path): path is string => typeof path === "string"),
        ]);
        if (paths.length > 0) {
          output.push({ name: remote.name.trim(), kind: remote.className, paths });
        }
      }
    } else if (Array.isArray(object.stores)) {
      const storeEntries = object.stores as readonly DatastoreInventoryEntry[];
      for (const store of storeEntries) {
        if (!store || typeof store !== "object" || typeof store.name !== "string") continue;
        const paths = normalizePaths([
          ...(store.declaredIn ?? [])
            .map((usage) => usage.script)
            .filter((path): path is string => typeof path === "string"),
          ...(store.operations ?? [])
            .map((usage) => usage.script)
            .filter((path): path is string => typeof path === "string"),
        ]);
        if (paths.length > 0) {
          output.push({ name: store.name.trim(), kind: store.className, paths });
        }
      }
    } else {
      for (const [name, paths] of Object.entries(object)) {
        if (!Array.isArray(paths)) continue;
        const normalized = normalizePaths(
          paths.filter((value): value is string => typeof value === "string"),
        );
        if (name.trim() !== "" && normalized.length > 0) {
          output.push({ name: name.trim(), paths: normalized });
        }
      }
    }
  }
  output.sort((a, b) => compareText(a.name, b.name) || compareText(a.kind ?? "", b.kind ?? ""));
  return output;
}

function graphPaths(keys: Iterable<string>, graph: NormalizedGraph): string[] {
  return [...keys]
    .map((key) => graph.displayPath.get(key) ?? key)
    .sort(compareText);
}

function queryTerms(query: string): { literal: string; tokens: string[] } {
  const literal = query.trim().toLowerCase();
  const tokens = stableUnique(literal.match(/[a-z0-9_./:-]+/g) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2);
  return { literal, tokens };
}

function firstLiteralIndex(haystackLower: string, terms: readonly string[]): number {
  let best = -1;
  for (const term of terms) {
    if (term === "") continue;
    const index = haystackLower.indexOf(term);
    if (index !== -1 && (best === -1 || index < best)) best = index;
  }
  return best;
}

function contextExcerpt(
  script: ProcessedScript,
  terms: { literal: string; tokens: string[] },
  maxChars: number,
): RankedContextScript["excerpt"] {
  const lower = script.processedSource.toLowerCase();
  const searchTerms = stableUnique([terms.literal, ...terms.tokens]).filter((term) => term !== "");
  let index = firstLiteralIndex(lower, searchTerms);
  if (index === -1) {
    index = script.processedSource.search(/\S/);
    if (index === -1) return undefined;
  }
  const starts = lineStarts(script.processedSource);
  const position = positionAt(starts, index);
  const lineStart = starts[position.line - 1];
  let end = lineStart;
  let lines = 0;
  while (end < script.processedSource.length && lines < 3 && end - lineStart < maxChars) {
    const newline = script.processedSource.indexOf("\n", end);
    if (newline === -1) {
      end = script.processedSource.length;
      break;
    }
    end = newline + 1;
    lines += 1;
  }
  const raw = script.processedSource.slice(lineStart, Math.min(end, lineStart + maxChars)).trim();
  const truncated = end - lineStart > maxChars || (!script.sourceComplete && end >= script.processedSource.length);
  return { line: position.line, text: raw, truncated };
}

function namedNeighborsForPath(
  path: string,
  inventory: readonly NormalizedInventory[],
  maxNeighbors: number,
): NamedNeighbor[] {
  const key = pathKey(path);
  const output: NamedNeighbor[] = [];
  for (const item of inventory) {
    if (!item.paths.some((candidate) => pathKey(candidate) === key)) continue;
    const peers = item.paths.filter((candidate) => pathKey(candidate) !== key);
    output.push({
      name: item.name,
      kind: item.kind,
      peers: peers.slice(0, maxNeighbors),
      peersTruncated: peers.length > maxNeighbors,
    });
    if (output.length >= maxNeighbors) break;
  }
  return output;
}

export function buildTaskContext(
  query: string,
  seedPaths: readonly string[],
  scripts: readonly AgentScript[],
  requireGraph?: RequireGraph,
  remoteInventory?: RelationshipInventory,
  datastoreInventory?: RelationshipInventory,
  options: ContextOptions = {},
): TaskContextResult {
  const processed = processScripts(scripts, options);
  const inputCompleteness = normalizeInputCompleteness(options.inputCompleteness, processed);
  const maxResults = boundedInt(options.maxResults, 16, 1, HARD_MAX_RESULTS);
  const maxReasons = boundedInt(options.maxReasons, 10, 1, 30);
  const maxExcerptChars = boundedInt(options.maxExcerptChars, 420, 40, HARD_MAX_EXCERPT_CHARS);
  const maxNeighbors = boundedInt(options.maxNeighborsPerType, 12, 1, 50);
  const maxAnchors = boundedInt(options.maxAnchors, 6, 1, 20);
  const maxSeedPaths = boundedInt(options.maxSeedPaths, 50, 1, 200);
  const maxQueryChars = boundedInt(options.maxQueryChars, 1_000, 1, 5_000);
  const known = new Map(processed.scripts.map((script) => [pathKey(script.path), script.path]));
  const knownResolver = createPathResolver(known.keys());
  const effectiveQuery = query.slice(0, maxQueryChars);
  const allResolvedSeeds = stableUnique(seedPaths.map((path) => resolvePath(path, knownResolver)));
  const resolvedSeeds = allResolvedSeeds.slice(0, maxSeedPaths);
  const seedKeys = new Set(resolvedSeeds.map(pathKey));
  const terms = queryTerms(effectiveQuery);
  const graph = normalizeRequireGraph(requireGraph, processed.scripts.map((script) => script.path));
  const knownPaths = processed.scripts.map((script) => script.path);
  const remotes = normalizeInventory(remoteInventory, knownPaths);
  const datastores = normalizeInventory(datastoreInventory, knownPaths);
  const scores = new Map<string, number>();
  const reasonSets = new Map<string, Set<string>>();

  const score = (path: string, points: number, reason: string): void => {
    const key = pathKey(path);
    scores.set(key, (scores.get(key) ?? 0) + points);
    const reasons = reasonSets.get(key) ?? new Set<string>();
    if (reasons.size < maxReasons) reasons.add(reason);
    reasonSets.set(key, reasons);
  };

  for (const script of processed.scripts) {
    const key = pathKey(script.path);
    const lowerPath = script.path.toLowerCase();
    const lowerName = (script.name ?? script.path.split(/[./\\]/).pop() ?? "").toLowerCase();
    const lowerSource = script.processedSource.toLowerCase();
    if (seedKeys.has(key)) score(script.path, 1_000, "explicit seed path");
    if (terms.literal !== "") {
      if (lowerPath.includes(terms.literal) || lowerName.includes(terms.literal)) {
        score(script.path, 180, `path/name contains literal query "${terms.literal}"`);
      }
      if (lowerSource.includes(terms.literal)) {
        score(script.path, 90, `source contains literal query "${terms.literal}"`);
      }
    }
    for (const token of terms.tokens) {
      if (lowerPath.includes(token) || lowerName.includes(token)) {
        score(script.path, 36, `path/name matches "${token}"`);
      }
      if (lowerSource.includes(token)) score(script.path, 14, `source matches "${token}"`);
    }
  }

  const baseAnchors = processed.scripts
    .filter((script) => (scores.get(pathKey(script.path)) ?? 0) > 0)
    .sort(
      (a, b) =>
        (scores.get(pathKey(b.path)) ?? 0) - (scores.get(pathKey(a.path)) ?? 0) ||
        compareText(a.path, b.path),
    )
    .map((script) => script.path);
  const anchors = stableUnique([...resolvedSeeds, ...baseAnchors]).slice(0, maxAnchors);

  for (const anchor of anchors) {
    const anchorKey = pathKey(anchor);
    for (const dependency of graph.dependencies.get(anchorKey) ?? []) {
      const path = graph.displayPath.get(dependency) ?? dependency;
      if (known.has(dependency)) score(path, 70, `direct dependency of ${anchor}`);
    }
    for (const dependent of graph.dependents.get(anchorKey) ?? []) {
      const path = graph.displayPath.get(dependent) ?? dependent;
      if (known.has(dependent)) score(path, 75, `direct dependent of ${anchor}`);
    }
    for (const [inventory, label, points] of [
      [remotes, "remote", 55],
      [datastores, "data", 50],
    ] as const) {
      for (const item of inventory) {
        if (!item.paths.some((candidate) => pathKey(candidate) === anchorKey)) continue;
        for (const peer of item.paths) {
          const peerKey = pathKey(peer);
          if (peerKey !== anchorKey && known.has(peerKey)) {
            score(known.get(peerKey) ?? peer, points, `shares ${label} ${item.name} with ${anchor}`);
          }
        }
      }
    }
  }

  const ranked = processed.scripts
    .filter((script) => (scores.get(pathKey(script.path)) ?? 0) > 0)
    .sort(
      (a, b) =>
        (scores.get(pathKey(b.path)) ?? 0) - (scores.get(pathKey(a.path)) ?? 0) ||
        compareText(a.path, b.path),
    );
  const selected = ranked.slice(0, maxResults);
  const results: RankedContextScript[] = selected.map((script) => {
    const key = pathKey(script.path);
    return {
      path: script.path,
      className: script.className,
      score: scores.get(key) ?? 0,
      reasons: [...(reasonSets.get(key) ?? [])].slice(0, maxReasons),
      excerpt: contextExcerpt(script, terms, maxExcerptChars),
      neighbors: {
        dependencies: graphPaths(graph.dependencies.get(key) ?? [], graph).slice(0, maxNeighbors),
        dependents: graphPaths(graph.dependents.get(key) ?? [], graph).slice(0, maxNeighbors),
        remotes: namedNeighborsForPath(script.path, remotes, maxNeighbors),
        datastores: namedNeighborsForPath(script.path, datastores, maxNeighbors),
      },
    };
  });

  return {
    summary: {
      query: effectiveQuery,
      seedPaths: resolvedSeeds,
      scriptsReceived: processed.received,
      scriptsScanned: processed.scripts.length,
      sourceCharsProcessed: processed.sourceCharsProcessed,
      sourceTruncatedScripts: processed.truncatedScripts,
      queryTruncated: query.length > effectiveQuery.length,
      seedPathsTruncated: allResolvedSeeds.length > resolvedSeeds.length,
      candidatesMatched: ranked.length,
      resultsReturned: results.length,
      resultsTruncated: ranked.length > results.length,
      inputCompleteness,
    },
    scripts: results,
  };
}

function walkGraph(
  start: string,
  adjacency: Map<string, Set<string>>,
  graph: NormalizedGraph,
  maxDepth: number,
  maxNodes: number,
): { direct: string[]; transitive: ImpactNode[]; truncated: boolean } {
  const directKeys = [...(adjacency.get(start) ?? [])].sort((a, b) =>
    compareText(graph.displayPath.get(a) ?? a, graph.displayPath.get(b) ?? b),
  );
  const direct = graphPaths(directKeys, graph);
  const visited = new Set<string>([start]);
  const queue = directKeys.slice(0, maxNodes).map((key) => ({ key, depth: 1 }));
  const transitive: ImpactNode[] = [];
  let truncated = directKeys.length > maxNodes;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.key)) continue;
    visited.add(current.key);
    if (current.depth > 1) {
      if (transitive.length >= maxNodes) {
        truncated = true;
        continue;
      }
      transitive.push({
        path: graph.displayPath.get(current.key) ?? current.key,
        depth: current.depth,
      });
    }
    if (current.depth >= maxDepth) {
      if ((adjacency.get(current.key)?.size ?? 0) > 0) truncated = true;
      continue;
    }
    const next = [...(adjacency.get(current.key) ?? [])].sort((a, b) =>
      compareText(graph.displayPath.get(a) ?? a, graph.displayPath.get(b) ?? b),
    );
    for (const key of next) if (!visited.has(key)) queue.push({ key, depth: current.depth + 1 });
  }
  transitive.sort((a, b) => a.depth - b.depth || compareText(a.path, b.path));
  return {
    direct: direct.slice(0, maxNodes),
    transitive,
    truncated,
  };
}

function hasGraphCycle(start: string, graph: NormalizedGraph, maxNodes: number): boolean {
  const visited = new Set<string>();
  const active = new Set<string>();
  let visits = 0;
  const visit = (node: string): boolean => {
    if (active.has(node)) return true;
    if (visited.has(node) || visits >= maxNodes) return false;
    visits += 1;
    visited.add(node);
    active.add(node);
    for (const next of graph.dependencies.get(node) ?? []) {
      if (visit(next)) return true;
    }
    active.delete(node);
    return false;
  };
  return visit(start);
}

function inventoryRelationships(
  target: string,
  inventory: readonly NormalizedInventory[],
  maxRelationships: number,
  maxPeers: number,
): { values: ImpactRelationship[]; detected: number; totalPeers: number; truncated: boolean } {
  const targetKey = pathKey(target);
  const all: ImpactRelationship[] = [];
  let totalPeers = 0;
  for (const item of inventory) {
    if (!item.paths.some((path) => pathKey(path) === targetKey)) continue;
    const peers = item.paths.filter((path) => pathKey(path) !== targetKey);
    totalPeers += peers.length;
    all.push({
      name: item.name,
      kind: item.kind,
      peers: peers.slice(0, maxPeers),
      peersTruncated: peers.length > maxPeers,
    });
  }
  return {
    values: all.slice(0, maxRelationships),
    detected: all.length,
    totalPeers,
    truncated: all.length > maxRelationships || all.some((item) => item.peersTruncated),
  };
}

function lastPathName(path: string): string {
  const components = path.split(/[./\\]/).filter((part) => part !== "");
  return components.at(-1) ?? path;
}

function literalWordIndex(haystackLower: string, needleLower: string): number {
  if (needleLower === "") return -1;
  let from = 0;
  while (from < haystackLower.length) {
    const index = haystackLower.indexOf(needleLower, from);
    if (index === -1) return -1;
    const before = index === 0 ? "" : haystackLower[index - 1];
    const afterIndex = index + needleLower.length;
    const after = afterIndex >= haystackLower.length ? "" : haystackLower[afterIndex];
    const isWord = (char: string): boolean => /[a-z0-9_]/.test(char);
    if (!isWord(before) && !isWord(after)) return index;
    from = index + Math.max(1, needleLower.length);
  }
  return -1;
}

export function buildChangeImpact(
  path: string,
  scripts: readonly AgentScript[],
  requireGraph?: RequireGraph,
  remoteInventory?: RelationshipInventory,
  datastoreInventory?: RelationshipInventory,
  options: ImpactOptions = {},
): ChangeImpactResult {
  const processed = processScripts(scripts, options);
  const inputCompleteness = normalizeInputCompleteness(options.inputCompleteness, processed);
  const maxDepth = boundedInt(options.maxDepth, 8, 1, 30);
  const maxGraphNodes = boundedInt(options.maxGraphNodes, 120, 1, HARD_MAX_GRAPH_NODES);
  const maxPeers = boundedInt(options.maxPeersPerRelationship, 20, 1, 100);
  const maxRelationships = boundedInt(options.maxRelationships, 30, 1, HARD_MAX_RELATIONSHIPS);
  const maxLiteralReferences = boundedInt(options.maxLiteralReferences, 50, 1, 200);
  const maxExcerptChars = boundedInt(options.maxExcerptChars, 200, 40, HARD_MAX_EXCERPT_CHARS);
  const known = new Map(processed.scripts.map((script) => [pathKey(script.path), script.path]));
  const knownResolver = createPathResolver(known.keys());
  const requestedPath = path.trim();
  const resolvedPath = resolvePath(requestedPath, knownResolver);
  const targetKey = pathKey(resolvedPath);
  const foundInScripts = known.has(targetKey);
  const graph = normalizeRequireGraph(requireGraph, processed.scripts.map((script) => script.path));
  if (!graph.displayPath.has(targetKey) && resolvedPath !== "") graph.displayPath.set(targetKey, resolvedPath);
  const dependencies = walkGraph(targetKey, graph.dependencies, graph, maxDepth, maxGraphNodes);
  const dependents = walkGraph(targetKey, graph.dependents, graph, maxDepth, maxGraphNodes);
  const cycle = hasGraphCycle(targetKey, graph, maxGraphNodes);
  const remoteRelationships = inventoryRelationships(
    resolvedPath,
    normalizeInventory(remoteInventory, processed.scripts.map((script) => script.path)),
    maxRelationships,
    maxPeers,
  );
  const datastoreRelationships = inventoryRelationships(
    resolvedPath,
    normalizeInventory(datastoreInventory, processed.scripts.map((script) => script.path)),
    maxRelationships,
    maxPeers,
  );

  const targetName = lastPathName(resolvedPath).toLowerCase();
  const fullNeedle = resolvedPath.toLowerCase();
  const literalReferences: LiteralReference[] = [];
  let literalReferencesDetected = 0;
  let exactLiteralReferencesDetected = 0;
  let heuristicLiteralReferencesDetected = 0;
  for (const script of processed.scripts) {
    if (pathKey(script.path) === targetKey) continue;
    const lower = script.processedSource.toLowerCase();
    let index = fullNeedle === "" ? -1 : lower.indexOf(fullNeedle);
    let confidence: AnalysisConfidence = "exact";
    let matched: LiteralReference["matched"] = "full_path";
    if (index === -1 && targetName.length >= 2) {
      index = literalWordIndex(lower, targetName);
      confidence = "heuristic";
      matched = "name";
    }
    if (index === -1) continue;
    literalReferencesDetected += 1;
    if (confidence === "exact") exactLiteralReferencesDetected += 1;
    else heuristicLiteralReferencesDetected += 1;
    if (literalReferences.length >= maxLiteralReferences) continue;
    const starts = lineStarts(script.processedSource);
    literalReferences.push({
      path: script.path,
      confidence,
      matched,
      line: positionAt(starts, index).line,
      excerpt: excerptAt(script.processedSource, index, maxExcerptChars),
    });
  }
  literalReferences.sort(
    (a, b) =>
      compareText(a.confidence, b.confidence) ||
      compareText(a.path, b.path) ||
      a.line - b.line,
  );

  const remotePeerCount = remoteRelationships.totalPeers;
  const datastorePeerCount = datastoreRelationships.totalPeers;
  const directDependentCount = graph.dependents.get(targetKey)?.size ?? 0;
  let riskScore = foundInScripts ? 5 : 15;
  riskScore += Math.min(32, directDependentCount * 8);
  riskScore += Math.min(18, dependents.transitive.length * 3);
  riskScore += Math.min(12, remotePeerCount * 4);
  riskScore += Math.min(16, datastorePeerCount * 6);
  riskScore += Math.min(12, exactLiteralReferencesDetected * 4);
  riskScore += Math.min(6, heuristicLiteralReferencesDetected * 2);
  if (cycle) riskScore += 10;
  if (inputCompleteness && inputCompleteness.overall !== "complete") {
    riskScore = Math.max(25, riskScore);
  }
  riskScore = Math.min(100, riskScore);
  const level: ChangeImpactResult["risk"]["level"] =
    riskScore >= 80 ? "critical" : riskScore >= 55 ? "high" : riskScore >= 25 ? "medium" : "low";
  const factors: string[] = [];
  if (!foundInScripts) factors.push("target path is absent from the supplied script snapshot");
  if (directDependentCount > 0) factors.push(`${directDependentCount} direct require dependents`);
  if (dependents.transitive.length > 0) {
    factors.push(`${dependents.transitive.length} transitive require dependents`);
  }
  if (remotePeerCount > 0) factors.push(`${remotePeerCount} remote-contract peers`);
  if (datastorePeerCount > 0) factors.push(`${datastorePeerCount} datastore-contract peers`);
  if (literalReferencesDetected > 0) factors.push(`${literalReferencesDetected} literal/name references`);
  if (cycle) factors.push("require cycle reaches the target");
  if (inputCompleteness?.overall === "partial") {
    factors.push("input evidence is partial; missing fan-out may increase risk");
  } else if (inputCompleteness?.overall === "unknown") {
    factors.push("one or more relationship scans are unavailable; fan-out risk is unknown");
  }
  if (factors.length === 0) factors.push("no supplied dependency or contract fan-out");

  const recommendations: string[] = [];
  if (!foundInScripts) recommendations.push("Refresh the script snapshot and verify the exact target path before editing.");
  if (dependents.direct.length > 0) {
    recommendations.push("Compile and exercise every direct dependent after changing the target contract.");
  }
  if (dependents.transitive.length > 0) {
    recommendations.push("Run regression coverage across transitive dependents, not only immediate callers.");
  }
  if (remotePeerCount > 0) {
    recommendations.push("Validate server and client remote contracts together in a runtime or multi-client test.");
  }
  if (datastorePeerCount > 0) {
    recommendations.push("Preserve stored schema compatibility or ship an explicit migration and rollback path.");
  }
  if (literalReferencesDetected > 0) {
    recommendations.push("Update and verify literal path/name references if the target is moved or renamed.");
  }
  if (cycle) recommendations.push("Break or isolate the require cycle before widening the change.");
  if (inputCompleteness && inputCompleteness.overall !== "complete") {
    recommendations.push("Refresh truncated or unavailable scans before treating this impact report as complete.");
  }
  if (level === "high" || level === "critical") {
    recommendations.push("Create a recoverable checkpoint before mutation and compare post-change health.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Compile the target and run its focused behavior test after the change.");
  }

  return {
    target: {
      requestedPath,
      resolvedPath: resolvedPath === "" ? null : resolvedPath,
      foundInScripts,
    },
    dependencies,
    dependents,
    remotePeers: remoteRelationships.values,
    datastorePeers: datastoreRelationships.values,
    literalReferences,
    risk: { score: riskScore, level, factors },
    recommendations,
    summary: {
      scriptsReceived: processed.received,
      scriptsScanned: processed.scripts.length,
      sourceCharsProcessed: processed.sourceCharsProcessed,
      sourceTruncatedScripts: processed.truncatedScripts,
      graphCycleDetected: cycle,
      literalReferencesDetected,
      literalReferencesTruncated: literalReferencesDetected > literalReferences.length,
      relationshipsTruncated: remoteRelationships.truncated || datastoreRelationships.truncated,
      inputCompleteness,
    },
  };
}
