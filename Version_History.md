# NikMCP Version History

Newest first. Each entry: what the version was about, every new tool, and what it does.

---

## v0.2.0 - September 3, 2026 (Token-cheap edits, harness macro, lease-aware runtime agent)

Built from a working agent's ranked pain list after a real session (RoundService re-sent in full twice for one-line fixes; a 5-call harness dance repeated seven times; import_scripts avoided for fear of clobbering the bridge agent; false CONFLICTs from a stale manifest; server attributes unreadable without loadstring; harness verdict lines evicted from the log ring; 52 KB get_script_source dumps; named buttons unclickable; 409 busy-loops after a Node restart; long edit scripts dropping the bridge; lint gate failing on analyzer noise). Tool count: 156 -> 164. Write-gated tools: 76 -> 81. Every change is offline-verified; live Studio acceptance needs the usual Studio restart plus MCP reconnect.

| Tool / area | Change |
|---|---|
| `edit_script` (new, write) | Exact-string replace (`oldString`/`newString`, must match exactly once unless `replaceAll`/`expectedMatches`) OR a unified diff via `patch` (hunks located exactly, then by offset, then whitespace-fuzzily). Reads live source, applies Node-side, luau-lsp gates the result, writes back through the hash-checked transaction (refuses if the script changed underneath), returns before/after hashes + diff. `dryRun` previews. Removes the "re-send 1,150 lines for a one-line fix" cost. |
| `write_script` | `sourceFile` reads the source from a local path (exactly one of `source`/`sourceFile`); bridge-managed NikMCP scripts are refused; previous source is backed up first. |
| `get_script_source` | `startLine`/`lineCount`/`maxBytes` windows with `totalLines`; no more token-cap dumps for large scripts. |
| Pre-write backups (new) | `write_script`, `edit_script`, `edit/insert/delete_script_lines`, `import_scripts`, `apply_script_patchset`, `restore_script_backup` snapshot the previous source into an in-memory ring (5 per path, 40 paths, 25 MB). `list_script_backups` (read) and `restore_script_backup` (write, `confirm:true`, hash-checked) make a bad write one call away from undone. |
| `run_harness` (new, write) | The whole harness dance in one call: set gate attribute in edit -> arm agent -> start run/play -> wait for agent -> optional `setupLuau` -> poll `<resultPrefix>_Done` (or `doneAttribute`) on `resultPath` -> return every `<resultPrefix>*` attribute -> drain output (filtered by `outputPattern`, plus pinned lines) -> stop -> restore the gate attribute. Per-phase timings, server errors, pass/incomplete verdict. |
| `server_query` (new, read) | Read-only introspection of the live playtest server without loadstring: attributes, attribute, attributes_prefix, properties, tree, children, descendants, tagged, tags, players, place, runtime_status, search. Works when `LoadStringEnabled` is off. |
| `get_playtest_output` | Node-side `pattern` (regex), `ignoreCase`, `levelFilter`, `sinceMarker`, `limit`; runtime ring 500 -> 2000 lines, client ring 500 -> 1500, edit ring 1000 -> 3000. New pinned ring (500): `playtest_control start { pinPattern }` / `run_harness` stamp `McpPinPattern` on the agent and every matching line is kept in `pinned`, immune to noise eviction. |
| `client_activate` (new, write) | Fire a named GuiButton by PlayerGui path: `click` (official VirtualInput at the live center), `gamepad` (GuiService.SelectedObject + ButtonA), or `auto`. Reports whether `GuiButton.Activated` actually fired, before/after state, optional `expect` assertion. Ends the "button -> remote -> countdown" human-only QA gap. |
| `import_scripts` | `paths` allowlist (conflicts outside the list no longer abort), `force` (with `paths`) overwrites studioAhead/conflict entries with disk, still hash-checked at write time. `MCP_RuntimeAgent`, `NikMCP_ClientAgent`, `__MCP_*` are protected: never exported, never imported. Applied paths are backed up first. |
| `export_scripts` | `paths` exports only the named scripts and merges into the existing manifest (single-file pull from Studio). Protected scripts skipped and reported. |
| `sync_status` | A CONFLICT whose two sides differ only by whitespace (CRLF, tabs, trailing spaces/newlines) is reported clean with `whitespaceEqual`; `staleManifest` lists clean entries whose baseline is behind, with a hint. |
| `reconcile_manifest` (new, write) | Rebase manifest baselines without touching content: `accept:'equal'` (default, only convergent rows), `'studio'`, `'disk'`; optional `paths`; `dryRun`. Replaces the "export everything again" workaround. |
| `run_luau` | `timeoutMs` up to 10 min and `async:true` returning a `jobId`; `get_luau_job` (new, read) polls/lists jobs. |
| Edit poller (plugin) | Commands execute in their own task; the poll loop keeps polling with `busy=1` (liveness only, no second dequeue) so a long-yielding `run_luau` / build no longer drops the bridge. Runtime agent does the same. |
| Runtime agent port/lease (plugin) | `/heartbeat?targetId=` is lease-aware (`accepts`, `exact`, `leasedTargetId`, `tokenOk`). The agent picks the bridge that already holds its window's lease, else the first accepting one, never a bridge leased to another live window or rejecting its token. HTTP 409/401/400 on poll parks that port for 30 s and re-resolves instead of busy-looping. Backoff cap 5 -> 8 s. |
| `get_playtest_status` / `get_status` | `phase`: `stopped` / `starting` (launched, agent not attached yet, with hint) / `running`. `playState` mirrors it. |
| `luau_lint_gate` | Demoted analyzer noise (`Unknown require`, closed-class key lookups) is now INFO, not a warning: `failOn:'warning'` passes on it; `ignoreInfo:false` restores the old strictness. `analyzeLuau` gained `infos`. |
| Multi-lane runtime agent (plugin) | One F5 agent now serves SEVERAL bridges at once: the edit plugin stamps `McpAgentPorts` (every connected port minus the ones toggled off in the dock, persisted per user) and the runtime agent opens one poll lane per port, each with its own resolve/backoff/park state, busy flag, poll counter and output cursor (two sessions draining the same playtest each see every line once). Empty list = legacy single auto-resolved lane. Dock: new AGENT row in the Bridge card with one chip per connected port (accent = served, green = live, grey = off; click to toggle), and the Playtest agent row reads `live xN`. `get_runtime_status` reports `bridgePort`, `agentPorts`, `agentLanes`. Toggles take effect on the next playtest. |
| Dock makeover (plugin) | `StatusWidget.luau` rebuilt on the same API: fixed brand bar (gradient logo mark, `NikMCP` title, `version 0.2.0` badge, pulsing status pill with an expanding ring), segmented tab strip with a sliding indicator, card-based Status view (Bridge card = address chip + port lane, Connect CTA with glow ring, Health card with state words per row and the arm switch, session stats footer: version / tool count / commands / last latency), Settings grouped into one card per tool group with count badges and accent switches, Activity cards with outcome rail, latency chip, live count badge, entrance animation and an empty state, RoCreate split into Unlock / Credentials / API key cards with a lock pill. BuilderSans fonts with Gotham fallbacks looked up defensively. |
| Tests | `selftest:script-edit` (17 cases), `selftest:v020` / `selftest:v020-static` (registration, settings, gates, poller/agent markers, MCP stdio guards), sync-unit rebase/protected cases, luau-gate info classification. |

---

## v0.1.9 - July 25, 2026 (Agent reliability and 2026 Studio automation)

Adds nine high-leverage tools that reduce agent round trips, make multi-script edits recoverable, and use Roblox's current testing and profiling APIs instead of restricted legacy input stubs. Tool count: 147 -> 156. Write-gated tools: 74 -> 76.

| Tool / area | Change |
|---|---|
| `task_context_bundle` | Ranks task-relevant live scripts with bounded excerpts, hashes, require neighbors, remote peers, DataStore peers, and explicit reasons. |
| `change_impact_report` | Traces direct/transitive dependencies and dependents, contracts, literal references, cycles, and a bounded pre-edit risk score. |
| `code_health_report` | Deterministic capped scan for deprecated globals, numeric requires, dynamic environment access, risky persistence/remotes, TODOs, large scripts, and exact duplicates. |
| `plan_script_patchset` | Applies exact literal/line/full-source operations in memory, compile-gates every result, and issues a 10-minute one-use token bound to the selected Studio target. |
| `apply_script_patchset` | Requires confirmation, rechecks each hash inside `UpdateSourceAsync`, verifies every result, and conditionally restores every touched original on failure without overwriting concurrent edits. Roblox does not add script source writes to Studio undo history. |
| `wait_for_state` | Bounded declarative polling for instance, property, attribute, player-count, runtime, console, and live PlayerGui conditions with stability samples and observations. |
| `client_input_sequence` | Official `UserInputService:CreateVirtualInput()` flow runner for key, move, click, text, wheel/pan/pinch, wait, and PlayerGui assertion steps with cleanup and per-step evidence. |
| `scene_analysis_snapshot` | Server/client/both `SceneAnalysisService` capture for composition, script memory, unparented instances, triangles/draw calls, animation memory, and audio memory with hard output caps. |
| `capture_script_profile` | Bounded server/client `ScriptProfilerService` capture, deserialization, capped results, and guaranteed stop/listener cleanup. |
| Compatibility | `simulate_keyboard_input` now uses the official client input path. Mouse move uses the same path; unsafe isolated mouse down/up remains refused in favor of bounded click cleanup. |
| Script import safety | `import_scripts` now uses the same callback-time source hash checks and verified rollback transaction; removed the false claim that Roblox records script source writes in Studio undo history. |
| Architecture | Added isolated `AgentTools.luau`, source-analysis and patch-plan Node modules, MCP tool annotations, settings/dispatch/build parity, runtime source versioning, and focused tests. Cross-port routing now requires a private local capability; queued commands are target-bound, expire in Studio, and are removed on timeout. |
| Analysis correctness | Paths remain exact-case, hashes use the shared UTF-8 FNV implementation, unresolved requires are excluded from exact edges, and truncation/failure metadata prevents false low-risk impact reports. |

---

## v0.1.8 - July 25, 2026 (QA, guarded assets, environment tooling, and runtime hardening)

Fixes the highest-friction MCP workflow issues seen on July 7, 2026.

| Area | Change |
|---|---|
| Runtime attach | `verify_playtest` and `playtest_smoke` now arm `enable_playtest_agent` before launching F5 and fail with a canonical status bundle if the runtime agent still does not connect. |
| Runtime port alignment | Runtime agent injection now stamps the command's live bridge as `McpPort`, passes the full candidate port range as `McpPortCandidates`, refreshes stale existing agents, and the runtime agent probes 58741-58760 instead of only 58741-58743. Fixes auto-walk ports such as 58747. |
| Settled stop | `playtest_control action="stop"` and new `stop_playtest` wait for edit mode, stopped RunService, disconnected server/client agents, and no active runtime session id. Timeout returns detailed status + attempts; `retries` and `force` provide retry/force-stop paths. |
| Status | `get_status` and `get_playtest_status` now report bridge port, edit plugin, F5 server agent, F5 client agent, player count, active place, raw status, and recent runtime diag events. |
| Client UI checks | `client_query` gained `gui_object` for read-only PlayerGui object state/layout inspection during Play Solo. |
| Backups | New `prompt_save_selection` tool opens Studio's native Save Selection dialog, optionally selecting passed paths first, for RBXM/RBXMX backups. |
| Regression guard | Added `npm run selftest:runtime`, a live Studio guard that starts Run mode, requires runtime server attach, executes a server Luau assertion, and verifies settled stop. |
| Studio target safety | Added `get_studio_targets` and `select_studio_target`. Every edit/runtime poll carries a stable per-window target id; each bridge leases itself to one live Studio target; explicit selection is identity-pinned and cross-port calls fail closed on PID/session drift. |
| Blender chunk assembly | Added `assemble_imported_chunks` with `dryRun:true` default, disk/inline manifest support, reference-chunk Y reconstruction, X/Z preservation, pivot/delta attributes, optional named backup, anchoring, bounds/drift/error metrics, missing chunks, and warnings. |
| Environment QA | Added read-only `audit_environment` and `inspect_texture_health` for spatial overlap/support/anchoring/scale/bounds/mesh/material dependency findings. Triangle counts use an opt-in capped EditableMesh deep scan because MeshPart has no official TriangleCount property. Invalid Blender UVs remain a Blender-side repair. |
| Recoverable backups | Added `backup_selection` and `restore_backup` under `ServerStorage.NikMCPBackups`; backups preserve full cloneable trees and never overwrite without `replace:true`; restore requires `confirm:true`, is name-scoped, collision-safe, and retains the backup. |
| Engine-truth teardown | Added `get_settled_runtime_status` and `stop_playtest_settled` with explicit RunService/edit-mode/server-agent/client-agent/stale-session settlement states. `/heartbeat` is now observation-only and cannot manufacture liveness. |
| Targeted tests | Added `npm run selftest:targets` and `npm run selftest:environment` for wrong-window identity drift, cross-port routing, malformed selection/input, missing/malformed manifests, registration/settings/dispatch parity, backup collision guards, UV honesty, and stop-timeout diagnostics. |
| Creator Store scout | Replaced the `search_assets` placeholder with official Creator Store search/details support: type, verified/creator filters, ratings/relevance sorts, pagination, and bounded results. |
| Guarded asset insertion | Added `inspect_creator_store_asset` and `guarded_insert_asset`. Inspection loads unparented, scans hierarchy/source/remotes/risk signatures, and issues a one-time asset/target/fingerprint grant. Insert reloads/rescans, refuses drift, uses a strict target allowlist, quarantines scripts/remotes, and post-scans the inserted roots. |
| True multi-client QA | Added `run_multi_client_qa` on `StudioTestService:ExecuteMultiplayerTestAsync` for 1-8 clients, serializable test args, player waits/add/leave, checkpoints, server assertions, bounded teardown, structured results, and settled cleanup. |
| Runtime UI regression | Added `runtime_ui_regression` with StudioDeviceSimulatorService sweeps for phone portrait/landscape, tablet, and desktop. It inspects live PlayerGui state for clipping, offscreen layout, overlap, touch targets, safe areas, fixed Offset sizing, and constraints. Screenshot support remains honestly unavailable. |
| Unified world health | Added read-only `world_health_report`, normalized across the existing environment and texture scanners. It adds current engine asset-fetch failure state and invisible collision findings and never auto-anchors gameplay geometry. |
| Expansion tests | Added `selftest:creator-store`, `selftest:qa`, and `selftest:qa-luau` for request/allowlist/token contracts, settings/dispatch/MCP parity, true multiplayer/device/UI evidence markers, and compile gates for every new/changed Luau module and embedded runtime/client source. |
| Stdio lifecycle cleanup | Node now closes the HTTP bridge and exits when its MCP stdin reaches EOF/closes, preventing contract tests and desktop clients from leaving orphaned NikMCP bridge processes. |

---

## v0.1.7 — July 6, 2026 (19 new tools — "Eyes, Brain, Style, QoL")

Biggest single expansion yet. Four themed buckets giving the AI agent vision in Studio, one-call project understanding, art-direction awareness, and self-verification workflow tools. Tool count 112 -> 131.

### Bucket 1 — Eyes in Studio
| Tool | What it does |
|---|---|
| `orbit_capture` | Frames any instance by its bounding box and screenshots it from multiple angles (front/back/left/right/top/iso) in one call. Camera restored after. |
| `selection_capture` | Screenshot with colored Highlight overlays on chosen instances + a color legend, so pixels map back to the instance tree. |
| `visual_diff` | Save a named "before" screenshot, later re-capture from the exact same camera and get before/after images + pixel-change stats. Verifies edits visually. |
| `ui_capture` | Registered but unsupported: GUI pixel capture needs the F5 client, whose agent is a locked query whitelist by design. Clear error explains alternatives. |
| `playtest_gif` | Registered but unsupported (same client limitation). Schema ready for the future. |

### Bucket 2 — Project understanding
| Tool | What it does |
|---|---|
| `place_digest` | One call = full cold-start onboarding: services, script counts, remotes, DataStores, monetization sites, tags, workspace stats. |
| `remote_inventory` | Every RemoteEvent/Function/Bindable with where it's fired/connected in code, plus unused-remote flags. |
| `datastore_inventory` | Every DataStore/MemoryStore: store names, scopes, which scripts declare them, every Get/Set/Update call site. |
| `require_graph` | ModuleScript dependency graph from require() calls, resolved against the live DataModel, with cycle detection and top-required modules. |
| `monetization_map` | Scans code for purchase prompts + product/gamepass IDs and cross-references against live Open Cloud products (wired vs orphan IDs). |

### Bucket 3 — Style / art direction (all-new capability)
| Tool | What it does |
|---|---|
| `ui_style_fingerprint` | Reads the game's actual UI: fonts, corner radii, strokes, gradients, color palette, shadows, Scale-vs-Offset hygiene -> style class + reusable token set. |
| `world_style_probe` | World art profile: dominant part colors, material character (neon/plastic/studs via MaterialVariants), mesh-vs-part ratio, "juice" signals (particles, lights). |
| `lighting_profile` | Full Lighting + post-effects readout (Atmosphere, Bloom, ColorCorrection, etc.) classified into a mood label (bright-bubbly, dark-moody, ...). |
| `ui_layout_probe` | Pure-math UI layout solver at phone/tablet/desktop resolutions — flags offscreen elements, overlaps, too-small touch targets, tiny text. No playtest needed. |
| `art_direction_report` | Flagship: wraps the three probes into one natural-language art brief with DO/DONT bullets + UI tokens. Feed it to any agent before building UI so new work matches the game. |

### Bucket 4 — QoL / workflow
| Tool | What it does |
|---|---|
| `luau_lint_gate` | Lints a set of scripts (or everything under a root) via luau-lsp and returns a single PASS/FAIL verdict. Automates the compile-gate rule. |
| `playtest_smoke` | Scripted multi-step F5 smoke test: setup + ordered Luau assert steps in the server context, per-step results, auto stop + output drain. |
| `snapshot_revert` | Snapshot a subtree, diff it against current state later, or one-click revert to the snapshot. Safety net for risky edits. Refuses service-level reverts. |
| `multiplayer_eval` | Arbitrary Luau eval in the F5 server + whitelist queries against the connected client. Per-peer client eval is architecturally blocked (anti-forgery) and rejected honestly. |

Also: `capture_viewport` internals refactored into shared capture core; `analyze_script` refactored into shared lint helpers; full change set passed an adversarial review (verdict: SHIP).

---

## v0.1.6 — July 5, 2026 (RoCreate Tier-1 local uploads)

Publish brand-new assets straight from local disk via the Open Cloud key path — no cookie needed for net-new uploads. Serves the Figma -> Roblox UI export pipeline. RoCreate tools 10 -> 15.

| Tool | What it does |
|---|---|
| `rocreate_upload_image` | Upload a local image file (png/jpg/bmp/tga) as a new Roblox image asset under a chosen creator. |
| `rocreate_upload_audio` | Upload a local audio file (mp3/ogg) as a new audio asset, with optional universe Use-permission grant. |
| `rocreate_upload_model` | Upload a local .fbx as a new Model asset. |
| `rocreate_upload_folder` | Bulk: upload every image/audio in a local folder in one call -> {file: assetId} map. dryRun supported. |
| `rocreate_grant_asset` | Standalone Use-permission grant of an existing assetId into a universe/user/group (verify-not-trust). |

Also: RoCreate API key can now be saved from the plugin dock (Save API key field -> gitignored config.json).

---

## v0.1.5 — July 3-4, 2026 (RoCreate suite — password-gated reupload + monetization)

The full RoCreate system landed: migrate a place's assets and monetization to your own account/group, gated behind an encrypted password unlock. Live-proven end-to-end (image, animation reupload, dev products).

| Tool | What it does |
|---|---|
| `rocreate_status` | Locked/unlocked state, key presence, map summary. |
| `rocreate_set_credentials` | Store cookie + API key encrypted (scrypt + AES-256-GCM); unlock/lock from the dock. |
| `rocreate_scan_assets` | Scan the open place for asset IDs (sounds, meshes, textures, animations, images). |
| `rocreate_reupload_assets` | Download scanned assets and republish them under your creator via Open Cloud; builds an old->new ID map with re-run dedup. |
| `rocreate_apply_asset_map` | Rewrite the place's scripts/properties to the new asset IDs from the map. |
| `rocreate_list_monetization` | List a universe's dev products + gamepasses via Open Cloud. |
| `rocreate_reupload_devproducts` | Clone a source universe's dev-product catalog into yours. |
| `rocreate_create_devproducts` | Create N brand-new dev products from name+price pairs (no source universe needed). |
| `rocreate_reupload_gamepasses` | Clone gamepasses into your universe. |
| `rocreate_rewrite_monetization_module` | Byte-preserving rewrite of a monetization module's ID table to the new product IDs (preview/apply/verify). |

Fixes in this line: animation + mesh reupload moved to Open Cloud (legacy endpoints retired), live price shape fix, credential-contract hardening. Plugin dock gained the RoCreate tab.

---

## v0.1.3 / v0.1.4 — (tasks 23-25: client agent, Open Cloud uploads, script sync)

(0.1.4 was never stamped — dock version drifted; both eras folded here.)

| Tool | What it does |
|---|---|
| `client_query` | Fixed read-only queries against the running F5 client: fps, camera, gui_tree, local_player, ping. First client-side visibility. |
| `upload_asset` | Publish an asset via Open Cloud from Studio data. |
| `upload_capture` | Screenshot the viewport and upload it as an image asset in one step. |
| `export_scripts` | Export all Studio scripts to disk in a Rojo-style folder layout. |
| `import_scripts` | Import edited scripts from disk back into Studio, drift-safe (conflicts abort). |
| `sync_status` | Report disk vs Studio drift per script (ahead/behind/conflict). |

Also: F5 client runtime agent injected at playtest, Node-side argument validation layer, luau-lsp lint gate on script writes.

---

## v0.1.2 — (tasks 20-22: animation, sound, lighting)

| Tool | What it does |
|---|---|
| `create_keyframe_sequence` | Build a KeyframeSequence (animation) from posed keyframe data. |
| `play_animation` | Load and play an animation on a rig for preview. |
| `create_sound` | Create a configured Sound instance in one call. |
| `set_lighting` | Write Lighting properties + post effects (Atmosphere, Bloom, ColorCorrection, DepthOfField, SunRays). |

Open Cloud upload work was shelved to a feature branch at this version (landed later in 0.1.3).

---

## v0.1.1 — (capture pipeline fix + dock polish)

No new tools. `capture_viewport` made reliable: chunked HTTP send for large images + PNG encoding moved to Node (Luau encode stalled the poll loop). Dock: no-popup startup, Nik Studios rename, serif version label.

---

## v0.1.0 — Initial release

Dual-context architecture: Node MCP server (stdio) + local HTTP bridge polled by a Studio edit plugin and an F5 runtime agent. Drop-in superset of boshyxd's robloxstudio-mcp. ~90 tools at launch, by category:

- **Read/inspect**: instance tree, selection, properties, attributes, tags, descendants, class info, services, place info, project structure, file tree, script sources, script listing, grep across scripts, search by name/class/tag/property, console output, perf stats, bounding boxes, camera read, raycast, distance measure, instance compare.
- **Edit/write**: create/delete/clone/rename/move/reparent instances, single + bulk + mass property writes, attributes, tags, selection set, grouping, undo/redo, smart/mass duplication, mass object creation.
- **Script editing**: full-source write, line-range insert/edit/delete, cross-script find/replace, `run_luau` arbitrary execution (edit + F5 server).
- **Build/scene**: export/create/import/generate build subtrees, scene import, UI tree creation.
- **Playtest**: enable runtime agent, start/stop playtests, status, output drain, composite verify_playtest, character navigation.
- **Assets**: insert from Creator Store, asset details/thumbnails/preview, material catalog search.
- **Camera/visual**: `capture_viewport` screenshot, set camera, focus instance, set lighting basics.

Plugin dock with per-tool toggles, read/write gating, and status panel.
