# RoCreate capability matrix (Task 26, Phase 0 deliverable)

Resolved from real sources on 2026-07-03: RoCreate at `C:\Users\niksn\Projects\rocreate` (the
key-only create/upload engine), kartFr `Asset-Reuploader` v1.5.0 (the from-existing-ID extractor),
and live endpoint probes. **No feature code written yet — this is the approval gate.**

TL;DR of the split: **everything that CREATES uses the Open Cloud API key. The cookie's only job is
pulling bytes out of an existing asset ID (download) and the one upload Open Cloud refuses — animation
reupload.** NikMCP already ships the entire key-side upload engine (`src/open-cloud.ts` + Task 23
`upload_asset`), so Phase 2 REUSES it rather than re-porting `assetUpload.ts`.

---

## Auth / capability matrix (verified)

| Operation | Auth | Endpoint (verified live) | Port from |
|---|---|---|---|
| Upload image/audio/mesh (new bytes) | **API key** `assets:read+write` | `POST apis.roblox.com/assets/v1/assets` (multipart, then poll `/assets/v1/operations/{id}`) | RoCreate `assetUpload.ts` — **already in NikMCP `open-cloud.ts`/`upload_asset`** |
| Grant asset permission (audio/anim/video restricted) | **API key** `asset-permissions:write` | `PATCH apis.roblox.com/asset-permissions-api/v1/assets/permissions` | RoCreate `assetPermissions.ts` (NEW to NikMCP) |
| Create dev product | **API key** | `POST apis.roblox.com/developer-products/v2/universes/{universeId}/developer-products` (multipart) | RoCreate `developer-products/route.ts` |
| List dev products | **API key** | `GET .../developer-products/v2/universes/{universeId}/developer-products/creator?pageSize=50&pageToken=` | same |
| Create game pass | **API key** | `POST apis.roblox.com/game-passes/v1/universes/{universeId}/game-passes` (multipart) | RoCreate `game-passes/route.ts` |
| List game passes | **API key** | `GET .../game-passes/v1/universes/{universeId}/game-passes/creator?pageSize=50&pageToken=` | same |
| **Download bytes of an existing image/audio/mesh/anim ID** | **cookie** (+ place header) | `POST assetdelivery.roblox.com/v2/assets/batch` → CDN `location` → authed `GET` | kartFr `assetdelivery/batch.go` |
| **Reupload an animation from its bytes** | **cookie + CSRF** | `POST www.roblox.com/ide/publish/UploadNewAnimation` (raw KeyframeSequence body) | kartFr `ide/upload_animation.go` |
| **Reupload a mesh from its bytes** | **cookie + CSRF** | `POST data.roblox.com/ide/publish/UploadNewMesh` (raw mesh body) | kartFr `ide/upload_mesh.go` |
| Extract a KeyframeSequence from a live ID in-Studio (alt path) | **plugin, no cookie** | `KeyframeSequenceProvider:GetKeyframeSequenceAsync(id)` (security **None**) | NikMCP Task 20 in reverse |

Live probe results (bogus/no key → 401, not 404 = path exists): all six OC endpoints returned **401**;
`assetdelivery.roblox.com/v2/assetId/{id}` returns **200 + signed CDN location for PUBLIC assets with no
cookie** (restricted needs the cookie+batch path below).

---

## The three unknowns — RESOLVED

### Unknown A — download bytes from an existing asset ID
Two authenticated steps, cookie only, **no CSRF**:
1. `POST https://assetdelivery.roblox.com/v2/assets/batch`
   - headers: `User-Agent: RobloxStudio/WinInet`, `Content-Type: application/json`,
     `Roblox-Place-Id: <placeId>`, cookie `.ROBLOSECURITY`.
   - body: JSON array (≤50) of `{ assetId: <id>, requestId: "0" }`.
   - response: `[{ locations: [{ location: "<cdn url>" }], errors?: [...] }]`. Auth-gate signal to watch:
     `errors[0].message == "Authentication required to access Asset."` → cookie stale/unauthorized.
2. plain authed `GET <location>` → raw serialized asset bytes (KeyframeSequence binary / mesh binary /
   audio bytes). These bytes feed the reupload directly.

**Public-asset shortcut** (my own probe, not kartFr): `GET assetdelivery.roblox.com/v2/assetId/{id}` returns
a `location` with **no cookie** for public/owned assets. NikMCP can try this first and fall back to the
cookie batch for restricted IDs — saves the cookie for when it is truly needed. Report, never fake, when a
private/unowned asset won't download.

kartFr has **no image/decal/texture download-reupload path at all** — only Animation, Mesh, Sound. Images
route through the CDN download + **OC key** create-asset (Image), which NikMCP already does.

### Unknown B — animation upload — **(b) legacy web endpoint, NOT Open Cloud**
Decisive: Open Cloud **cannot** reupload an animation from an existing ID. RoCreate only uploads a `.rbxm`
the user hands it (`assetUploadValidation.ts` maps `.rbxm`→`model/x-rbxm`), and Luau cannot emit `.rbxm`
bytes at runtime. kartFr uses the legacy path:
- `POST https://www.roblox.com/ide/publish/UploadNewAnimation?assetTypeName=Animation&name=<enc>&description=<enc>[&groupId=<id>]`
- headers: `User-Agent: RobloxStudio/WinInet`, `x-csrf-token: <token>`, cookie `.ROBLOSECURITY`. No explicit
  `Content-Type` (kartFr leaves it default — flag: Roblox's exact requirement here is **unconfirmed**).
- body: the **raw serialized KeyframeSequence binary** — the exact bytes from Unknown A step 2. Not multipart,
  not base64, not JSON.
- response: `200` → body is the new asset ID as a plain integer string. Error bodies: `"NotLoggedIn"` (403),
  `"XSRF Token Validation Failed"` (403 → read fresh `x-csrf-token` from response header, retry),
  `"Inappropriate name or description."` (422 → kartFr retries with name `"[Censored]"`).
- `groupId` query param only when the target creator is a group.

**Architectural consequence for NikMCP:** the cleanest animation path is **entirely Node + cookie** — download
the KeyframeSequence bytes (Unknown A), POST them to `UploadNewAnimation` (Unknown B). No plugin serialization
needed. kartFr's own plugin never serializes the sequence; the Go server moves the raw bytes. The in-Studio
`GetKeyframeSequenceAsync` reverse-serialize (Task 20) is the **alternative** path, used only when rebuilding a
sequence or when the source is a live KeyframeSequence with no downloadable ID (then Task 20
`create_keyframe_sequence` provides the JSON→instance direction).

Mesh reupload is analogous: `POST https://data.roblox.com/ide/publish/UploadNewMesh?assetTypeName=Mesh&name=...`
(+`groupId`), same cookie+CSRF, raw bytes. Audio reupload can go **either** OC key create-asset (Audio — RoCreate
proves this works) **or** legacy `POST https://publish.roblox.com/v1/audio` (JSON, base64 `file`, cookie+CSRF).
NikMCP prefers the OC key path for audio (no cookie needed for the upload; cookie only for the download).

### Unknown C — place association — CONFIRMED, and auto-satisfied by NikMCP
kartFr CHANGELOG 1.4.1 (2025-09-15): animation download now REQUIRES a place ID. It is applied as the
`Roblox-Place-Id` **header on the assetdelivery download batch** (Unknown A step 1) — **not** on the upload,
not a query param. Permission is universe-based but the API takes any one place from that universe.

**NikMCP runs inside the open place, so it knows its own `game.PlaceId`** (read it via the executor). That
place ID is passed as `Roblox-Place-Id` on the download batch — **Unknown C is satisfied automatically for
assets in the current universe.** For an asset owned in a *different* universe, NikMCP needs a place ID from
that universe (kartFr resolves creator→games via `games.roblox.com/v2/users/{id}/games` /
`/v2/groups/{id}/gamesV2`, or a user-supplied place-list). v1: default to the current place; accept an optional
`placeId` override for cross-universe sources; report honestly when a source won't download without one.

---

## Hard limits (must live in tool descriptions, never buried)
- Recreated dev products / game passes get **NEW IDs**; existing player ownership does **not** transfer. Platform behavior, not fixable.
- Asset-permission API is **grant-only — no revoke via API** (revoke is Creator-Dashboard-only). Once granted, permanent by API.
- A missing `asset-permissions:write` scope can return **200 without applying the grant** — **verify the grant, do not trust the 200** (RoCreate note; verify by re-checking or by a follow-up read where possible).
- This pipeline moves **your own** content. Credentials that can't reach an asset won't download it — that is the correct outcome; report it, never fake success.
- Audio quota: ~100/mo verified, ~10/mo unverified accounts. Surface it; stop gracefully; per-item honest failure.
- Deprecations: legacy pass/product endpoints deprecated 2026-04-23 → we use the NEW OC endpoints above (verified 401-live). May-2026 cross-game-sales change does **not** block creating in your OWN universe.
- Legacy `UploadNewAnimation`/`UploadNewMesh` are unofficial web endpoints kartFr tracks per-release; they can move. Pin behavior to kartFr v1.5.0 (2026-02-13) and treat a shape change as "endpoint moved — re-check kartFr", not a crash.

---

## Reusable NikMCP surface (do NOT re-port)
- **Asset upload (key side):** `src/open-cloud.ts` (`buildAssetRequest`, `preflightSize`, `redactKey`) + Task 23 `uploadAsset` + `upload_asset` tool = RoCreate `assetUpload.ts` equivalent, already live. Phase 2 wraps it.
- **Bridge shared-secret auth:** already exists — `checkAuth(x-mcp-token)` in `src/settings.ts`, enforced in `src/bridge.ts` (`authed()` on `/poll`,`/response`,`/settings`). Currently TOFU/optional; Phase 1 makes it **mandatory** (generate on first run, store in gitignored `config.json`, plugin sends the header). Mechanism is built; only the "always required" flip + generation are new.
- **Chunked transport, ChangeHistory recording, `find_and_replace_in_scripts` (Task 25), `create_keyframe_sequence` (Task 20):** all reused as-is for apply/rewrite/rebuild.

## Deviations from RoCreate (intentional, for NikMCP's context)
- **Encryption key derivation.** RoCreate `crypto.ts` uses an **env** key `ROCREATE_ENC_KEY` (AES-256-GCM,
  `iv|tag|ciphertext` base64). NikMCP has no server env and wants password-gated unlock, so it follows the
  **task spec**: `key = scrypt(password, salt, 32)`, `aes-256-gcm`, store `{salt, iv, tag, ciphertext}`. A
  **decrypt failure IS the wrong-password signal** — no password hash stored anywhere, so the password lives
  only in the operator's head and the share is out-of-band. The AES-256-GCM envelope itself is ported verbatim.
- **Persistence.** RoCreate uses Prisma/Postgres; NikMCP persists to JSON under `~/.nikmcp/`
  (`rocreate-secrets.json`, `rocreate-map.json`), atomic tmp+rename, **outside the repo** (same reason the Task
  24 dump cache lives there — cannot leak via git).
- **Module rewriter** (`monetizationModuleRewrite.ts`): ported **verbatim in behavior** — mask string/comment
  regions, match `=<digits>` value-position only, whole-integer, zeros never touched, byte-preserving,
  preview/apply/verify. It is the safest single file in RoCreate and needs no change.

---

## Resolved by Nik (2026-07-03) — Phase 0 approved, Phases 1-5 built
1. **Target creator = PER RUN.** `creator: { type:"user"|"group", id }` is a required arg on create/upload tools; nothing creator-specific is stored. The secrets file's optional `targetCreator` is honored as a default if present but never required.
2. **Key in `config.json` `rocreate.apiKey`** (env `ROCREATE_API_KEY` > `rocreate.apiKey` > `openCloud.apiKey` fallback). Cookie is encrypted in `~/.nikmcp/rocreate-secrets.json`.
3. **Own creds each.** No architectural change — the secrets file is already per-machine/per-operator; each dev runs their own encrypted secrets file, their own password protects their own cookie. No secret sharing required.

Phase 0 approved. Node-side Phases 1-3 + 5 built and offline-verified; Phase 4 dock tab written (live-verified after a Studio restart). Live acceptance (unlock flow, real reupload, apply/undo, playtest refusal) is the remaining step.
