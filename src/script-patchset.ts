import { randomUUID } from "node:crypto";
import { fnv1a32, normalizeSource, unifiedDiff } from "./sync.js";

export type ScriptPatchOperation =
  | {
      kind: "replace";
      oldText: string;
      newText: string;
      expectedMatches?: number;
    }
  | {
      kind: "replace_lines";
      startLine: number;
      endLine: number;
      newText: string;
    }
  | {
      kind: "full_source";
      source: string;
    };

export interface ScriptPatchRequest {
  path: string;
  operations: ScriptPatchOperation[];
}

export interface ScriptPatchPlanItem {
  path: string;
  beforeHash: string;
  afterHash: string;
  source: string;
  changed: boolean;
  diff: string;
}

export interface ScriptPatchPlan {
  token: string;
  targetId: string;
  createdAt: string;
  expiresAt: string;
  items: ScriptPatchPlanItem[];
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

function replaceAllLiteral(source: string, oldText: string, newText: string): string {
  if (oldText.length === 0) throw new Error("replace.oldText must not be empty");
  return source.split(oldText).join(newText);
}

export function applyScriptPatchOperations(
  path: string,
  currentSource: string,
  operations: ScriptPatchOperation[],
): string {
  if (!path.trim()) throw new Error("patch path must not be empty");
  if (operations.length < 1 || operations.length > 100) {
    throw new Error(`${path}: operations must contain 1-100 entries`);
  }

  let source = normalizeSource(currentSource);
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.kind === "replace") {
      const oldText = normalizeSource(operation.oldText);
      const newText = normalizeSource(operation.newText);
      const expectedMatches = operation.expectedMatches ?? 1;
      if (!Number.isInteger(expectedMatches) || expectedMatches < 1 || expectedMatches > 1000) {
        throw new Error(`${path} operation ${index + 1}: expectedMatches must be 1-1000`);
      }
      const actualMatches = countOccurrences(source, oldText);
      if (actualMatches !== expectedMatches) {
        throw new Error(
          `${path} operation ${index + 1}: expected ${expectedMatches} literal match(es), found ${actualMatches}`,
        );
      }
      source = replaceAllLiteral(source, oldText, newText);
      continue;
    }

    if (operation.kind === "replace_lines") {
      const lines = source.split("\n");
      const startLine = operation.startLine;
      const endLine = operation.endLine;
      if (
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine ||
        endLine > lines.length
      ) {
        throw new Error(
          `${path} operation ${index + 1}: invalid line range ${startLine}-${endLine} for ${lines.length} lines`,
        );
      }
      const replacement = normalizeSource(operation.newText).split("\n");
      lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
      source = lines.join("\n");
      continue;
    }

    source = normalizeSource(operation.source);
  }
  return source;
}

export function buildScriptPatchItems(
  requests: ScriptPatchRequest[],
  currentSources: ReadonlyMap<string, string>,
): ScriptPatchPlanItem[] {
  if (requests.length < 1 || requests.length > 50) {
    throw new Error("patches must contain 1-50 scripts");
  }
  const seen = new Set<string>();
  let totalSourceBytes = 0;
  return requests.map((request) => {
    if (seen.has(request.path)) throw new Error(`duplicate patch path: ${request.path}`);
    seen.add(request.path);
    const current = currentSources.get(request.path);
    if (current === undefined) throw new Error(`script source was not returned for ${request.path}`);
    const before = normalizeSource(current);
    const source = applyScriptPatchOperations(request.path, before, request.operations);
    const sourceBytes = Buffer.byteLength(source, "utf8");
    if (sourceBytes > 1_000_000) {
      throw new Error(`${request.path}: resulting source exceeds the 1,000,000-byte cap`);
    }
    totalSourceBytes += sourceBytes;
    if (totalSourceBytes > 5_000_000) {
      throw new Error("patchset resulting sources exceed the 5,000,000-byte total cap");
    }
    const diffText = unifiedDiff(before, source);
    const diff =
      diffText.length <= 20_000
        ? diffText
        : `${diffText.slice(0, 20_000)}\n... diff truncated (${diffText.length - 20_000} chars omitted)`;
    return {
      path: request.path,
      beforeHash: fnv1a32(before),
      afterHash: fnv1a32(source),
      source,
      changed: source !== before,
      diff,
    };
  });
}

export class ScriptPatchPlanStore {
  readonly #plans = new Map<string, ScriptPatchPlan>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly capacity = 12,
  ) {}

  create(targetId: string, items: ScriptPatchPlanItem[], nowMs = Date.now()): ScriptPatchPlan {
    this.prune(nowMs);
    if (!targetId) throw new Error("a concrete Studio target is required");
    const token = randomUUID();
    const plan: ScriptPatchPlan = {
      token,
      targetId,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
      items,
    };
    this.#plans.set(token, plan);
    while (this.#plans.size > this.capacity) {
      const oldest = this.#plans.keys().next().value;
      if (oldest === undefined) break;
      this.#plans.delete(oldest);
    }
    return plan;
  }

  consume(token: string, targetId: string, nowMs = Date.now()): ScriptPatchPlan {
    this.prune(nowMs);
    const plan = this.#plans.get(token);
    if (!plan) throw new Error("patch token is unknown, expired, or already used");
    if (plan.targetId !== targetId) {
      throw new Error(
        `patch token is bound to Studio target '${plan.targetId}', not '${targetId}'`,
      );
    }
    this.#plans.delete(token);
    return plan;
  }

  prune(nowMs = Date.now()): void {
    for (const [token, plan] of this.#plans) {
      if (Date.parse(plan.expiresAt) <= nowMs) this.#plans.delete(token);
    }
  }

  get size(): number {
    return this.#plans.size;
  }
}
