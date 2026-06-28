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
