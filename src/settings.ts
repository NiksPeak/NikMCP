// In-memory tool gating + flags. The Studio plugin is the source of truth and
// POSTs the full settings to /settings on connect and on every change; the
// server enforces them so a disabled tool can't run even if a client calls it.
// Like queue.ts, this is process-wide module state.

export interface AuthSettings {
  enabled: boolean;
  token: string;
}

export interface Settings {
  tools: Record<string, boolean>;
  readOnly: boolean;
  confirmDestructive: boolean;
  auth: AuthSettings;
  soundEnabled: boolean;
  activityLog: boolean;
}

// Write = anything that mutates the place. read-only mode blocks exactly these.
// run_luau/enable_playtest_agent are included because they CAN mutate (the
// task's definition is "anything that mutates"); read tools stay available.
export const WRITE_TOOLS = new Set<string>([
  "run_luau",
  "set_property",
  "write_script",
  "set_selection",
  "create_instance",
  "delete_instance",
  "clone_instance",
  "rename_instance",
  "set_parent",
  "move_instance",
  "bulk_set_property",
  "tag_instance",
  "untag_instance",
  "insert_asset",
  "enable_playtest_agent",
  "playtest_control",
  // batch 2
  "set_attribute",
  "set_attributes",
  "delete_attribute",
  // batch 3 (script editing)
  "edit_script_lines",
  "insert_script_lines",
  "delete_script_lines",
  "find_and_replace_in_scripts",
  // batch 4 (undo/redo + mass ops)
  "undo",
  "redo",
  "mass_create_objects",
  "mass_duplicate",
  "smart_duplicate",
  "mass_set_property",
  // batch 5 (only set_properties mutates)
  "set_properties",
  // batch 6 (only upload_decal mutates externally; unsupported)
  "upload_decal",
  // batch 7 (input simulation)
  "simulate_keyboard_input",
  "simulate_mouse_input",
  "character_navigation",
  // task 16 batch A (build/scene writes; export/create_build/search_files are reads)
  "import_build",
  "generate_build",
  "import_scene",
  "create_ui_tree",
  // task 20 (animation build)
  "create_keyframe_sequence",
  // task 22 (animation playback + sound/lighting wrappers)
  "play_animation",
  "create_sound",
  "set_lighting",
  // task 16 batch B (set_camera is view-only and intentionally NOT a write tool;
  // raycast/bounds/camera-read/perf/measure are reads)
  "focus_instance",
  "group_instances",
  "ungroup_instance",
  "align_instances",
  // task 23 (verify_playtest starts/stops playtests + runs code; upload_asset/
  // upload_capture publish to Roblox via Open Cloud -- client_query is a read)
  "verify_playtest",
  "upload_asset",
  "upload_capture",
  // task 25 (import mutates scripts; export_scripts/sync_status are reads)
  "import_scripts",
  // task 26 RoCreate (mutating/sensitive; scan/status/list are reads)
  "rocreate_set_credentials",
  "rocreate_reupload_assets",
  "rocreate_apply_asset_map",
  "rocreate_reupload_devproducts",
  "rocreate_reupload_gamepasses",
  "rocreate_rewrite_monetization_module",
]);

const DEFAULTS: Settings = {
  tools: {}, // empty == all enabled (isToolEnabled defaults missing -> true)
  readOnly: false,
  confirmDestructive: false,
  auth: { enabled: false, token: "" },
  soundEnabled: true,
  activityLog: true,
};

let current: Settings = structuredClone(DEFAULTS);

// TOFU (trust-on-first-use) auth: once the plugin sends auth.enabled with a
// token, the server adopts it and then rejects requests missing/!= it. This is
// belt-and-suspenders over a 127.0.0.1-only bridge; OFF by default.
let adoptedToken: string | null = null;

export function setSettings(s: Partial<Settings>): void {
  current = {
    tools: { ...(s.tools ?? {}) },
    readOnly: s.readOnly ?? false,
    confirmDestructive: s.confirmDestructive ?? false,
    auth: {
      enabled: s.auth?.enabled ?? false,
      token: s.auth?.token ?? "",
    },
    soundEnabled: s.soundEnabled ?? true,
    activityLog: s.activityLog ?? true,
  };
  // adopt or clear the auth token based on the freshly-stored settings
  if (current.auth.enabled && current.auth.token) {
    adoptedToken = current.auth.token;
  } else if (!current.auth.enabled) {
    adoptedToken = null;
  }
}

export function getSettings(): Settings {
  return current;
}

export function isToolEnabled(name: string): boolean {
  return current.tools[name] !== false; // default true
}

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

// Returns null if allowed, or a human-readable reason string if blocked.
export function gateToolCall(name: string): string | null {
  if (!isToolEnabled(name)) {
    return `tool '${name}' is disabled in Studio settings`;
  }
  if (isWriteTool(name) && current.readOnly) {
    return `read-only mode is on in Studio settings; '${name}' is a write tool`;
  }
  return null;
}

// Auth gate for /poll, /response, /settings. Allows everything until a token is
// adopted (so nothing breaks with auth off / before first settings push).
export function checkAuth(token: string | undefined): boolean {
  if (adoptedToken === null) {
    return true;
  }
  return token === adoptedToken;
}
