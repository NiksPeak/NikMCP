# Roblox Studio MCP (dual-context)

**Version 0.1.7** — July 6, 2026.

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
| `plugin/src/*.luau` | Edit plugin: `init.server`, `Config`, `Settings`, `Serializer`, `Executor`, `StatusWidget`, `RuntimeAgentSource`, `ClientAgentSource` |
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
| `read_console` | read | auto / edit / server / **client** | recent Output via `LogService` history + live ring buffer; `count`, `levelFilter`; `context="client"` drains the F5 **play-mode** client's ring, relayed to the server agent over `NikMCP_ClientRelay` |
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
| `export_scripts` | read | edit only | dump all scripts under `root` (default: the 8 script-bearing services) to a disk tree with Rojo-style names + a `nikmcp-sync.json` manifest — see **Script sync** |
| `sync_status` | read | edit only | three-way drift report per exported file: clean / diskAhead / studioAhead / CONFLICT / missing — see **Script sync** |
| `import_scripts` | write | edit only | apply diskAhead files back to Studio in ONE undo step; any conflict aborts everything with a diff; sources Luau-analyzed first — see **Script sync** |
| `undo` / `redo` | write | edit only | `ChangeHistoryService:Undo()/Redo()` |
| `mass_create_objects` | write | auto / edit / server | create many in one undo (`items[]`) |
| `mass_duplicate` | write | auto / edit / server | clone `count` times, cumulative `offset?` |
| `smart_duplicate` | write | auto / edit / server | grid/line clone layout (`columns?`, `spacing?`) |
| `mass_get_property` | read | auto / edit / server | one property across `paths[]` |
| `mass_set_property` | write | auto / edit / server | alias of `bulk_set_property` |
| `get_class_info` | read | **Node-side** (no Studio round-trip) | **real reflection from the official Roblox API dump**: superclass, tags, creatable?, and paginated members (~50/page via `cursor`) with `memberType` filter, `includeInherited`, valueType/security/tags + declaring class; unknown class returns a did-you-mean |
| `get_services` | read | auto / edit / server | loaded services (children of `game`) |
| `get_descendants` | read | auto / edit / server | flat descendant paths (`maxDepth?`, cap 5000) |
| `get_connected_instances` | read | auto / edit / server | `GetConnectedParts(true)` + object props |
| `compare_instances` | read | auto / edit / server | curated-property diff of two instances |
| `get_project_structure` | read | auto / edit / server | per-service child counts + by-class |
| `get_file_tree` | read | auto / edit / server | nested script tree under a root |
| `remote_inventory` | read | auto / edit / server | every Remote/Bindable Event/Function under `root` + a name-matched usage scan across all scripts (`FireServer`/`InvokeServer`/`OnServerEvent`/.../`WaitForChild`/`FindFirstChild`); shared names marked `ambiguous` |
| `datastore_inventory` | read | auto / edit / server | scans scripts for `GetDataStore`/`GetOrderedDataStore`/`GetGlobalDataStore`/MemoryStore declarations + `GetAsync`/`SetAsync`/.../`GetSortedAsync` calls, grouped by store name (non-literal names `dynamic:true`) |
| `require_graph` | read | auto / edit / server | every `require()` call site, best-effort resolved against the live DataModel (`game.X.Y`, `game:GetService`, `script.Parent.X`, `WaitForChild`/`FindFirstChild`); numeric asset ids and unresolved expressions reported separately; `topRequired` + simple cycle detection |
| `monetization_map` | read | Node composite | code scan (`PromptProductPurchase`/`PromptGamePassPurchase`/`UserOwnsGamePassAsync`/`GetProductInfo`/`ProcessReceipt`/id-like bindings) merged with live developer products + game passes (`universeId`, needs a RoCreate key) -- marks each live item `wired` and each code id `orphanCode`; degrades to code-only with a `note` when `universeId`/key is missing |
| `place_digest` | read | Node composite | one-call project overview: `get_project_structure` + script/tag/workspace/StarterGui/sound/animation counts + `remote_inventory` + `datastore_inventory` + a monetization code scan, as a short human-readable summary followed by the full merged JSON; `include` skips heavy parts |
| `ui_style_fingerprint` | read | auto / edit / server | fingerprints StarterGui's (or `root`'s) art style: fonts, UICorner sharp/rounded/pill buckets, UIStroke thickness/color, UIGradient color pairs, a quantized background/text/image color histogram, a shadow-name heuristic, layout hygiene (Scale vs Offset usage, padding/list/grid/aspect-ratio counts), and distinct image ids; Node classifies a `styleClass` (flat/rounded-soft/bubbly/pill-heavy/mixed/skeuo-textured) + a reusable token set |
| `world_style_probe` | read | auto / edit / server | fingerprints the 3D world's art style: color histogram, Material counts + neon/plastic/stud-like (MaterialVariant name) fractions, avg/median part size, transparency fraction, MeshPart/Part/Union counts, texture/decal/SurfaceAppearance counts, juice signals (ParticleEmitter/Beam/Trail), light counts, and a cheap non-voxel Terrain check; stride-sampled above `sampleCap` (default 50000); Node classifies a materials character + mesh-vs-part character |
| `lighting_profile` | read | edit only | Lighting's mood-defining properties (Technology, ClockTime, Brightness, Ambient/OutdoorAmbient + luminance, fog) plus any Atmosphere/Sky/Bloom/ColorCorrection/DepthOfField/SunRays/Blur effect children; Node classifies a mood (bright-clean/bright-bubbly/warm-cozy/dark-moody/neutral-default) |
| `ui_layout_probe` | read | auto / edit / server | pure-math layout solver (no rendering): solves every GuiObject's absolute rect under `root` at each `resolutions` entry (default phone/tablet/desktop), applying UDim2/AnchorPoint/UISizeConstraint/UIAspectRatioConstraint (approx)/SizeConstraint/UIPadding/UIListLayout/UIGridLayout (approx) and a fixed 58px topbar inset; reports offscreen/overlapping/too-small-touch-target/clipped-text/tiny-text issues per resolution plus an explicit `approximations` list of every simplification |
| `art_direction_report` | read | Node composite | wraps `ui_style_fingerprint` + `world_style_probe` + `lighting_profile` (skip any via `include`) and writes one natural-language art-direction brief (overall direction, the UI token set to reuse, DO/DONT bullets) followed by the full JSON of all three raw payloads -- the flagship style-bucket deliverable |
| `set_properties` | write | auto / edit / server | many props on one instance (one undo) |
| `search_by_property` | read | auto / edit / server | instances whose property == value |
| `get_tags` | read | auto / edit / server | `CollectionService:GetTags(instance)` |
| `get_asset_details` | read | auto / edit / server | `MarketplaceService:GetProductInfo` |
| `get_asset_thumbnail` | read | auto / edit / server | `rbxthumb://` content id for an asset |
| `preview_asset` | read | auto / edit / server | product info + thumbnail content id |
| `search_materials` | read | auto / edit / server | `Enum.Material` names (`query?`) |
| `search_assets` | read | — | **unsupported from a plugin** (needs Open Cloud / web catalog API); clear error |
| `list_library` | read | — | **unsupported from a plugin** (needs Open Cloud); clear error |
| `upload_decal` | write | — | still unsupported directly (no decal-specific Open Cloud endpoint) — **use `upload_asset`** (`assetType:"Image"`/`"Decal"`) instead, now supported via Open Cloud; see below |
| `upload_asset` | write | — (Node-side, Open Cloud) | uploads bytes (`filePath` or base64 `content`) via the Open Cloud Assets API: `{ assetType: Image\|Decal\|Audio\|Model, filePath?, content?, contentType?, displayName, description?, applyTo?: {path, property} }` -> `{ assetId, assetUri: "rbxassetid://<id>", moderationState, applied? }`; 20 MB/file cap; `applyTo` calls the existing `set_property` after upload; honest `"not configured"` without a key (see **Open Cloud setup** below) |
| `upload_capture` | write | edit (capture) + Node (upload) | composite: `capture_viewport` -> `upload_asset assetType:"Image"` in one call — `{ displayName, applyTo? }`, screenshot straight to `rbxassetid://` |
| `capture_viewport` | experimental | edit (pinned) | **real PNG** via `CaptureService` + EditableImage; plugin sends raw RGBA, Node encodes the PNG. **Edit mode only, viewport must be visible & rendering** (engine limit -- it reads the rendered screen; playtest-view capture is **not** supported, same constraint as boshyxd). Needs Game Settings > Security > **Allow Mesh / Image APIs** (else a clear enable-this message) |
| `orbit_capture` | experimental | edit (pinned), Node composite | frame `path` from up to 6 fixed angles (`front`/`back`/`left`/`right`/`top`/`iso`, default `[front,right,top,iso]`) via `get_bounding_box` + `set_camera` + `capture_viewport`, one PNG per angle; saves the camera first and always restores it after, even on error. Zero new plugin code |
| `selection_capture` | experimental | edit (pinned) | screenshot with each target instance temporarily wrapped in a `Highlight` (distinct color per target, 8-color palette) and optionally auto-framed on their combined bounding box; defaults to the current Studio selection when `paths` is omitted. Highlights + camera are always torn down/restored, even on error. Returns the PNG plus a `legend` (`path` -> `colorHex`) |
| `visual_diff` | experimental | edit (pinned), Node composite | in-memory visual regression check (baselines live only for this server process, LRU-capped at 8 labels — not persisted to disk). `mode:"baseline"` optionally frames `path` (same `iso` angle as `orbit_capture`) and stores a capture + the camera used under `label`; `mode:"compare"` replays that exact camera, recaptures, and reports percent-of-pixels-changed (>12 max-channel-delta threshold), mean delta, and the changed-region bounding box — a dimension mismatch is reported as text instead of bogus stats |
| `ui_capture` | experimental | — | **unsupported**: pixel-level GUI capture needs the F5 play-mode client, but the client agent is a fixed, intentionally-closed introspection whitelist (`fps`/`camera`/`gui_tree`/`local_player`/`ping`), not a general command executor — adding pixel capture there would mean opening up arbitrary client-side logic. Use `client_query name:"gui_tree"` for GUI structure meanwhile |
| `playtest_gif` | experimental | — | **unsupported** for the same reason as `ui_capture` (same client-side pixel-capture dependency); would otherwise loop client captures and encode an animated GIF Node-side |
| `playtest_control` | experimental | edit | start/stop the in-Studio sim (`mode='run'` → `RunService:Run()/Stop()`); `mode='play'` (Play Solo / players) unsupported |
| `get_playtest_output` | experimental | edit / server | drain/peek the playtest log buffer; **during an active F5 playtest, reads the live server agent's ring** (plus a `client` array when the client relay has entries) instead of the stale edit-time buffer; Run mode's `client` is always `[]` with a `"run mode has no client"` note |
| `simulate_keyboard_input` / `simulate_mouse_input` | experimental | — | `VirtualInputManager` is **RobloxScriptSecurity-restricted**; returns a clear reason when blocked |
| `character_navigation` | experimental | server | `Humanoid:MoveTo(position)`; needs a running playtest (use `context:"server"`) |
| `create_keyframe_sequence` | write | edit only | build a `KeyframeSequence` (Keyframe/Pose tree) from JSON for **manual upload** — collected in a shared folder (default `ServerStorage/GeneratedAnimations`, or under `parentPath`/`folderName`) so you can right-click → **Save to Roblox** or open it in the **Animation Editor**. One undo. Poses matched to a rig by part name at **playback** time. `registerPreview` returns a **temporary, session-only** `tempAnimationId` for in-Studio preview only (not a permanent `AnimationId`) |
| `play_animation` | write | **server only** | play an `AnimationId` on a live rig's `Animator` during an F5 playtest (`target` = rig path or `"player"`). Returns `AnimationTrack.Length`. Under `context:"edit"` returns a specific "requires a running playtest" error. Surfaces the real engine error (nil character, no Animator, asset not loaded) |
| `client_query` | read | **client (F5 play only)** | fixed read-only queries relayed from the live playtest client over `NikMCP_ClientRelay`: `fps` (RenderStepped avg), `camera` (CFrame + FOV), `gui_tree` (`maxDepth?`), `local_player` (character/HRP/Humanoid state), `ping`; unknown `name` lists the valid set; 5s timeout returns `"client agent not connected"` (Run mode, or no client yet) |
| `verify_playtest` | write | edit (drives a playtest) | composite self-correcting loop: start playtest -> optional `setupScript` -> `assertScript` (**must** return `{ passed, failures }`) -> optional `clientChecks` (`client_query` calls, play mode only; `skipped:"no client"` in run mode) -> drain server + client errors -> **always stops the playtest it started** (unless `keepRunning`), even on timeout/throw. `{ mode, setupScript?, assertScript, clientChecks?, timeoutSec?, keepRunning? }` -> `{ passed, failures, checks, serverErrors, clientErrors, durationSec, stopped }` |
| `create_sound` | write | edit | convenience wrapper over `create_instance`: a `Sound` under `parentPath` with validated props (coerced `soundId`, volume clamped 0-10, rollOff enum). One undo. `playOnCreate` previews via `:Play()` |
| `set_lighting` | write | edit | convenience over `set_properties` on `Lighting` + optional child effects (Atmosphere/Sky/Bloom/ColorCorrection/DepthOfField/SunRays, one per class). Tagged Color3/Vector3 via serializer; rejects unknown property/effect names. One undo |
| `analyze_script` | meta | Node-side (`source`) / one round-trip (`path`) | run `luau-lsp analyze` (with Roblox global type definitions) on Luau source: pass `source` (no Studio needed) **or** `path` (fetches the script's source from Studio first) — exactly one. Returns `{ ok, errors, warnings }`; the same check `write_script`/`run_luau` apply automatically |
| `luau_lint_gate` | read | edit | CI-style lint gate: reuses `analyze_script`'s exact `luau-lsp analyze` pipeline over `paths` (explicit scripts) **or** `root` (via `list_scripts`) — exactly one. `failOn:"error"` (default) fails only on blocking diagnostics, `failOn:"warning"` fails on any lint warning too. Capped at 100 scripts / 10 diagnostics per script; returns a `"LINT GATE: PASS/FAIL -- N errors, M warnings across K scripts"` verdict plus full per-script JSON |
| `playtest_smoke` | write | edit (drives a playtest) | composite: generalizes `verify_playtest` into an ordered smoke-test script — starts Run mode, optional `setupLuau` once, then each `steps[].luau` IN ORDER via `run_luau` context=`server` (falsy Luau return fails a step unless `expectTruthy:false`); the FIRST failed step aborts the rest, but the playtest is still stopped (`stopAfter`) and output still drained (`collectOutput`). `{ steps: [{ luau, description?, expectTruthy?, timeoutMs? }], setupLuau?, numPlayers?, stopAfter?, collectOutput? }` -> `{ passed, stepsPassed, stepsTotal, results, serverErrors, outputTail, durationSec, stopped }` |
| `snapshot_revert` | write | edit (`export_build`/`import_build` under the hood) | in-memory (this process only, LRU-capped at 6 labels) subtree snapshot/diff/revert. `mode:"snapshot"` (`path`+`label`) stores an `export_build`; `mode:"diff"` (`label`) re-exports and reports `addedInstances`/`removedInstances`/`changedInstances` (cap 200 entries, 20 changed props/instance); `mode:"revert"` (`label`) **DESTRUCTIVE** — deletes the current instance then reimports the stored build under its recorded parent (refuses bare top-level paths like `"Workspace"`/`"game"`; if import fails post-delete the snapshot is kept for a retry); `mode:"list"` returns stored labels + metadata |
| `multiplayer_eval` | write | server (`serverLuau`) / client (`clientQuery`) | hybrid multiplayer introspection: `serverLuau` runs arbitrary code in the F5 server context (same mechanism as `run_luau`, sees every connected peer via `Players:GetPlayers()`); `clientQuery` routes one existing `client_query` name to the F5 client, but the client relay hard-binds to a single player as an anti-forgery measure, so `allPeers:true` / `clientQuery.playerName` are honestly **rejected**, not silently ignored — no arbitrary client eval or true multi-client targeting is added |
| `rocreate_*` (9 tools) | read/write | Node + edit | password-gated reupload of YOUR OWN assets/dev-products/game-passes/animations under a per-run creator — see **RoCreate** |
| `get_status` | meta | — | `{ edit, server }` connectivity (ungated) |

`context: "auto"` (the default) targets the **running F5 server** when it's alive, else the editor.

**Context note:** every tool is implemented in the **edit** `Executor`. During a live F5 playtest,
`auto` routes to the **server** agent, which mirrors `run_luau` + the **read** tools (instance tree,
console, search/list, place info, properties, attributes, descendants, services, tags,
`search_by_property`) plus `character_navigation`, and returns a clean "agent does not support
command" error for edit-only ops (selection, script editing, undo, asset insertion, tagging) — those
are edit-time operations anyway. Pass `context: "edit"` to target the editor explicitly.

## Validation layer (task 24)

Two Node-side gates run **before** a command is enqueued to the bridge, so a rejection costs
zero Studio round-trips. Both fail **open**: if the dump or the analyzer binary is unavailable,
every tool behaves exactly as before (one stderr notice per gate per server lifetime), and MCP
stdio init **never** waits on a network fetch — loading is lazy + background, and the first
validated call waits at most ~3s before passing through.

**Gate A — API-dump reflection** (`apiValidation`, default `true`): validates against the
official Roblox `Full-API-Dump.json` (fetched for the current Studio version, mirrored fallback).

- `create_instance` / `mass_create_objects`: className must exist and be creatable
  (`NotCreatable`/`Service` rejected); property names/types checked against the actual class.
- `set_property` / `bulk_set_property` / `mass_set_property` / `set_properties`: the instance's
  **class is unknown Node-side** (only a path), so the property name must exist on *some* class
  (kills the `Trasparency` class of failure, with a did-you-mean), must be writable somewhere,
  and unambiguous primitive/enum types are checked (enum typos get a did-you-mean). Ambiguous or
  complex values pass through — **Studio's Executor stays the final authority**.

**Gate B — Luau analyze** (`luauGate`, default `true`): full Luau chunks (`run_luau` code,
`write_script` source, `verify_playtest` setup/assert scripts) are run through
`luau-lsp analyze` (pinned release, with `globalTypes.d.luau` so `game`/`task`/`Instance`
resolve). Syntax/type errors (including the leading-paren ambiguity class) reject with
`line:col Kind: message` + a source excerpt; lint warnings ride along on success as a
`luau warnings:` block. Line-fragment tools (`edit_script_lines`, `insert_script_lines`,
`find_and_replace_in_scripts`) are **not** gated — fragments are not standalone chunks and
would false-positive. `skipAnalysis: true` is the escape hatch if the pinned analyzer ever
disagrees with current Studio.

**Cache**: everything lives in `~/.nikmcp/` (machine-level, survives `npx nikmcp@latest`):
`api-dump.json` + `api-dump.meta.json`, `globalTypes.d.luau`, `.luaurc` (nonstrict default —
a `--!strict` directive in your source still wins), `bin/luau-lsp(.exe)` (auto-downloaded,
pinned release).

**Config keys** (`config.json`, see `config.example.json`):

| Key | Default | Meaning |
|-----|---------|---------|
| `apiValidation` | `true` | Gate A on/off |
| `apiDumpTtlHours` | `168` | refetch the dump when older, or when the Studio version changed |
| `luauGate` | `true` | Gate B on/off |
| `luauLspPath` | — | absolute path override for the analyzer binary (else cache `bin/`, else `PATH`, else auto-download) |

## Script sync (task 25)

`export_scripts` / `sync_status` / `import_scripts` — a drift-safe bridge between the Explorer
and a disk tree. **Edit mode only** (all three refuse while a playtest is running).

**Mapping (Rojo-compatible):** ModuleScript `Name` → `Name.luau`; Script → `Name.server.luau`;
LocalScript → `Name.client.luau`. A script with script-descendants becomes a folder holding
`init(.server|.client).luau` plus its children; non-script containers on the path become plain
folders (containers with no script descendants are not exported). Names are
filename-sanitized (`\/:*?"<>|` stripped) — the manifest (`nikmcp-sync.json`) keeps the real
DataModel path, so sanitization is display-only. Sanitization/case collisions get a stable
`__2`/`__3` suffix. Same-named sibling scripts share one DataModel path (the whole transport is
path-addressed), so only the first is exported and the rest are reported in `duplicates[]`.

**Drift protocol (never auto-resolve):** every hash is FNV-1a 32-bit over CRLF→LF-normalized
source, computed bit-identically on both sides (Luau + Node). `sync_status` classifies each
manifest entry three ways — disk vs manifest vs live Studio: `clean`, `diskAhead` (importable),
`studioAhead` (report only; re-export to accept), `CONFLICT` (both moved), plus
`missingInStudio` / `missingOnDisk` / `newOnDisk`. `import_scripts` refuses the ENTIRE import
on any conflict and returns a whitespace-normalized unified diff per conflict; `studioAhead`
and missing entries are skipped, reported, and never block. Applied files land in ONE
ChangeHistory recording — a single Ctrl+Z reverts the whole import. Every applied source runs
through the task-24 Luau analyze gate first (errors abort the import; `skipAnalysis:true`
bypasses; analyzer unavailable = fail-open with `analyzed: 0`). `dryRun:true` returns the
would-apply plan.

**v1 limits:** import updates existing scripts only — new files on disk are reported
(`newOnDisk`), never created; deleted disk files never delete instances. Creation/deletion
sync is a future task. Default export dir can be set once via `syncDir` in `config.json`
(the tool's `dir` param wins).

## RoCreate (task 26)

Password-gated auto-reupload of **your own** content — images, audio, meshes, animations, dev
products, game passes — under a per-run target creator, then rewire the place to the new IDs.
Locked behind a 4th dock tab; nothing sensitive is ever committed.

**Auth split** (see `ROCREATE_CAPABILITY_MATRIX.md` for endpoint provenance): **all uploads use the
Open Cloud key** — image, audio, animation, and mesh (animation & mesh became Open Cloud asset types in
Oct 2025; `assetdelivery` returns them already wrapped as binary `.rbxm`, exactly the `model/x-rbxm`
fileContent the Assets API wants). The **cookie** does exactly one thing the key can't — **download** the
bytes of a *restricted* existing asset ID (audio/animation/mesh); public assets download cookie-free.
Restricted downloads auto-pass `game.PlaceId` (NikMCP runs inside the place) as `Roblox-Place-Id`. The
legacy `ide/publish/UploadNewAnimation`/`UploadNewMesh` endpoints Roblox retired (410/404) are no longer
used.

**Secrets** — the API key lives in the gitignored `config.json` `rocreate.apiKey` block (env
`ROCREATE_API_KEY` overrides; falls back to `openCloud.apiKey`). The `.ROBLOSECURITY` cookie is
encrypted (**scrypt(password) → AES-256-GCM**) in `~/.nikmcp/rocreate-secrets.json` (outside the repo).
**The password is stored nowhere** — it is the decryption key, entered live at unlock; a decrypt failure
IS the wrong-password signal. The old→new map lives in `~/.nikmcp/rocreate-map.json`.

**Unlock flow** — the RoCreate dock tab sets credentials once (`POST /rocreate/set-credentials`), then
unlocks per session with the password (`POST /rocreate/unlock`); Node holds the decrypted cookie in
memory only, with a 30-min idle expiry, until you Lock (`/rocreate/lock`). All `rocreate_*` tools refuse
with "locked — unlock via the RoCreate tab" until then.

**Tools** — `rocreate_status` (booleans only; values never leave Node), `rocreate_set_credentials`,
`rocreate_scan_assets` (walk the place for asset refs + script `rbxassetid://` hits), `rocreate_reupload_assets`
(download → upload → grant restricted → record map; `dryRun` for the plan), `rocreate_apply_asset_map`
(rewire instance props in one undo + script IDs via `find_and_replace_in_scripts`), `rocreate_list_monetization`,
`rocreate_reupload_devproducts` / `rocreate_reupload_gamepasses` (bulk create in a target universe),
`rocreate_create_devproducts` (create brand-new dev products from an explicit name+price list),
`rocreate_upload_image` / `rocreate_upload_audio` / `rocreate_upload_model` (upload a **local** image / audio /
`.fbx` model file from your computer as a brand-new asset via the Open Cloud key — **key-only, no cookie/unlock
needed**; owned by a per-run `creator {type,id}`; audio & model take an optional `grantUniverseId`; image/audio
take an optional `applyTo {path,property}` to wire the new `rbxassetid://` onto an instance once Approved),
`rocreate_upload_folder` (bulk-upload every image/audio in a **local folder** in one call — perfect for a UI
export folder of PNGs; `kind:'auto'|'image'|'audio'`, `dryRun`, returns a `{file: assetId}` table),
`rocreate_grant_asset` (grant Use-permission for an existing asset id into a universe/user/group — verify-not-
trust the 200; grant-only, no revoke),
`rocreate_rewrite_monetization_module` (swap old→new IDs in a MonetizationIds ModuleScript — zeros never
touched, string/comment digits ignored, byte-preserving preview/apply/verify).

**Hard limits** (stated in every relevant tool): recreated dev products / game passes get **NEW IDs** —
existing ownership does **not** transfer (platform behavior). Asset-permission grants are **grant-only, no
API revoke**, and a 200 is verified not trusted. Only content your credentials can reach is moved —
private/unowned won't download, and that is reported, never faked. Audio has a monthly quota.

## Settings

The dock has four tabs: **Status / Settings / Activity / RoCreate**.

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
- For `capture_viewport`: **Allow Mesh / Image APIs = ON** (Game Settings → Security), and be in
  **Edit mode with the 3D viewport visible and rendering** (focused, not hidden behind a playtest or
  another tab). Capture reads the rendered screen, so playtest-view capture isn't supported — this is a
  Roblox engine limit, not a NikMCP one (boshyxd's `capture_screenshot` has the same constraint).

## Open Cloud setup

`upload_asset` / `upload_capture` publish bytes to Roblox via the **Open Cloud Assets API** —
this happens entirely Node-side (`src/open-cloud.ts`); the API key never reaches the plugin, the
bridge wire, or a log line.

1. On the [Creator Dashboard](https://creator.roblox.com) go to **Open Cloud → API Keys** and
   create a key.
2. Grant it the **Assets API** `asset:read` + `asset:write` scopes, scoped to the creator
   (your user, or a group you belong to) you'll upload as.
3. Configure the key — precedence is **`ROBLOX_API_KEY` env var > `config.json` `openCloud.apiKey`**:
   ```bash
   export ROBLOX_API_KEY=...   # or set it in config.json instead
   ```
4. Set exactly one of `openCloud.creatorUserId` / `openCloud.creatorGroupId` in `config.json`
   (whichever the key was scoped to). Copy `config.example.json` to `config.json` (gitignored —
   never commit a real key) and fill in the real values.
5. Limits: **20 MB per file**, rejected pre-flight with the actual size rather than waiting on a
   4xx. Missing key/creator → the tool returns an honest `"not configured: set ROBLOX_API_KEY (or
   openCloud.apiKey) and openCloud.creatorUserId/GroupId"` — it never fakes an upload.
6. Moderation is surfaced **verbatim**: a still-pending or rejected asset comes back with its real
   `moderationState` and `applied:false` — never claimed usable before Roblox says so.

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

**Client-context limitation (honest, updated):** client **output** is now readable in F5 **play**
mode — a `NikMCP_ClientAgent` LocalScript (injected at `playtest_control` start, play mode only,
removed on stop) hooks `LogService` and relays lines to the server agent over a
`NikMCP_ClientRelay` RemoteEvent; read them with `read_console context="client"` or
`get_playtest_output`. Fixed client introspection (`fps`, `camera`, `gui_tree`, `local_player`,
`ping`) is exposed via `client_query`, also relayed the same way. Arbitrary client-side
`run_luau context="client"` **remains impossible** — `loadstring` is server-only, and no amount of
relaying changes that; calling it returns `"not supported: loadstring is server-only; use
client_query"`. **Run mode has no client** (it never injects the LocalScript), so client reads in
Run mode return an honest empty result with a `"run mode has no client"` note, not an error.

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