# NikMCP Version History

Newest first. Each entry: what the version was about, every new tool, and what it does.

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
