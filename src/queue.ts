import { randomUUID } from "node:crypto";
import type { Command, CommandResult, Context } from "./types.js";
import { bridgeUnavailableReason } from "./bridge.js";

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

export function isAlive(ctx: Context, withinMs = 2000): boolean {
  return Date.now() - lastSeen[ctx] < withinMs;
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
  return queues[ctx].shift();
}

export function resolveResult(r: CommandResult): void {
  const p = pending.get(r.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(r.id);
  p.resolve(r);
}

export function enqueueAndAwait(
  type: string,
  context: Context,
  payload: unknown,
  timeoutMs: number
): Promise<CommandResult> {
  const id = randomUUID();
  const cmd: Command = { id, type, context, payload };
  return new Promise<CommandResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
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
