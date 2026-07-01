import express from "express";
import type { Request, Response } from "express";
import type { Server } from "node:http";
import type { AppConfig } from "./config.js";
import { HOST } from "./config.js";
import type { Context, CommandResult } from "./types.js";
import { dequeue, resolveResult, markSeen, isAlive } from "./queue.js";
import { setSettings, checkAuth } from "./settings.js";

const log = (...args: unknown[]) => console.error("[bridge]", ...args); // stderr only

const RETRY_MS = 3000; // when all ports are busy, re-attempt so a freed port binds without a restart

// Bridge bind state, shared so tool-call timeouts can explain a missing bridge.
let boundPort: number | null = null;
let portRangeLabel = "";
let httpServer: Server | null = null;
let retryTimer: NodeJS.Timeout | null = null;

// Agent self-diagnostics ring: the runtime agent POSTs tiny events to /diag
// (connect / poll / errors / shutdown) so we can read its last state + drop reason
// without Studio Output. Last DIAG_MAX events, exposed via get_status.
const DIAG_MAX = 20;
const diagEvents: Array<Record<string, unknown>> = [];

export function getDiag(): Array<Record<string, unknown>> {
  return diagEvents;
}

// Chunked command results. HttpService:PostAsync rejects bodies > 1024 KB, so the
// plugin splits an oversized result (e.g. a capture_viewport raw-RGBA payload) into
// ordered parts on /response-chunk; we reassemble by id here. The reassembled string
// is the EXACT JSON the single /response POST would have carried, so resolveResult
// sees an identical CommandResult -- mcp-server/renderResult are untouched.
interface ChunkState {
  total: number;
  parts: Array<string | undefined>;
  count: number;
  added: number; // first-chunk time, for the orphan sweep
}
const chunkBuffers = new Map<string, ChunkState>();
const CHUNK_TTL_MS = 60_000;
let chunkSweepTimer: NodeJS.Timeout | null = null;

// Accept one chunk; returns the assembled CommandResult once every part has arrived,
// else null. Out-of-order safe (placed by seq). Throws if the reassembled payload
// isn't valid JSON. Exported for the reassembly self-check.
export function acceptChunk(id: string, seq: number, total: number, part: string): CommandResult | null {
  let st = chunkBuffers.get(id);
  if (!st) {
    st = { total, parts: new Array<string | undefined>(total), count: 0, added: Date.now() };
    chunkBuffers.set(id, st);
  }
  if (seq >= 0 && seq < st.total && st.parts[seq] === undefined) {
    st.parts[seq] = part;
    st.count++;
  }
  if (st.count < st.total) return null;
  chunkBuffers.delete(id);
  return JSON.parse(st.parts.join("")) as CommandResult;
}

// Drop partials that never completed (a dropped chunk) so they can't leak memory.
// Returns how many were dropped. Exported for the self-check.
export function sweepChunks(now: number = Date.now()): number {
  let dropped = 0;
  for (const [id, st] of chunkBuffers) {
    if (now - st.added > CHUNK_TTL_MS) {
      chunkBuffers.delete(id);
      dropped++;
    }
  }
  return dropped;
}

export function getBoundPort(): number | null {
  return boundPort;
}

// Null when the bridge is bound; otherwise a human-readable reason it isn't.
export function bridgeUnavailableReason(): string | null {
  return boundPort == null
    ? `Studio bridge isn't listening (all ports ${portRangeLabel} are in use). ` +
        `Close stray servers or terminals, then it reconnects automatically.`
    : null;
}

// Clean shutdown so a stopped session frees its port instead of leaking it.
export function stopBridge(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (chunkSweepTimer) clearInterval(chunkSweepTimer);
  chunkSweepTimer = null;
  chunkBuffers.clear();
  httpServer?.close();
  httpServer = null;
  boundPort = null;
}

function asContext(raw: unknown): Context {
  return raw === "server" ? "server" : "edit";
}

// Returns true if the request is authorized; otherwise sends 401 and returns false.
function authed(req: Request, res: Response): boolean {
  if (checkAuth(req.header("x-mcp-token"))) {
    return true;
  }
  res.status(401).json({ ok: false, error: "unauthorized" });
  return false;
}

export function startBridge(cfg: AppConfig): void {
  const app = express();
  app.use(express.json({ limit: "16mb" }));

  // Periodically drop orphaned chunk partials (a dropped chunk would otherwise leak).
  // unref so this timer never keeps the process alive on its own.
  if (!chunkSweepTimer) {
    chunkSweepTimer = setInterval(() => sweepChunks(), 30_000);
    chunkSweepTimer.unref?.();
  }

  // Studio short-polls here. Returns immediately with the next queued command
  // (or null) plus merged liveness, so the plugin needs no separate heartbeat:
  // { command: <cmd|null>, edit, server }.
  app.get("/poll", (req, res) => {
    if (!authed(req, res)) return;
    const ctx = asContext(req.query.context);
    markSeen(ctx);
    res.json({ command: dequeue(ctx) ?? null, edit: isAlive("edit"), server: isAlive("server") });
  });

  // Studio returns a completed command result here.
  app.post("/response", (req, res) => {
    if (!authed(req, res)) return;
    resolveResult(req.body as CommandResult);
    res.sendStatus(200);
  });

  // Oversized results arrive split across chunks (PostAsync's 1024 KB body cap).
  // Authed exactly like /response. Reassemble by id; resolve once complete.
  app.post("/response-chunk", (req, res) => {
    if (!authed(req, res)) return;
    const { id, seq, total, part } = (req.body ?? {}) as {
      id?: string;
      seq?: number;
      total?: number;
      part?: string;
    };
    if (typeof id !== "string" || typeof seq !== "number" || typeof total !== "number" || typeof part !== "string") {
      res.status(400).json({ ok: false, error: "bad chunk" });
      return;
    }
    try {
      const result = acceptChunk(id, seq, total, part);
      if (result) resolveResult(result);
    } catch (e) {
      // Corrupt reassembly: resolve an error so the caller fails fast instead of timing out.
      resolveResult({ id, ok: false, error: `chunk reassembly failed: ${String(e)}` } as CommandResult);
    }
    res.sendStatus(200);
  });

  // Plugin pushes the tool-gating settings here (on connect + on every change).
  app.post("/settings", (req, res) => {
    if (!authed(req, res)) return; // allowed until a token is adopted (TOFU)
    setSettings(req.body ?? {});
    res.json({ ok: true });
  });

  // Lightweight liveness + which contexts are connected (drives status UI).
  // Not authed: harmless, and the plugin probes it before settings are pushed.
  app.get("/heartbeat", (req, res) => {
    const ctx = asContext(req.query.context);
    markSeen(ctx);
    res.json({ ok: true, edit: isAlive("edit"), server: isAlive("server") });
  });

  // Agent self-diagnostics sink. Not authed (harmless on 127.0.0.1) and does NOT
  // markSeen -- it's pure observation so it can't mask a real liveness drop.
  app.post("/diag", (req, res) => {
    const ev = (req.body as Record<string, unknown>) ?? {};
    diagEvents.push({ ...ev, received: Date.now() });
    while (diagEvents.length > DIAG_MAX) diagEvents.shift();
    res.sendStatus(200);
  });

  // Bind the first free port in [base, base+portRange). Each terminal spawns its
  // own bridge, so a fixed port would EADDRINUSE for the 2nd+; walk up instead.
  const base = cfg.port;
  const last = base + cfg.portRange - 1;
  portRangeLabel = `${base}-${last}`;
  function tryListen(port: number): void {
    const server = app.listen(port, HOST, () => {
      httpServer = server;
      boundPort = port;
      log(`listening on http://${HOST}:${port}`);
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        if (port < last) {
          tryListen(port + 1); // that one's taken (likely another terminal); try the next
          return;
        }
        // All ports busy: never exit (that would kill the MCP server). Retry so a
        // freed port binds automatically; the MCP stdio server stays up meanwhile.
        log(
          `no free port in ${base}..${last}; Studio bridge unavailable ` +
            `(MCP server still running - free a port and the next connect will bind)`
        );
        retryTimer = setTimeout(() => tryListen(base), RETRY_MS);
        return;
      }
      log("HTTP server error:", err, "- Studio bridge unavailable (MCP server still running)");
    });
  }
  tryListen(base);
}
