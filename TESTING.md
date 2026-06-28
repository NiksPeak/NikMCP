# NikMCP — testing checklist

Core pipeline is already proven live (a `run_luau` round-trip returned real Studio data). Everything in
tasks 16–17 is build-verified only — this checklist validates it in Studio. Work top to bottom.

## 0. One-time setup
```bash
cd D:/GameProjects/NikMCP
npm install
npm run build          # creates dist/ (only needed once, or after code changes)
npm run build:plugin   # writes RobloxStudioMCP.rbxmx (~check it's ~140 KB+, not torn)
```
Register with Claude Code so the tools are callable (this is what makes it auto-launch like boshy):
```bash
claude mcp add -s user roblox-studio -- node D:/GameProjects/NikMCP/dist/index.js
```
Then **restart Claude Code** so it loads the `mcp__roblox-studio__*` tools.

## 1. Studio prep
- Copy `RobloxStudioMCP.rbxmx` into `%LOCALAPPDATA%\Roblox\Plugins` (or run `scripts/install-plugin.ps1`).
- Restart Studio, open a test place.
- Game Settings → Security: **Allow Mesh / Image APIs = ON** (for `capture_viewport`),
  **Allow HTTP Requests = ON** (only needed for F5/playtest tools), and **Enable Studio Access to API
  Services = ON** if you'll test DataStore tools.

## 2. Connect
- Open the **Nik Studio MCP** dock → connect a **58741** chip → **HTTP server** + **MCP bridge** go green.
- (NikMCP now uses boshy's port 58741 as a drop-in replacement — uninstall boshy so nothing competes.)

## 3. Tier 1 — smoke (the core)
In Claude Code: ask it to call `run_luau` with `print(game.Name)`.
✅ Pass = it prints your game name and the dock's **Commands** light turns green.

## 4. Tier 2 — category sweep (one representative per group; don't test all 85 by hand)
- **Read:** `get_instance_tree`, `read_console`, `search_instances` (try `className:"BasePart"`),
  `get_properties`.
- **Write + undo:** `create_instance` a Part in Workspace → `set_property` its Color → `undo` → confirm it
  reverts (proves ChangeHistory wrapping).
- **Scripts:** `write_script` a ModuleScript → `get_script_source` it back → `edit_script_lines` one line.
- **Screenshot:** `capture_viewport` → confirm a **real image** renders (not noise). If garbled, that's the
  PNG encoder — tell Claude.
- **Playtest lifecycle (task 17A):** `playtest_control` start (mode=run) → `get_playtest_status` (should
  show running) → `get_playtest_output` → `playtest_control` stop. Then start one and **walk away** to
  confirm it **auto-stops** after the cap.
- **Build system (task 16):** `export_build` a model → `import_build` it under a new parent →
  `compare_instances` the two.
- **Camera (task 16):** `set_camera` to frame something → `capture_viewport` → confirm the view moved.
- **New (task 17 B–E, if built):** `terrain_fill_region`, `set_lighting`, `compute_path`, `audit_place`,
  one DataStore read.

## 5. Tier 3 — safety / guardrails
- **Settings gating:** in the dock, toggle one tool OFF → ask Claude to call it → expect a clear
  "disabled in Studio settings" error (not a crash).
- **Read-only mode:** turn it ON → a write tool (`create_instance`) should be blocked; reads still work.
- **Honest unsupported:** call `search_assets` or `list_library` → expect a clear "needs Open Cloud"
  message, never a fake result.

## Fastest path: let Claude Code test itself
You don't have to drive 85 tools by hand. Paste this to Claude Code (with the MCP connected):

> You have the `roblox-studio` MCP connected to my Studio. Run a self-test: create a scratch Model in
> Workspace, then exercise one tool from each category (read, write+undo, scripts, attributes, search,
> build export/import, camera+capture_viewport, playtest start/status/output/stop). Report a table of
> tool → ok/fail → the error for any failure. Clean up the scratch Model at the end. Don't touch anything
> outside the scratch Model.

That sweeps the whole surface in one pass and hands you a pass/fail table. Anything red, send me the error.
