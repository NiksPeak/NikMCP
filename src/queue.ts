import { randomUUID } from "node:crypto";
import type { Command, CommandResult, Context } from "./types.js";
import { bridgeUnavailableReason } from "./bridge.js";
import {
  getLocalTargetIdentity,
  routeSelectedCommand,
  selectedContextHealth,
} from "./studio-targets.js";

interface Pending {
  resolve: (r: CommandResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
const queues: Record<Context, Command[]> = { edit: [], server: [] };
const lastSeen: Record<Context, number> = { edit: 0, server: 0 };

export function markSeen(ctx: Context): void {
  lastSeen[ctx] = Date.now();
}

export function isLocalAlive(ctx: Context, withinMs = 2000): boolean {
  return Date.now() - lastSeen[ctx] < withinMs;
}

export function localContextAgeMs(ctx: Context): number | null {
  return lastSeen[ctx] > 0 ? Date.now() - lastSeen[ctx] : null;
}

export function isAlive(ctx: Context, withinMs = 2000): boolean {
  const selected = selectedContextHealth(ctx);
  return selected ? selected.alive && (selected.ageMs === null || selected.ageMs < withinMs) : isLocalAlive(ctx, withinMs);
}

export function contextAgeMs(ctx: Context): number | null {
  const selected = selectedContextHealth(ctx);
  return selected ? selected.ageMs : localContextAgeMs(ctx);
}

// "auto" picks the running server agent if it's alive, else the edit plugin.
export function chooseContext(requested: Context | "auto"): Context {
  if (requested === "auto") {
    return isAlive("server") ? "server" : "edit";
  }
  return requested;
}

// Short-poll: return the next queued command for the context, or undefined.
export function dequeue(ctx: Context): Command | undefined {
  while (queues[ctx].length > 0) {
    const command = queues[ctx].shift()!;
    if (command.expiresAtMs > Date.now()) return command;
    const waiter = pending.get(command.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(command.id);
      waiter.reject(new Error(`command ${command.type} expired before Studio delivery`));
    }
  }
  return undefined;
}

export function resolveResult(r: CommandResult): void {
  const p = pending.get(r.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(r.id);
  p.resolve(r);
}

export function enqueueLocalAndAwait(
  type: string,
  context: Context,
  payload: unknown,
  timeoutMs: number,
  expectedTargetId?: string,
): Promise<CommandResult> {
  const id = randomUUID();
  const expiresAtMs = Date.now() + timeoutMs;
  const cmd: Command = {
    id,
    type,
    context,
    payload,
    expectedTargetId: expectedTargetId ?? getLocalTargetIdentity()?.targetId,
    expiresAtMs,
  };
  return new Promise<CommandResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const index = queues[context].findIndex((queued) => queued.id === id);
      if (index >= 0) queues[context].splice(index, 1);
      const hint =
        bridgeUnavailableReason() ??
        (isAlive(context)
          ? "context connected but did not respond"
          : `no Studio '${context}' context is polling`);
      reject(new Error(`command ${type} timed out after ${timeoutMs}ms (${hint})`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    queues[context].push(cmd); // delivered on the context's next poll
  });
}

export async function enqueueAndAwait(
  type: string,
  context: Context,
  payload: unknown,
  timeoutMs: number,
  expectedTargetId?: string,
): Promise<CommandResult> {
  const routed = await routeSelectedCommand(
    type,
    context,
    payload,
    timeoutMs,
    expectedTargetId,
  );
  return routed ?? enqueueLocalAndAwait(type, context, payload, timeoutMs, expectedTargetId);
}
