# Roblox Studio MCP (dual-context)

A local AI-to-Studio bridge. An MCP client (Claude Desktop / Claude Code / Cursor) calls tools
like `run_luau` or `get_instance_tree`; the call travels **MCP client → (stdio) → Node MCP
server → in-process queue → Express bridge → (localhost HTTP) → Roblox Studio → DataModel**,
and the result comes back the same way.

Roblox plugins cannot open a listening socket, so Studio always **polls outward**. That single
constraint forces the architecture.

Two differentiators over existing tools:

1. **Configurable port** (kills port-conflict pain) with plugin-side auto-discovery.
2. **Dual-context**: the bridge stays connected during **F5 playtest**, not just edit mode, via
   a second poll loop running inside the live game (the *runtime agent*).

```
MCP client ──stdio──▶ Node process ─┬─ MCP server (stdio)
                                    └─ Express bridge 127.0.0.1:<PORT>
                                          ▲                    ▲
                       GET /poll?context=edit      GET /poll?context=server
                       POST /response              POST /response
                            │                            │
                   EDIT PLUGIN (PluginSecurity)   RUNTIME AGENT (Script in
                   polls in edit mode,            ServerScriptService) — wakes on
                   owns the status dock           F5, polls the running server
```

## Layout

| Path | What |
|------|------|
| `src/index.ts` | Entry: resolve config, start bridge + MCP server |
| `src/config.ts` | Port precedence: `--port` > `ROBLOX_STUDIO_PORT`/`PORT` env > `config.json` > `58741` |
| `src/types.ts` | Shared `Command` / `CommandResult` / `Context` types |
| `src/queue.ts` | Per-context queues, correlation IDs, timeouts, `chooseContext` routing |
| `src/bridge.ts` | Express `/poll` `/response` `/heartbeat` `/settings`, context-aware, optional auth |
| `src/settings.ts` | In-memory tool gating + flags (plugin is source of truth; server enforces) |
| `src/mcp-server.ts` | MCP server + tools (every `tools/call` gated by settings) |
| `plugin/src/*.luau` | Edit plugin: `init.server`, `Config`, `Settings`, `Serializer`, `Executor`, `StatusWidget`, `RuntimeAgentSource` |
| `plugin/plugin.project.json` | Rojo project (build target) |
| `scripts/install-plugin.{sh,ps1}` | Build the `.rbxmx` into the local Plugins folder |

## Tools

Every tool is **enabled by default** and can be toggled off in the dock's **Settings** tab
(see below). The server enforces the toggles: a disabled tool returns an error before it ever
reaches Studio. "Write" tools also respect **read-only mode**.

| Tool | Kind | Context | Notes |
|------|------|---------|-------|
| `run_luau` | write | auto / edit / server | print output + returned value (serialized) |
| `get_instance_tree` | read | auto / edit / server | depth-limited tree from a dot path |
| `read_console` | read | auto / edit / server | recent Output via `LogService` history + live ring buffer; `count`, `levelFilter` |
| `get_selection` | read | edit | current `Selection:Get()` as paths |
| `search_instances` | read | auto / edit / server | by name substring / `className` / tag under a root |
| `get_script_source` | read | auto / edit / server | `GetEditorSource`, fallback `.Source` |
| `list_scripts` | read | auto / edit / server | all `LuaSourceContainer`s under a root |
| `get_place_info` | read | auto / edit / server | place/game id, services, child counts, selection, camera |
| `get_tagged` | read | auto / edit / server | `CollectionService:GetTagged(tag)` |
| `get_properties` | read | auto / edit / server | **curated** common-property dump (not exhaustive); optional `propertyNames` |
| `set_property` | write | auto / edit / server | edit context wraps in undo history |
| `write_script` | write | edit only | `ScriptEditorService:UpdateSourceAsync` |
| `set_selection` | write | edit | `Selection:Set(paths)` |
| `create_instance` | write | auto / edit / server | `{ className, parentPath, name?, properties? }` |
| `delete_instance` | write | auto / edit / server | destroy at path |
| `clone_instance` | write | auto / edit / server | `{ path, parentPath? }` |
| `rename_instance` | write | auto / edit / server | `{ path, name }` |
| `set_parent` | write | auto / edit / server | `{ path, parentPath }` |
| `move_instance` | write | auto / edit / server | `{ path, cframe \| position }` (Model uses `PivotTo`) |
| `bulk_set_property` | write | auto / edit / server | one undoable batch over `paths[]` |
| `tag_instance` / `untag_instance` | write | auto / edit / server | CollectionService add/remove |
| `insert_asset` | write | auto / edit / server | `InsertService:LoadAsset(assetId)` then parent (owned/public only) |
| `enable_playtest_agent` | write | edit only | arm the runtime agent before F5 |
| `get_attribute` / `get_attributes` | read | auto / edit / server | `Instance:GetAttribute(s)` |
| `set_attribute` / `set_attributes` | write | auto / edit / server | set one / many attributes (one undo) |
| `delete_attribute` | write | auto / edit / server | `SetAttribute(name, nil)` |
| `edit_script_lines` | write | edit only | replace 1-based line range `[startLine,endLine]` |
| `insert_script_lines` | write | edit only | insert before a 1-based line |
| `delete_script_lines` | write | edit only | delete a 1-based line range |
| `find_and_replace_in_scripts` | write | edit only | find/replace across scripts under a root (`regex?`) |
| `grep_scripts` | read | auto / edit / server | matches `{ path, line, text }` under a root (`regex?`) |
| `get_script_analysis` | read | auto / edit / server | compile-check (loadstring) syntax diagnostics |
| `undo` / `redo` | write | edit only | `ChangeHistoryService:Undo()/Redo()` |
| `mass_create_objects` | write | auto / edit / server | create many in one undo (`items[]`) |
| `mass_duplicate` | write | auto / edit / server | clone `count` times, cumulative `offset?` |
| `smart_duplicate` | write | auto / edit / server | grid/line clone layout (`columns?`, `spacing?`) |
| `mass_get_property` | read | auto / edit / server | one property across `paths[]` |
| `mass_set_property` | write | auto / edit / server | alias of `bulk_set_property` |
| `get_class_info` | read | auto / edit / server | best-effort (creatable? + applicable curated props); **no full reflection** (no API dump bundled) |
| `get_services` | read | auto / edit / server | loaded services (children of `game`) |
| `get_descendants` | read | auto / edit / server | flat descendant paths (`maxDepth?`, cap 5000) |
| `get_connected_instances` | read | auto / edit / server | `GetConnectedParts(true)` + object props |
| `compare_instances` | read | auto / edit / server | curated-property diff of two instances |
| `get_project_structure` | read | auto / edit / server | per-service child counts + by-class |
| `get_file_tree` | read | auto / edit / server | nested script tree under a root |
| `set_properties` | write | auto / edit / server | many props on one instance (one undo) |
| `search_by_property` | read | auto / edit / server | instances whose property == value |
| `get_tags` | read | auto / edit / server | `CollectionService:GetTags(instance)` |
| `get_asset_details` | read | auto / edit / server | `MarketplaceService:GetProductInfo` |
| `get_asset_thumbnail` | read | auto / edit / server | `rbxthumb://` content id for an asset |
| `preview_asset` | read | auto / edit / server | product info + thumbnail content id |
| `search_materials` | read | auto / edit / server | `Enum.Material` names (`query?`) |
| `search_assets` | read | — | **unsupported from a plugin** (needs Open Cloud / web catalog API); clear error |
| `list_library` | read | — | **unsupported from a plugin** (needs Open Cloud); clear error |
| `upload_decal` | write | — | **unsupported from a plugin** (needs Open Cloud Assets API key); clear error |
| `capture_viewport` | experimental | edit | **real PNG** via `CaptureService` + EditableImage; needs Game Settings > Security > **Allow Mesh / Image APIs** (else a clear enable-this message) |
| `playtest_control` | experimental | edit | start/stop the in-Studio sim (`mode='run'` → `RunService:Run()/Stop()`); `mode='play'` (Play Solo / players) unsupported |
| `get_playtest_output` | experimental | edit | drain/peek the playtest log buffer captured since start |
| `simulate_keyboard_input` / `simulate_mouse_input` | experimental | — | `VirtualInputManager` is **RobloxScriptSecurity-restricted**; returns a clear reason when blocked |
| `character_navigation` | experimental | server | `Humanoid:MoveTo(position)`; needs a running playtest (use `context:"server"`) |
| `get_status` | meta | — | `{ edit, server }` connectivity (ungated) |

`context: "auto"` (the default) targets the **running F5 server** when it's alive, else the editor.

**Context note:** every tool is implemented in the **edit** `Executor`. During a live F5 playtest,
`auto` routes to the **server** agent, which mirrors `run_luau` + the **read** tools (instance tree,
console, search/list, place info, properties, attributes, descendants, services, tags,
`search_by_property`) plus `character_navigation`, and returns a clean "agent does not support
command" error for edit-only ops (selection, script editing, undo, asset insertion, tagging) — those
are edit-time operations anyway. Pass `context: "edit"` to target the editor explicitly.

## Settings

The dock has three tabs: **Status / Settings / Activity**.

- **Settings** (scrollable): every tool as a toggle, grouped **Read / Write / Experimental** (all
  default ON), plus **Read-only mode** (master write kill-switch), **Confirm-destructive** (persisted
  stub — no confirmation flow yet), **Sound**, **Activity log**, and optional **Auth** (enable +
  token). The plugin persists settings to `plugin:SetSetting("NikMCP_Settings", …)` and POSTs them to
  the bridge `POST /settings` on connect and on every change. The server stores them and gates every
  `tools/call`.
- **Activity**: the last ~50 executed commands — tool, target (truncated), ok/err, round-trip ms,
  timestamp; ok green / err red.

**Optional auth (default off, localhost belt-and-suspenders).** When enabled, the plugin sends
`x-mcp-token: <token>` on `/poll` `/response` `/settings`. The server adopts the token on the first
`/settings` that enables it (**trust-on-first-use**) and then rejects requests missing/!= it.
Disabling it from the dock clears the adopted token. The F5 runtime agent carries the token via its
`McpToken` attribute.

## Setup

### 1. Node server
```bash
npm install
npm run build
# smoke test (no Studio needed):
node dist/index.js --port 58741 &
curl "http://127.0.0.1:58741/heartbeat?context=edit"   # -> {"ok":true,"edit":true,"server":false}
```

### 2. Build & install the plugin (human does the install)
```bash
# macOS / Linux
bash scripts/install-plugin.sh
```
```powershell
# Windows
./scripts/install-plugin.ps1
```
Or directly: `rojo build plugin/plugin.project.json -o "<Roblox Plugins folder>/RobloxStudioMCP.rbxmx"`.
Requires [Rojo](https://rojo.space). Restart Studio → a **Studio MCP** toolbar appears with
**MCP Status** and **Enable Playtest** buttons.

### 3. Register with your MCP client (path-free)
No clone, no hardcoded path — the server runs straight from npm via `npx`, exactly like
boshyxd's. Default port is `58741` on **both** sides, so **no `--port` needed**.

Claude Code (one command):
```bash
claude mcp add -s user nikmcp -- npx -y nikmcp@latest
```
Claude Desktop / Cursor (JSON):
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

**Local dev (this repo only).** When hacking on the server itself, skip npm and point at your
own build so you test uncommitted changes:
```json
{
  "mcpServers": {
    "nikmcp-dev": {
      "command": "node",
      "args": ["D:/GameProjects/NikMCP/dist/index.js"]
    }
  }
}
```
(Add `"--port", "5874X"` to either form only if you've moved off the default 58741.)

### 4. Studio settings the human must verify
- **Allow HTTP Requests** (Game Settings → Security): **NOT required for normal edit-mode use.** The edit
  plugin polls localhost at PluginSecurity, which Studio permits regardless of this toggle — the same
  reason Rojo syncs without it. `HttpEnabled` only gates HTTP from the *running experience* (in-game
  scripts). It **is required only for the F5 runtime agent**, which runs as an in-experience server
  script. So: leave it OFF for plain edit-mode work if you like, turn it **ON if you use F5 playtest**
  (it does no harm when on, and edit-mode keeps working with it on).
- For `run_luau` in the **server** (F5) context: **`ServerScriptService.LoadStringEnabled = true`**
  (the agent uses `loadstring`; if off it returns a clean compile error).
- For `capture_viewport`: **Allow Mesh / Image APIs = ON** (Game Settings → Security).

## F5 playtest flow

1. In **edit mode**, click **Enable Playtest** (or call `enable_playtest_agent` once). The
   plugin writes `MCP_RuntimeAgent` into `ServerScriptService` and stamps the chosen port on it
   as the `McpPort` attribute.
2. Press **F5**. Studio copies that Script into the new server DataModel, where it sees
   `RunService:IsRunning()` true, resolves its port (attribute first, then probe), and opens its
   own `context=server` poll + heartbeat loops.
3. `get_status` now shows `{ edit: true, server: true }`.
4. `run_luau` with `context:"auto"` hits the **running game**; `context:"edit"` still targets the
   editor.
5. Stop the playtest → the agent's loops end → the `server` context goes stale within ~2s →
   routing falls back to `edit`.

**Run button (not F5)** needs none of this — Run simulates the server in the *same* DataModel the
edit plugin is already bound to, so `run_luau` reaches it with zero setup. Only **Play / Play
Solo (F5)** needs the runtime agent.

**Client-context limitation (honest):** the agent runs in the **server** DataModel. Arbitrary
Luau on the **client** side of a playtest is out of scope — `loadstring` doesn't work in
client/LocalScript context. A client agent would be a separate, narrower feature.

## Ports
Default base is **58741** — boshyxd `robloxstudio-mcp`'s port — so NikMCP is a drop-in
replacement (remove boshy so nothing competes for 58741). Range 58741-58760.
Default `58741`. Override with `--port`, `ROBLOX_STUDIO_PORT`/`PORT`, or `config.json`
(see `config.example.json`). The plugin and agent probe `58741..58760`; if you
pick a port outside that set, add it to `CANDIDATE_PORTS` in `plugin/src/Config.luau` (first).

## Design invariants (do not "improve" away)
- One Node process hosts both the MCP server and the bridge — no cross-process plumbing.
- Short-poll ~250ms (≈240 req/min per loop; localhost ceiling ~2000/min). Long-poll only if measured.
- Bind `127.0.0.1` only, never `0.0.0.0`.
- All logs to **stderr** — stdout is reserved for MCP JSON-RPC.
- Every edit-context mutation is wrapped in `ChangeHistoryService`; not during playtest.

## Status / scope
Node side (bridge + MCP server + all six tools + routing) is built and verified end-to-end:
a real MCP `tools/list` + `tools/call run_luau` round-trips through the bridge, and `auto`
routing switches to the server context when alive. The Luau plugin is written but **must be
installed and confirmed inside Studio by a human** — the toolbar/dock, the edit round-trip, and
the F5 dual-context flow can only be verified there.

## Security note
The bridge binds `127.0.0.1` only. `run_luau` executes arbitrary Luau in **your** Studio — treat
it like the command bar. Local install only; not Creator-Store-publishable (`loadstring` is
banned in distributed assets), which is fine — you never publish it.
# NikMCP
## Yours truly, NiksPeak