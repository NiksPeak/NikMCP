// Task 24 Part A: Roblox API-dump reflection -- acquisition, cache, index, validators.
// Dependency-free (built-in fetch/fs/path/os only), same rule as open-cloud.ts.
// All logs go to stderr (stdout is MCP JSON-RPC). Fail-open: if the dump cannot be
// loaded, every validator passes through and we warn ONCE per process lifetime.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- dump JSON shapes (only the fields we read) ----------------------

interface DumpValueType {
  Category: string; // "Primitive" | "Class" | "Enum" | "DataType" | "Group"
  Name: string;
}

interface DumpMember {
  MemberType: string; // "Property" | "Function" | "Event" | "Callback"
  Name: string;
  ValueType?: DumpValueType;
  // Properties carry { Read, Write }; Functions/Events/Callbacks carry a string.
  Security?: string | { Read?: string; Write?: string };
  Tags?: string[];
}

interface DumpClass {
  Name: string;
  Superclass: string; // "<<<ROOT>>>" at the top
  Tags?: string[];
  Members: DumpMember[];
}

interface DumpEnum {
  Name: string;
  Items: { Name: string }[];
}

export interface ApiDumpJson {
  Classes: DumpClass[];
  Enums: DumpEnum[];
  Version?: number;
}

// ---------- security semantics ----------------------------------------------
// NikMCP runs as a Studio PLUGIN: None + PluginSecurity are accessible;
// RobloxScriptSecurity / LocalUserSecurity / NotAccessibleSecurity are not.
const BLOCKED_SECURITY = new Set([
  "RobloxScriptSecurity",
  "LocalUserSecurity",
  "NotAccessibleSecurity",
]);

function readSecurity(m: DumpMember): { read: string; write: string } {
  const s = m.Security;
  if (typeof s === "string") return { read: s, write: s };
  return { read: s?.Read ?? "None", write: s?.Write ?? "None" };
}

// ---------- didYouMean (dependency-free edit distance, cap 2) ----------------

// Optimal-string-alignment distance: like Levenshtein but an adjacent
// transposition ('Prat' -> 'Part') costs 1, which is the most common typo shape.
function editDistanceCapped(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const la = a.length;
  const lb = b.length;
  let prev2 = new Array<number>(lb + 1);
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1; // whole row above cap -> can only grow
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb];
}

export function didYouMean(name: string, candidates: Iterable<string>): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestDist = 3; // cap 2 -> anything >= 3 is "no match"
  for (const c of candidates) {
    // cheap case-insensitive exact hit wins immediately
    if (c.toLowerCase() === lower) return c;
    const d = editDistanceCapped(name, c, 2);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

// ---------- index -------------------------------------------------------------

export interface MemberEntry {
  name: string;
  memberType: string;
  valueType?: DumpValueType;
  declaredIn: string;
  readBlocked: boolean;
  writeBlocked: boolean;
  readOnly: boolean;
  notScriptable: boolean;
  tags: string[];
  security: { read: string; write: string };
}

interface PropCandidate {
  className: string;
  valueType?: DumpValueType;
  writable: boolean;
  blockReason?: string;
}

export class ApiDumpIndex {
  private classes = new Map<string, DumpClass>();
  private enums = new Map<string, Set<string>>();
  // global propertyName -> candidates across every class (set_property only has a
  // path Node-side, never the class -- see validatePropertyWrite)
  private propIndex = new Map<string, PropCandidate[]>();
  private resolvedCache = new Map<string, Map<string, MemberEntry>>();

  constructor(dump: ApiDumpJson) {
    for (const cls of dump.Classes) {
      this.classes.set(cls.Name, cls);
      for (const m of cls.Members) {
        if (m.MemberType !== "Property") continue;
        const sec = readSecurity(m);
        const tags = m.Tags ?? [];
        const readOnly = tags.includes("ReadOnly");
        const notScriptable = tags.includes("NotScriptable");
        const writeBlocked = BLOCKED_SECURITY.has(sec.write);
        let blockReason: string | undefined;
        if (readOnly) blockReason = "read-only";
        else if (notScriptable) blockReason = "NotScriptable";
        else if (writeBlocked) blockReason = `write security ${sec.write}`;
        let arr = this.propIndex.get(m.Name);
        if (!arr) {
          arr = [];
          this.propIndex.set(m.Name, arr);
        }
        arr.push({
          className: cls.Name,
          valueType: m.ValueType,
          writable: !blockReason,
          blockReason,
        });
      }
    }
    for (const e of dump.Enums) {
      this.enums.set(e.Name, new Set(e.Items.map((i) => i.Name)));
    }
  }

  hasClass(name: string): boolean {
    return this.classes.has(name);
  }

  classNames(): Iterable<string> {
    return this.classes.keys();
  }

  classTags(name: string): string[] {
    return this.classes.get(name)?.Tags ?? [];
  }

  superclassOf(name: string): string | undefined {
    return this.classes.get(name)?.Superclass;
  }

  propertyNames(): Iterable<string> {
    return this.propIndex.keys();
  }

  propertyCandidates(name: string): PropCandidate[] {
    return this.propIndex.get(name) ?? [];
  }

  enumItems(name: string): Set<string> | undefined {
    return this.enums.get(name);
  }

  // Full member table for a class including the superclass chain (child
  // declarations shadow ancestors). Lazy + cached per class.
  resolveMembers(className: string): Map<string, MemberEntry> | null {
    const cached = this.resolvedCache.get(className);
    if (cached) return cached;
    if (!this.classes.has(className)) return null;
    const out = new Map<string, MemberEntry>();
    let cur: string | undefined = className;
    let guard = 0;
    while (cur && cur !== "<<<ROOT>>>" && guard++ < 64) {
      const cls = this.classes.get(cur);
      if (!cls) break;
      for (const m of cls.Members) {
        if (out.has(m.Name)) continue; // child shadows ancestor
        const sec = readSecurity(m);
        const tags = m.Tags ?? [];
        out.set(m.Name, {
          name: m.Name,
          memberType: m.MemberType,
          valueType: m.ValueType,
          declaredIn: cls.Name,
          readBlocked: BLOCKED_SECURITY.has(sec.read),
          writeBlocked: BLOCKED_SECURITY.has(sec.write),
          readOnly: tags.includes("ReadOnly"),
          notScriptable: tags.includes("NotScriptable"),
          tags,
          security: sec,
        });
      }
      cur = cls.Superclass;
    }
    this.resolvedCache.set(className, out);
    return out;
  }
}

// ---------- validators --------------------------------------------------------
// Every validator takes `idx | null` and passes through (returns null) on null,
// so callers never branch on dump availability themselves.

export function validateCreate(idx: ApiDumpIndex | null, className: string): string | null {
  if (!idx) return null;
  if (!idx.hasClass(className)) {
    const s = didYouMean(className, idx.classNames());
    return s
      ? `unknown class '${className}'. Did you mean '${s}'?`
      : `unknown class '${className}'`;
  }
  const tags = idx.classTags(className);
  if (tags.includes("NotCreatable") || tags.includes("Service")) {
    const why = tags.includes("Service") ? "it is a Service" : "it is tagged NotCreatable";
    return `class '${className}' cannot be created with Instance.new (${why})`;
  }
  return null;
}

// JSON-type expectation for dump primitive names. Conservative on purpose: the
// Executor coerces some shapes (numeric strings etc.), so only CLEAR
// contradictions reject; anything plausible passes through.
function primitiveMismatch(primName: string, value: unknown): string | null {
  const t = typeof value;
  if (value === null || value === undefined) return null;
  switch (primName) {
    case "bool":
      if (t === "boolean") return null;
      if (t === "string" && (value === "true" || value === "false")) return null;
      return "boolean";
    case "int":
    case "int64":
    case "float":
    case "double":
      if (t === "number") return null;
      if (t === "string" && value !== "" && !Number.isNaN(Number(value))) return null;
      return "number";
    case "string":
      // numbers/bools coerce fine via tostring; only objects/arrays are wrong
      if (t === "object") return "string";
      return null;
    default:
      return null; // unknown primitive name -> not our call
  }
}

export function validatePropertyWrite(
  idx: ApiDumpIndex | null,
  property: string,
  value: unknown,
  className?: string
): string | null {
  if (!idx) return null;

  // Class known (create_instance properties): resolve against the real chain.
  if (className && idx.hasClass(className)) {
    const members = idx.resolveMembers(className);
    if (!members) return null;
    const m = members.get(property);
    if (!m || m.memberType !== "Property") {
      const propNames = [...members.values()]
        .filter((e) => e.memberType === "Property")
        .map((e) => e.name);
      const s = didYouMean(property, propNames);
      return s
        ? `class '${className}' has no property '${property}'. Did you mean '${s}'?`
        : `class '${className}' has no property '${property}'`;
    }
    if (m.readOnly) return `property '${className}.${property}' is read-only`;
    if (m.notScriptable) return `property '${className}.${property}' is NotScriptable`;
    if (m.writeBlocked) {
      return `property '${className}.${property}' is not writable from a plugin (${m.security.write})`;
    }
    return checkValueAgainst([{ className, valueType: m.valueType, writable: true }], property, value, idx);
  }

  // Class unknown (set_property has only a path): the global property index is
  // the best we can honestly do. The Executor stays the final authority.
  const candidates = idx.propertyCandidates(property);
  if (candidates.length === 0) {
    const s = didYouMean(property, idx.propertyNames());
    return s
      ? `unknown property '${property}'. Did you mean '${s}'?`
      : `unknown property '${property}' (no class in the API dump has it)`;
  }
  const writable = candidates.filter((c) => c.writable);
  if (writable.length === 0) {
    return `property '${property}' is not writable on any class (${candidates[0].blockReason ?? "blocked"})`;
  }
  return checkValueAgainst(writable, property, value, idx);
}

// Type + enum agreement check across the candidate set. Only fires when EVERY
// writable candidate agrees; disagreement or complex types pass through.
function checkValueAgainst(
  writable: { className: string; valueType?: DumpValueType; writable: boolean }[],
  property: string,
  value: unknown,
  idx: ApiDumpIndex
): string | null {
  const first = writable[0].valueType;
  if (!first) return null;
  const allAgree = writable.every(
    (c) => c.valueType && c.valueType.Category === first.Category && c.valueType.Name === first.Name
  );
  if (!allAgree) return null;

  if (first.Category === "Primitive") {
    const expected = primitiveMismatch(first.Name, value);
    if (expected) {
      return `property '${property}' expects a ${expected} (${first.Name}), got ${typeof value}`;
    }
    return null;
  }

  if (first.Category === "Enum" && typeof value === "string") {
    const items = idx.enumItems(first.Name);
    if (!items) return null;
    // accept "Neon", "Enum.Material.Neon", "Material.Neon"
    let item = value;
    const full = `Enum.${first.Name}.`;
    const short = `${first.Name}.`;
    if (item.startsWith(full)) item = item.slice(full.length);
    else if (item.startsWith(short)) item = item.slice(short.length);
    if (!items.has(item)) {
      const s = didYouMean(item, items);
      return s
        ? `'${item}' is not a valid Enum.${first.Name} value. Did you mean '${s}'?`
        : `'${item}' is not a valid Enum.${first.Name} value`;
    }
  }
  return null;
}

// ---------- get_class_info (Node-side reflection, paginated) -------------------

const CLASS_INFO_PAGE = 50;

export interface ClassInfoMember {
  name: string;
  memberType: string;
  valueType?: string;
  security: string;
  tags?: string[];
  declaredIn: string;
}

export function classInfo(
  idx: ApiDumpIndex,
  opts: {
    className: string;
    memberType?: string;
    includeInherited: boolean;
    cursor?: string;
  }
):
  | { error: string }
  | {
      className: string;
      superclass?: string;
      tags: string[];
      creatable: boolean;
      totalMembers: number;
      members: ClassInfoMember[];
      nextCursor?: string;
    } {
  if (!idx.hasClass(opts.className)) {
    const s = didYouMean(opts.className, idx.classNames());
    return {
      error: s
        ? `unknown class '${opts.className}'. Did you mean '${s}'?`
        : `unknown class '${opts.className}'`,
    };
  }
  const resolved = idx.resolveMembers(opts.className);
  if (!resolved) return { error: `unknown class '${opts.className}'` };

  let members = [...resolved.values()];
  if (!opts.includeInherited) {
    members = members.filter((m) => m.declaredIn === opts.className);
  }
  if (opts.memberType) {
    members = members.filter((m) => m.memberType === opts.memberType);
  }
  members.sort((a, b) => a.name.localeCompare(b.name));

  const offset = opts.cursor ? Math.max(0, parseInt(opts.cursor, 10) || 0) : 0;
  const page = members.slice(offset, offset + CLASS_INFO_PAGE);
  const tags = idx.classTags(opts.className);
  const out = {
    className: opts.className,
    superclass: idx.superclassOf(opts.className),
    tags,
    creatable: !tags.includes("NotCreatable") && !tags.includes("Service"),
    totalMembers: members.length,
    members: page.map((m) => {
      const vt = m.valueType
        ? m.valueType.Category === "Enum"
          ? `Enum.${m.valueType.Name}`
          : m.valueType.Name
        : undefined;
      const sec =
        m.security.read === m.security.write
          ? m.security.read
          : `read:${m.security.read} write:${m.security.write}`;
      const e: ClassInfoMember = {
        name: m.name,
        memberType: m.memberType,
        valueType: vt,
        security: sec,
        declaredIn: m.declaredIn,
      };
      if (m.tags.length) e.tags = m.tags;
      return e;
    }),
  };
  if (offset + CLASS_INFO_PAGE < members.length) {
    return { ...out, nextCursor: String(offset + CLASS_INFO_PAGE) };
  }
  return out;
}

// ---------- acquisition + cache + singleton ------------------------------------

export function nikmcpCacheDir(): string {
  return join(homedir(), ".nikmcp");
}

const DUMP_FILE = "api-dump.json";
const META_FILE = "api-dump.meta.json";

interface DumpMeta {
  clientVersionUpload: string;
  fetchedAt: number;
}

let indexInstance: ApiDumpIndex | null = null;
let loadPromise: Promise<void> | null = null;
let warnedUnavailable = false;

function warnOnce(msg: string): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.error(`[api-dump] ${msg} -- API validation passes through`);
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function atomicWrite(dir: string, name: string, data: string): void {
  const tmp = join(dir, `${name}.tmp-${process.pid}`);
  writeFileSync(tmp, data);
  renameSync(tmp, join(dir, name));
}

function tryLoadCache(dir: string): { meta: DumpMeta | null; loaded: boolean } {
  let meta: DumpMeta | null = null;
  try {
    meta = JSON.parse(readFileSync(join(dir, META_FILE), "utf8")) as DumpMeta;
  } catch {
    meta = null;
  }
  try {
    const dump = JSON.parse(readFileSync(join(dir, DUMP_FILE), "utf8")) as ApiDumpJson;
    if (Array.isArray(dump.Classes) && Array.isArray(dump.Enums)) {
      indexInstance = new ApiDumpIndex(dump);
      return { meta, loaded: true };
    }
  } catch {
    // no/corrupt cache -- fetch below
  }
  return { meta, loaded: false };
}

async function fetchAndIndex(dir: string, version: string | null): Promise<void> {
  const urls: string[] = [];
  if (version) {
    urls.push(`https://setup.rbxcdn.com/${version}-Full-API-Dump.json`);
    urls.push(`https://setup.roblox.com/${version}-Full-API-Dump.json`);
  }
  urls.push(
    "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Full-API-Dump.json"
  );
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      const text = await fetchText(url, 120000);
      const dump = JSON.parse(text) as ApiDumpJson;
      if (!Array.isArray(dump.Classes) || !Array.isArray(dump.Enums)) {
        throw new Error("dump JSON missing Classes/Enums");
      }
      indexInstance = new ApiDumpIndex(dump);
      atomicWrite(dir, DUMP_FILE, text);
      atomicWrite(
        dir,
        META_FILE,
        JSON.stringify({ clientVersionUpload: version ?? "mirror", fetchedAt: Date.now() })
      );
      console.error(
        `[api-dump] loaded ${dump.Classes.length} classes / ${dump.Enums.length} enums (${url})`
      );
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function loadDump(ttlHours: number): Promise<void> {
  const dir = nikmcpCacheDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // unwritable home dir -> in-memory only; a fetch below can still succeed
  }

  const { meta, loaded } = tryLoadCache(dir);

  // Version check at most once per server start; any failure keeps the cache.
  let liveVersion: string | null = null;
  try {
    const text = await fetchText(
      "https://clientsettings.roblox.com/v2/client-version/WindowsStudio64",
      10000
    );
    const v = (JSON.parse(text) as { clientVersionUpload?: string }).clientVersionUpload;
    if (typeof v === "string" && v) liveVersion = v;
  } catch {
    liveVersion = null;
  }

  if (loaded && meta) {
    const fresh = Date.now() - meta.fetchedAt < ttlHours * 3600 * 1000;
    const sameVersion = liveVersion === null || meta.clientVersionUpload === liveVersion;
    if (fresh && sameVersion) return; // cache is current
  }

  try {
    await fetchAndIndex(dir, liveVersion);
  } catch (e) {
    if (indexInstance) {
      console.error(`[api-dump] refresh failed, keeping cached dump: ${String(e)}`);
    } else {
      warnOnce(`dump unavailable (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

// Fire-and-forget background load. Idempotent; never throws; never blocks MCP init.
export function startApiDumpLoad(opts: { ttlHours: number }): void {
  if (loadPromise) return;
  loadPromise = loadDump(opts.ttlHours).catch((e) => {
    warnOnce(`load error (${e instanceof Error ? e.message : String(e)})`);
  });
}

// First validated call awaits readiness for at most maxWaitMs, then passes
// through (returns whatever is loaded so far -- possibly null) while the load
// continues in the background.
export async function apiDumpReady(maxWaitMs: number): Promise<ApiDumpIndex | null> {
  if (indexInstance || !loadPromise) return indexInstance;
  await Promise.race([loadPromise, new Promise((r) => setTimeout(r, maxWaitMs))]);
  return indexInstance;
}

export function getApiDumpIndex(): ApiDumpIndex | null {
  return indexInstance;
}
