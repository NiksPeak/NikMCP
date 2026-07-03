// Task 26: surgical rewriter for a Roblox "MonetizationIds" ModuleScript.
// Ported VERBATIM (behavior) from RoCreate lib/monetizationModuleRewrite.ts -- it
// rewrites a live-money file, so the guarantees are load-bearing:
//   - 0 is NEVER touched (0 = dormant product; activating it auto-publishes).
//   - value literals matched as WHOLE integers in `= <digits>` position only.
//   - digits inside key strings (["Seed:Tulip:10"]) and comments (-- 75) never match.
//   - everything else preserved byte-for-byte (no parse-to-table / re-serialize).

export type MonetizationIdMap = Map<string, string>;

export type ModuleChange = { key: string; oldId: string; newId: string; line: number };

export type ModuleRewriteCounts = {
  replaced: number;
  leftAsZero: number;
  inModuleNotInMap: number;
  inMapNotInModule: number;
};

export type ModuleDuplicate = { oldId: string; newId: string; lines: number[] };

export type ModuleRewritePreview = {
  changes: ModuleChange[];
  counts: ModuleRewriteCounts;
  duplicates: ModuleDuplicate[];
  inMapNotInModule: string[];
};

export type ModuleVerifyResult = {
  ok: boolean;
  offending: { oldId: string; line: number }[];
};

type ValueHit = {
  line: number;
  start: number;
  end: number;
  digits: string;
  key: string;
};

const VALUE_ASSIGN = /(?<![=<>~!])=[ \t\f\v]*(\d+)/g;

// Blank out (preserving length) every char inside a Lua string literal or a
// line/long comment, so the value scanner only sees genuine code.
function maskLine(line: string): string {
  const out = line.split("");
  let i = 0;
  let inString: '"' | "'" | null = null;

  while (i < line.length) {
    const ch = line[i];

    if (inString) {
      if (ch === "\\") {
        out[i] = " ";
        if (i + 1 < line.length) out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (ch === inString) {
        inString = null;
      } else {
        out[i] = " ";
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch;
      out[i] = " ";
      i += 1;
      continue;
    }

    if (ch === "-" && line[i + 1] === "-") {
      for (let j = i; j < line.length; j++) out[j] = " ";
      break;
    }

    i += 1;
  }

  return out.join("");
}

function extractKey(beforeEquals: string): string {
  const trimmed = beforeEquals.replace(/[ \t]+$/, "");
  const bracketString = trimmed.match(/\[\s*(["'])([\s\S]*?)\1\s*\]$/);
  if (bracketString) return bracketString[2];
  const bracketAny = trimmed.match(/\[\s*([^\]]+?)\s*\]$/);
  if (bracketAny) return bracketAny[1];
  const ident = trimmed.match(/([A-Za-z_][\w.]*)$/);
  if (ident) return ident[1];
  return trimmed.trim();
}

function scanValueHits(moduleText: string): ValueHit[] {
  const hits: ValueHit[] = [];
  const lines = moduleText.split("\n");

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    const scan = maskLine(line);
    VALUE_ASSIGN.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = VALUE_ASSIGN.exec(scan)) !== null) {
      const digits = m[1];
      const start = m.index + m[0].length - digits.length;
      const end = start + digits.length;
      const after = line[end];

      // Reject floats/hex/exponent/bigint/identifier continuations.
      if (after !== undefined && /[\w.]/.test(after)) continue;

      hits.push({
        line: l + 1,
        start,
        end,
        digits,
        key: extractKey(line.slice(0, m.index)),
      });
    }
  }

  return hits;
}

function isZero(digits: string): boolean {
  return /^0+$/.test(digits);
}

export function previewRewrite(
  moduleText: string,
  idMap: MonetizationIdMap
): ModuleRewritePreview {
  const hits = scanValueHits(moduleText);
  const changes: ModuleChange[] = [];
  const linesByOldId = new Map<string, number[]>();
  const oldIdsSeenInModule = new Set<string>();
  let replaced = 0;
  let leftAsZero = 0;
  let inModuleNotInMap = 0;

  for (const hit of hits) {
    if (isZero(hit.digits)) {
      leftAsZero += 1;
      continue;
    }
    oldIdsSeenInModule.add(hit.digits);
    const newId = idMap.get(hit.digits);
    if (newId === undefined) {
      inModuleNotInMap += 1;
      continue;
    }
    replaced += 1;
    changes.push({ key: hit.key, oldId: hit.digits, newId, line: hit.line });
    const lines = linesByOldId.get(hit.digits) ?? [];
    lines.push(hit.line);
    linesByOldId.set(hit.digits, lines);
  }

  const duplicates: ModuleDuplicate[] = [];
  for (const [oldId, lines] of linesByOldId) {
    if (lines.length > 1) {
      duplicates.push({ oldId, newId: idMap.get(oldId) as string, lines });
    }
  }

  const inMapNotInModule: string[] = [];
  for (const oldId of idMap.keys()) {
    if (!oldIdsSeenInModule.has(oldId)) inMapNotInModule.push(oldId);
  }

  return {
    changes,
    counts: {
      replaced,
      leftAsZero,
      inModuleNotInMap,
      inMapNotInModule: inMapNotInModule.length,
    },
    duplicates,
    inMapNotInModule,
  };
}

export function applyRewrite(
  moduleText: string,
  idMap: MonetizationIdMap
): { text: string; preview: ModuleRewritePreview } {
  const preview = previewRewrite(moduleText, idMap);
  const hits = scanValueHits(moduleText);
  const lines = moduleText.split("\n");

  const hitsByLine = new Map<number, ValueHit[]>();
  for (const hit of hits) {
    if (isZero(hit.digits)) continue;
    if (!idMap.has(hit.digits)) continue;
    const arr = hitsByLine.get(hit.line) ?? [];
    arr.push(hit);
    hitsByLine.set(hit.line, arr);
  }

  for (const [lineNo, lineHits] of hitsByLine) {
    let line = lines[lineNo - 1];
    lineHits.sort((a, b) => b.start - a.start); // right-to-left keeps earlier indices valid
    for (const hit of lineHits) {
      const newId = idMap.get(hit.digits) as string;
      line = line.slice(0, hit.start) + newId + line.slice(hit.end);
    }
    lines[lineNo - 1] = line;
  }

  return { text: lines.join("\n"), preview };
}

export function verifyRewrite(
  rewrittenText: string,
  idMap: MonetizationIdMap
): ModuleVerifyResult {
  const newIds = new Set(idMap.values());
  const offending: { oldId: string; line: number }[] = [];

  for (const hit of scanValueHits(rewrittenText)) {
    if (isZero(hit.digits)) continue;
    if (idMap.has(hit.digits) && !newIds.has(hit.digits)) {
      offending.push({ oldId: hit.digits, line: hit.line });
    }
  }

  return { ok: offending.length === 0, offending };
}
