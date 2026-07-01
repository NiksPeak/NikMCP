--!strict
-- Settings model shared by the edit plugin (persistence + push) and the dock UI.
-- The plugin is the source of truth; the Node server enforces these so a disabled
-- tool can't run even if a client calls it. Default: every tool enabled.
local Settings = {}

-- Tool catalog (ordered for the UI). `group` drives the Read/Write/Experimental
-- headers; names MUST match the server's registerTool names + WRITE_TOOLS set.
Settings.TOOLS = {
	-- read / inspect
	{ name = "get_instance_tree", group = "read", label = "Instance tree" },
	{ name = "read_console", group = "read", label = "Read console" },
	{ name = "get_selection", group = "read", label = "Get selection" },
	{ name = "search_instances", group = "read", label = "Search instances" },
	{ name = "get_script_source", group = "read", label = "Get script source" },
	{ name = "list_scripts", group = "read", label = "List scripts" },
	{ name = "get_place_info", group = "read", label = "Place info" },
	{ name = "get_tagged", group = "read", label = "Get tagged" },
	{ name = "get_properties", group = "read", label = "Get properties (curated)" },
	{ name = "get_attribute", group = "read", label = "Get attribute" },
	{ name = "get_attributes", group = "read", label = "Get attributes" },
	{ name = "grep_scripts", group = "read", label = "Grep scripts" },
	{ name = "get_script_analysis", group = "read", label = "Script analysis" },
	{ name = "mass_get_property", group = "read", label = "Mass get property" },
	{ name = "get_class_info", group = "read", label = "Class info" },
	{ name = "get_services", group = "read", label = "Get services" },
	{ name = "get_descendants", group = "read", label = "Get descendants" },
	{ name = "get_connected_instances", group = "read", label = "Connected instances" },
	{ name = "compare_instances", group = "read", label = "Compare instances" },
	{ name = "get_project_structure", group = "read", label = "Project structure" },
	{ name = "get_file_tree", group = "read", label = "File tree" },
	{ name = "search_by_property", group = "read", label = "Search by property" },
	{ name = "get_tags", group = "read", label = "Get tags" },
	-- write / edit (read-only mode blocks these)
	{ name = "run_luau", group = "write", label = "Run Luau" },
	{ name = "set_property", group = "write", label = "Set property" },
	{ name = "write_script", group = "write", label = "Write script" },
	{ name = "set_selection", group = "write", label = "Set selection" },
	{ name = "create_instance", group = "write", label = "Create instance" },
	{ name = "delete_instance", group = "write", label = "Delete instance" },
	{ name = "clone_instance", group = "write", label = "Clone instance" },
	{ name = "rename_instance", group = "write", label = "Rename instance" },
	{ name = "set_parent", group = "write", label = "Set parent" },
	{ name = "move_instance", group = "write", label = "Move instance" },
	{ name = "bulk_set_property", group = "write", label = "Bulk set property" },
	{ name = "tag_instance", group = "write", label = "Tag instance" },
	{ name = "untag_instance", group = "write", label = "Untag instance" },
	{ name = "insert_asset", group = "write", label = "Insert asset" },
	{ name = "set_attribute", group = "write", label = "Set attribute" },
	{ name = "set_attributes", group = "write", label = "Set attributes" },
	{ name = "delete_attribute", group = "write", label = "Delete attribute" },
	{ name = "edit_script_lines", group = "write", label = "Edit script lines" },
	{ name = "insert_script_lines", group = "write", label = "Insert script lines" },
	{ name = "delete_script_lines", group = "write", label = "Delete script lines" },
	{ name = "find_and_replace_in_scripts", group = "write", label = "Find & replace in scripts" },
	{ name = "undo", group = "write", label = "Undo" },
	{ name = "redo", group = "write", label = "Redo" },
	{ name = "mass_create_objects", group = "write", label = "Mass create objects" },
	{ name = "mass_duplicate", group = "write", label = "Mass duplicate" },
	{ name = "smart_duplicate", group = "write", label = "Smart duplicate" },
	{ name = "mass_set_property", group = "write", label = "Mass set property" },
	{ name = "set_properties", group = "write", label = "Set properties (multi)" },
	{ name = "enable_playtest_agent", group = "write", label = "Enable playtest agent" },
	-- assets / marketplace
	{ name = "get_asset_details", group = "assets", label = "Asset details" },
	{ name = "get_asset_thumbnail", group = "assets", label = "Asset thumbnail" },
	{ name = "preview_asset", group = "assets", label = "Preview asset" },
	{ name = "search_materials", group = "assets", label = "Search materials" },
	{ name = "search_assets", group = "assets", label = "Search assets (Open Cloud)" },
	{ name = "list_library", group = "assets", label = "List library (Open Cloud)" },
	{ name = "upload_decal", group = "assets", label = "Upload decal (Open Cloud)" },
	-- experimental (may be unsupported from a plugin; see Phase D)
	{ name = "capture_viewport", group = "experimental", label = "Capture viewport" },
	{ name = "playtest_control", group = "experimental", label = "Playtest control" },
	{ name = "get_playtest_output", group = "experimental", label = "Get playtest output" },
	{ name = "simulate_keyboard_input", group = "experimental", label = "Simulate keyboard" },
	{ name = "simulate_mouse_input", group = "experimental", label = "Simulate mouse" },
	{ name = "character_navigation", group = "experimental", label = "Character navigation" },
	{ name = "play_animation", group = "experimental", label = "Play animation (server)" },
	-- build / scene / view (Task 16)
	{ name = "export_build", group = "scene", label = "Export build" },
	{ name = "create_build", group = "scene", label = "Create build" },
	{ name = "import_build", group = "scene", label = "Import build" },
	{ name = "generate_build", group = "scene", label = "Generate build" },
	{ name = "create_keyframe_sequence", group = "scene", label = "Create keyframe sequence" },
	{ name = "upload_animation", group = "scene", label = "Upload animation (Open Cloud)" },
	{ name = "create_sound", group = "scene", label = "Create sound" },
	{ name = "set_lighting", group = "scene", label = "Set lighting" },
	{ name = "import_scene", group = "scene", label = "Import scene" },
	{ name = "create_ui_tree", group = "scene", label = "Create UI tree" },
	{ name = "search_files", group = "scene", label = "Search files (names/paths)" },
	{ name = "raycast", group = "scene", label = "Raycast" },
	{ name = "get_bounding_box", group = "scene", label = "Bounding box" },
	{ name = "get_selection_bounds", group = "scene", label = "Selection bounds" },
	{ name = "get_camera", group = "scene", label = "Get camera" },
	{ name = "set_camera", group = "scene", label = "Set camera (view)" },
	{ name = "focus_instance", group = "scene", label = "Focus instance" },
	{ name = "get_perf_stats", group = "scene", label = "Perf stats" },
	{ name = "group_instances", group = "scene", label = "Group instances" },
	{ name = "ungroup_instance", group = "scene", label = "Ungroup instance" },
	{ name = "align_instances", group = "scene", label = "Align instances" },
	{ name = "measure_distance", group = "scene", label = "Measure distance" },
}

-- ordered group headers for the Settings UI
Settings.GROUPS = {
	{ key = "read", label = "Read tools" },
	{ key = "write", label = "Write tools" },
	{ key = "assets", label = "Assets / marketplace" },
	{ key = "experimental", label = "Experimental" },
	{ key = "scene", label = "Build / scene / view" },
}

function Settings.default(): { [string]: any }
	local tools: { [string]: boolean } = {}
	for _, t in ipairs(Settings.TOOLS) do
		tools[t.name] = true
	end
	return {
		tools = tools,
		readOnly = false,
		confirmDestructive = false,
		auth = { enabled = false, token = "" },
		soundEnabled = true,
		activityLog = true,
		-- Task 17: auto-stop an abandoned Run-mode playtest started via playtest_control.
		playtestAutoStop = true,
		playtestMaxSeconds = 300,
		playtestIdleSeconds = 120,
	}
end

-- Merge a (possibly partial / stale) stored table onto fresh defaults so new
-- tools added later default ON and missing/garbage fields are coerced.
function Settings.normalize(stored: any): { [string]: any }
	local s = Settings.default()
	if type(stored) ~= "table" then
		return s
	end
	if type(stored.tools) == "table" then
		for _, t in ipairs(Settings.TOOLS) do
			if type(stored.tools[t.name]) == "boolean" then
				s.tools[t.name] = stored.tools[t.name]
			end
		end
	end
	if type(stored.readOnly) == "boolean" then
		s.readOnly = stored.readOnly
	end
	if type(stored.confirmDestructive) == "boolean" then
		s.confirmDestructive = stored.confirmDestructive
	end
	if type(stored.auth) == "table" then
		if type(stored.auth.enabled) == "boolean" then
			s.auth.enabled = stored.auth.enabled
		end
		if type(stored.auth.token) == "string" then
			s.auth.token = stored.auth.token
		end
	end
	if type(stored.soundEnabled) == "boolean" then
		s.soundEnabled = stored.soundEnabled
	end
	if type(stored.activityLog) == "boolean" then
		s.activityLog = stored.activityLog
	end
	if type(stored.playtestAutoStop) == "boolean" then
		s.playtestAutoStop = stored.playtestAutoStop
	end
	if type(stored.playtestMaxSeconds) == "number" and stored.playtestMaxSeconds > 0 then
		s.playtestMaxSeconds = stored.playtestMaxSeconds
	end
	if type(stored.playtestIdleSeconds) == "number" and stored.playtestIdleSeconds > 0 then
		s.playtestIdleSeconds = stored.playtestIdleSeconds
	end
	return s
end

return Settings
