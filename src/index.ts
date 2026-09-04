#!/usr/bin/env node
import { resolveConfig } from "./config.js";
import { startBridge, stopBridge } from "./bridge.js";
import { getBoundPort } from "./bridge.js";
import { startMcpServer } from "./mcp-server.js";
import { configureStudioTargets } from "./studio-targets.js";

const cfg = resolveConfig();
configureStudioTargets({
  basePort: cfg.port,
  portRange: cfg.portRange,
  localPort: getBoundPort,
});
await startMcpServer(cfg); // stdio handshake first -> tools always visible
startBridge(cfg); // best-effort HTTP bridge for Studio; never takes the process down

// Free our port when the MCP client closes stdio or sends a process signal.
// Tests and desktop clients close stdin rather than sending SIGTERM; without
// the EOF handlers the Express bridge kept orphaned Node processes alive.
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopBridge();
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, shutdown);
}
