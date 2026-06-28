# NikMCP — 5-minute setup (no path editing, anywhere)

This connects your **Roblox Studio** to an **AI client** (Claude Code / Claude Desktop / Cursor).
You install **two halves**: a Studio plugin (one file) and the MCP server (runs from npm — nothing to clone).

> You never edit a file path. If a step tells you to paste a path, it's already correct as written.

**Prereqs:** [Node.js 18+](https://nodejs.org) installed, and Roblox Studio.

---

## 1. Install the Studio plugin (one file)

Copy `RobloxStudioMCP.rbxmx` into your local Roblox **Plugins** folder:

- **Windows:** `%LOCALAPPDATA%\Roblox\Plugins`
  (paste that into the File Explorer address bar — it expands automatically)
- **macOS:** `~/Documents/Roblox/Plugins`

That's the whole install — one file, dropped in one folder. No build, no path edits.

---

## 2. Register the MCP server (runs from npm)

Pick your client:

**Claude Code** — one command:
```bash
claude mcp add -s user nikmcp -- npx -y nikmcp@latest
```

**Claude Desktop / Cursor** — add this to the MCP config JSON (Settings → Developer → Edit Config):
```json
{
  "mcpServers": {
    "nikmcp": {
      "command": "npx",
      "args": ["-y", "nikmcp@latest"]
    }
  }
}
```

`npx -y nikmcp@latest` downloads and runs the server on demand — no clone, no folder, no path.
It listens on port **58741**, which is also the plugin's default, so they find each other with zero config.

---

## 3. Connect

1. Restart Roblox Studio. A **Studio MCP** toolbar appears.
2. Click **MCP Status** → it should show connected on **58741**.
3. Restart your AI client so it picks up the new server. Ask it something read-only like
   "get the place info" to confirm the round-trip.

---

## 4. Studio toggles (only if you use F5 playtest)

Plain edit-mode work needs nothing. For **F5 playtest** features:

- **Allow HTTP Requests** → **ON** (Game Settings → Security). Needed so the in-game runtime
  agent can reach the bridge during a playtest. Harmless when on; edit mode still works.
- **`ServerScriptService.LoadStringEnabled = true`** — needed for `run_luau` *inside* a running
  playtest (the server agent uses `loadstring`). Off = you get a clean compile error, edit mode unaffected.

---

## Troubleshooting

- **Status shows disconnected:** is the AI client actually running? `npx` only launches the server
  when the client starts it. Restart the client, then re-check **MCP Status**.
- **First connect is slow:** the first `npx` run downloads the package once, then caches it. Later runs are instant.
- **Port already in use:** another tool (e.g. boshyxd's `robloxstudio-mcp`) is on 58741 — close it, or
  ask Nik how to move both sides to another port in `58741..58760`.

No file paths were edited at any point. If you edited one, you went off-script — undo it.
