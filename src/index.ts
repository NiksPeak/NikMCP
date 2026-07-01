#!/usr/bin/env node
import { resolveConfig } from "./config.js";
import { startBridge, stopBridge } from "./bridge.js";
import { startMcpServer } from "./mcp-server.js";
import { runCli } from "./cli.js";

// One-time setup subcommands (set-key / set-creator / doctor) handle and exit here;
// otherwise fall through to the normal MCP server + Studio bridge.
if (!runCli(process.argv.slice(2))) {
  const cfg = resolveConfig();
  await startMcpServer(cfg); // stdio handshake first -> tools always visible
  startBridge(cfg); // best-effort HTTP bridge for Studio; never takes the process down

  // Free our port on a clean stop so a stopped session doesn't leak a stray server.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopBridge();
      process.exit(0);
    });
  }
}
