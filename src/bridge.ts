import express from "express";
import type { Request, Response } from "express";
import type { Server } from "node:http";
import type { AppConfig } from "./config.js";
import { HOST, setRoCreateApiKey } from "./config.js";
import type { Context, CommandResult } from "./types.js";
import {
  dequeue,
  resolveResult,
  markSeen,
  isLocalAlive,
  localContextAgeMs,
  enqueueLocalAndAwait,
} from "./queue.js";
import { setSettings, checkAuth, gateToolCall } from "./settings.js";
import {
  claimLocalTargetId,
  getLocalTargetIdentity,
  resolveWindowsStudioProcess,
  setLocalTargetIdentity,
  wouldAcceptTargetId,
} from "./studio-targets.js";
import {
  unlock as rocreateUnlock,
  lock as rocreateLock,
  setCookieSecret,
} from "./rocreate-secrets.js";
import {
  INTERNAL_ROUTE_HEADER,
  verifyInternalRouteToken,
} from "./internal-auth.js";

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

function targetClaimed(req: Request, res: Response): boolean {
  const targetId = req.header("x-mcp-target-id") ?? "";
  if (!targetId) {
    res.status(400).json({ ok: false, error: "x-mcp-target-id header required" });
    return false;
  }
  if (!claimLocalTargetId(targetId, isLocalAlive("edit") || isLocalAlive("server"))) {
    res.status(409).json({ ok: false, error: "bridge is leased to a different live Studio target" });
    return false;
  }
  return true;
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
    const targetId = typeof req.query.targetId === "string" ? req.query.targetId : "";
    if (!targetId) {
      res.status(400).json({ ok: false, error: "targetId query parameter required" });
      return;
    }
    if (!claimLocalTargetId(targetId, isLocalAlive("edit") || isLocalAlive("server"))) {
      res.status(409).json({
        ok: false,
        error: "bridge is leased to a different live Studio target",
      });
      return;
    }
    markSeen(ctx);
    // v0.2.0: a context that is still executing a long-running command keeps
    // polling with busy=1 so liveness never lapses mid-yield; it must not be
    // handed a second command until the first result has been posted.
    if (req.query.busy === "1") {
      res.json({ command: null, edit: isLocalAlive("edit"), server: isLocalAlive("server"), busy: true });
      return;
    }
    res.json({
      command: dequeue(ctx) ?? null,
      edit: isLocalAlive("edit"),
      server: isLocalAlive("server"),
    });
  });

  // A Studio window identifies itself after claiming the bridge with targetId.
  // The OS process lookup runs while this outbound Studio HTTP socket is still
  // established, letting Windows map the ephemeral peer port back to the exact
  // RobloxStudioBeta PID, title, and optional -file path.
  app.post("/target/identity", async (req, res) => {
    if (!authed(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const targetId = typeof body.targetId === "string" ? body.targetId : "";
    const studioSessionId = typeof body.studioSessionId === "string" ? body.studioSessionId : "";
    if (!targetId || !studioSessionId) {
      res.status(400).json({ ok: false, error: "targetId and studioSessionId required" });
      return;
    }
    if (!claimLocalTargetId(targetId, isLocalAlive("edit") || isLocalAlive("server"))) {
      res.status(409).json({ ok: false, error: "bridge is leased to a different live Studio target" });
      return;
    }
    const processInfo = await resolveWindowsStudioProcess(req.socket.remotePort, boundPort);
    setLocalTargetIdentity(
      {
        targetId,
        studioSessionId,
        placeId: typeof body.placeId === "number" ? body.placeId : 0,
        universeId: typeof body.universeId === "number" ? body.universeId : 0,
        placeName: typeof body.placeName === "string" ? body.placeName : "",
      },
      processInfo
    );
    res.json({ ok: true, targetId });
  });

  // Read-only target descriptor used by get_studio_targets and by the
  // identity pin before every selected call.
  app.get("/target", (req, res) => {
    if (!authed(req, res)) return;
    const identity = getLocalTargetIdentity();
    if (!identity) {
      res.status(503).json({ ok: false, error: "no Studio target has identified itself" });
      return;
    }
    const editAlive = isLocalAlive("edit");
    const serverAlive = isLocalAlive("server");
    res.json({
      kind: "nikmcp-studio-target",
      targetId: identity.targetId,
      studioSessionId: identity.studioSessionId,
      bridgePort: boundPort,
      windowTitle: identity.windowTitle,
      studioPid: identity.pid,
      placeId: identity.placeId,
      universeId: identity.universeId,
      placeName: identity.placeName,
      placeFilePath: identity.filePath,
      state: serverAlive ? "runtime" : editAlive ? "edit" : "disconnected",
      health: {
        bridge: boundPort !== null,
        plugin: editAlive,
        runtimeAgent: serverAlive,
        editAgeMs: localContextAgeMs("edit"),
        serverAgeMs: localContextAgeMs("server"),
      },
      connectedToThisMcp: true,
      selected: false,
    });
  });

  // Authenticated loopback proxy for explicit cross-port selection. The peer
  // bridge re-applies its own Studio settings gate and refuses identity drift.
  app.post("/invoke", async (req, res) => {
    if (!authed(req, res)) return;
    if (!verifyInternalRouteToken(req.header(INTERNAL_ROUTE_HEADER))) {
      res.status(403).json({ ok: false, error: "internal Studio routing capability required" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const identity = getLocalTargetIdentity();
    if (!identity || body.expectedTargetId !== identity.targetId) {
      res.status(409).json({ ok: false, error: "selected Studio target identity changed" });
      return;
    }
    const type = typeof body.type === "string" ? body.type : "";
    const context = body.context === "server" ? "server" : body.context === "edit" ? "edit" : null;
    if (!type || !context) {
      res.status(400).json({ ok: false, error: "type and valid context required" });
      return;
    }
    const payload = body.payload as Record<string, unknown> | undefined;
    const gateAs = typeof payload?.gateAs === "string" ? payload.gateAs : null;
    const gateName =
      gateAs && (gateAs === "edit_script" || gateAs === "restore_script_backup" || gateAs === "run_harness")
        ? gateAs
        : type === "client_query" && payload?.name === "input_sequence"
          ? "client_input_sequence"
          : type === "client_query" && payload?.name === "activate_gui"
            ? "client_activate"
            : type === "client_activate"
              ? "client_activate"
              : type === "sync_set_sources"
                ? "import_scripts"
                : type;
    const gateReason = gateToolCall(gateName);
    if (gateReason) {
      res.status(403).json({ ok: false, error: gateReason });
      return;
    }
    const timeoutMs = Math.max(250, Math.min(120_000, Number(body.timeoutMs) || 30_000));
    try {
      const result = await enqueueLocalAndAwait(
        type,
        context,
        body.payload,
        timeoutMs,
        identity.targetId,
      );
      res.json(result);
    } catch (e) {
      res.status(504).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Studio returns a completed command result here.
  app.post("/response", (req, res) => {
    if (!authed(req, res)) return;
    if (!targetClaimed(req, res)) return;
    resolveResult(req.body as CommandResult);
    res.sendStatus(200);
  });

  // Oversized results arrive split across chunks (PostAsync's 1024 KB body cap).
  // Authed exactly like /response. Reassemble by id; resolve once complete.
  app.post("/response-chunk", (req, res) => {
    if (!authed(req, res)) return;
    if (!targetClaimed(req, res)) return;
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
    if (!targetClaimed(req, res)) return;
    setSettings(req.body ?? {});
    res.json({ ok: true });
  });

  // Task 26 RoCreate: the dock POSTs the password here. Node derives the key,
  // decrypts the cookie, and holds it in memory only (idle expiry). The password
  // itself is never stored; a decrypt failure is the wrong-password signal. Authed
  // by the same x-mcp-token as the mutating routes -- a cookie sits behind this.
  app.post("/rocreate/unlock", (req, res) => {
    if (!authed(req, res)) return;
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== "string" || !password) {
      res.status(400).json({ ok: false, error: "password required" });
      return;
    }
    const r = rocreateUnlock(password);
    // Never echo the reason verbatim beyond the two safe cases; both are non-sensitive.
    res.status(r.ok ? 200 : 401).json(r);
  });

  app.post("/rocreate/lock", (req, res) => {
    if (!authed(req, res)) return;
    rocreateLock();
    res.json({ ok: true });
  });

  // One-time set-credentials from the dock: encrypt the cookie with the password
  // and persist it. The cookie is never echoed back or logged.
  app.post("/rocreate/set-credentials", (req, res) => {
    if (!authed(req, res)) return;
    const { cookie, password } = (req.body ?? {}) as { cookie?: unknown; password?: unknown };
    if (typeof cookie !== "string" || typeof password !== "string" || !cookie || !password) {
      res.status(400).json({ ok: false, error: "cookie and password required" });
      return;
    }
    if (!cookie.includes("_|WARNING:-DO-NOT-SHARE-THIS.")) {
      res.status(400).json({ ok: false, error: "that does not look like a .ROBLOSECURITY cookie" });
      return;
    }
    try {
      setCookieSecret(cookie, password);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.post("/rocreate/set-api-key", (req, res) => {
    if (!authed(req, res)) return;
    const apiKey = (req.body as { apiKey?: unknown } | undefined)?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      res.status(400).json({ ok: false, error: "api key required" });
      return;
    }
    try {
      setRoCreateApiKey(apiKey);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Lightweight liveness + which contexts are connected (drives status UI).
  // Not authed: harmless, and the plugin probes it before settings are pushed.
  // v0.2.0: with ?targetId= the answer also says whether THIS bridge would
  // accept that Studio window (lease-aware) and whether the caller's token is
  // valid, so a runtime agent can pick the right bridge up front instead of
  // discovering the wrong one through a 401/409 busy-loop. Read-only: never
  // claims, never markSeen.
  app.get("/heartbeat", (req, res) => {
    const targetId = typeof req.query.targetId === "string" ? req.query.targetId : "";
    const base: Record<string, unknown> = {
      ok: true,
      edit: isLocalAlive("edit"),
      server: isLocalAlive("server"),
      port: boundPort,
    };
    if (targetId) {
      const lease = wouldAcceptTargetId(targetId, isLocalAlive("edit") || isLocalAlive("server"));
      base.accepts = lease.accepts;
      base.exact = lease.exact;
      base.leasedTargetId = lease.leasedTargetId;
      base.tokenOk = checkAuth(req.header("x-mcp-token"));
    }
    res.json(base);
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
