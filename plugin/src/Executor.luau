-- Executes commands against the DataModel. Used by the edit plugin.
-- (The runtime agent inlines a minimal version; the tools added in Task 5 are
-- edit-context handlers. During a live playtest, auto routes to the server agent,
-- which only supports run_luau / get_instance_tree and returns a clean
-- "agent does not support command" error for the rest.)
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local StudioTestService = game:GetService("StudioTestService")
local ServerScriptService = game:GetService("ServerScriptService")
local TestService = game:GetService("TestService")
local CollectionService = game:GetService("CollectionService")
local LogService = game:GetService("LogService")
local Selection = game:GetService("Selection")
local InsertService = game:GetService("InsertService")
local AssetService = game:GetService("AssetService")
local CaptureService = game:GetService("CaptureService")
local MarketplaceService = game:GetService("MarketplaceService")
local Stats = game:GetService("Stats")
local StarterPlayer = game:GetService("StarterPlayer")
local Serializer = require(script.Parent.Serializer)
local ClientAgentSource = require(script.Parent.ClientAgentSource)

local Executor = {}

-- Resolve a dot-path like "game.Workspace.Foo" to an Instance, or nil.
local function resolvePath(path: string): Instance?
	if path == "" or path == "game" then
		return game
	end
	local node: Instance? = game
	for segment in string.gmatch(path, "[^%.]+") do
		if segment == "game" then
			continue
		end
		if not node then
			return nil
		end
		node = node:FindFirstChild(segment)
	end
	return node
end

local function pathInfo(inst: Instance): any
	return { path = inst:GetFullName(), className = inst.ClassName, name = inst.Name }
end

-- Run a mutation wrapped in one ChangeHistory recording (edit context only).
-- Returns (ok, returnedValueOrError).
local function recorded(label: string, fn: () -> any): (boolean, any)
	local inEdit = not RunService:IsRunning()
	local recording: any = nil
	if inEdit then
		recording = ChangeHistoryService:TryBeginRecording(label)
	end
	local ok, ret = pcall(fn)
	if inEdit and recording then
		ChangeHistoryService:FinishRecording(
			recording,
			ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	return ok, ret
end

-- == Console ring buffer (feeds read_console) ================================
local CONSOLE_CAP = 500
local consoleRing: { { text: string, level: string, t: number } } = {}
local function pushConsole(text: string, level: string, t: number)
	table.insert(consoleRing, { text = text, level = level, t = t })
	if #consoleRing > CONSOLE_CAP then
		table.remove(consoleRing, 1)
	end
end
-- seed once from history, then keep it live
local function seedConsole()
	local ok, history = pcall(function()
		return LogService:GetLogHistory()
	end)
	if ok and type(history) == "table" then
		for _, e in ipairs(history) do
			pushConsole(tostring(e.message), e.messageType.Name, e.timestamp or 0)
		end
	end
end
seedConsole()
-- Playtest log ring (feeds get_playtest_output). Only fills while capturing
-- (set by playtest_control start/stop) so it isolates a single playtest run.
local PLAYTEST_CAP = 1000
local playtestRing: { { text: string, level: string, t: number } } = {}
local playtestCapturing = false
-- Lifecycle tracking for get_playtest_status + the auto-stop safety net. Only
-- set when a Run-mode playtest is started via playtest_control (we never auto-stop
-- a user-initiated F5/Play). startedAt = unix start; lastActivity bumps on
-- get_playtest_output and on any live server-context poll.
local playtestStartedAt: number? = nil
local playtestLastActivity: number = 0
local playtestMode: string? = nil
local function pushPlaytest(text: string, level: string, t: number)
	if not playtestCapturing then
		return
	end
	table.insert(playtestRing, { text = text, level = level, t = t })
	if #playtestRing > PLAYTEST_CAP then
		table.remove(playtestRing, 1)
	end
end
LogService.MessageOut:Connect(function(message, messageType)
	local t = os.time()
	pushConsole(tostring(message), messageType.Name, t)
	pushPlaytest(tostring(message), messageType.Name, t)
end)

-- loadstring + captured print/warn. Available at PluginSecurity (edit);
-- requires LoadStringEnabled in server runtime context.
local function runLuau(code: string): { ok: boolean, output: string, result: any?, err: string? }
	local buffer: { string } = {}
	local function capture(...)
		local n = select("#", ...)
		local parts = table.create(n)
		for i = 1, n do
			parts[i] = tostring((select(i, ...)))
		end
		table.insert(buffer, table.concat(parts, "\t"))
	end

	local chunk, compileErr = loadstring(code)
	if not chunk then
		return { ok = false, output = "", err = "compile error: " .. tostring(compileErr) }
	end

	-- Sandbox env: capture print/warn, fall through to real globals otherwise.
	local env = setmetatable({ print = capture, warn = capture }, { __index = getfenv() })
	setfenv(chunk, env)

	local packed = table.pack(pcall(chunk))
	local ok = packed[1]
	local output = table.concat(buffer, "\n")
	if not ok then
		return { ok = false, output = output, err = tostring(packed[2]) }
	end
	local result: any? = nil
	if packed.n > 1 then
		result = Serializer.serialize(packed[2])
	end
	return { ok = true, output = output, result = result }
end

local function getInstanceTree(path: string, maxDepth: number): any
	local root = resolvePath(path)
	if not root then
		return { ok = false, err = "path not found: " .. path }
	end
	local function walk(inst: Instance, depth: number): any
		local node = { name = inst.Name, className = inst.ClassName, children = {} :: { any } }
		if depth < maxDepth then
			for _, child in ipairs(inst:GetChildren()) do
				table.insert(node.children, walk(child, depth + 1))
			end
		end
		return node
	end
	return { ok = true, result = walk(root, 0) }
end

local function setProperty(path: string, property: string, rawValue: any): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local value = Serializer.deserialize(rawValue)
	local inEdit = not RunService:IsRunning()
	local recording: any = nil
	if inEdit then
		recording = ChangeHistoryService:TryBeginRecording("set_property:" .. property)
	end
	local ok, err = pcall(function()
		local target = inst :: any
		target[property] = value
	end)
	if inEdit and recording then
		ChangeHistoryService:FinishRecording(
			recording,
			ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	return { ok = true, output = ("set %s.%s"):format(path, property) }
end

-- Edit-only: write script source via the officially supported API.
local function writeScript(path: string, source: string, className: string?): any
	if RunService:IsRunning() then
		return { ok = false, err = "write_script is edit-context only" }
	end
	local inst = resolvePath(path)
	if not inst and className then
		-- create at the parent path; last segment is the new name
		local parentPath, name = string.match(path, "^(.*)%.([^%.]+)$")
		local parent = parentPath and resolvePath(parentPath) or game:GetService("ServerScriptService")
		if not parent then
			return { ok = false, err = "parent path not found for " .. path }
		end
		local created = Instance.new(className)
		created.Name = name or "NewScript"
		created.Parent = parent
		inst = created
	end
	if not inst then
		return { ok = false, err = "path not found and no className to create: " .. path }
	end
	local recording = ChangeHistoryService:TryBeginRecording("write_script")
	local ok, err = pcall(function()
		ScriptEditorService:UpdateSourceAsync(inst, function()
			return source
		end)
	end)
	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	return { ok = true, output = "wrote source to " .. inst:GetFullName() }
end

-- == Phase B: read / inspect ================================================
local LEVEL_MATCH = {
	error = "MessageError",
	warning = "MessageWarning",
	output = "MessageOutput",
}

local function readConsole(count: number, levelFilter: string?): any
	local want = levelFilter and LEVEL_MATCH[levelFilter] or nil
	local picked = {}
	for i = #consoleRing, 1, -1 do
		local e = consoleRing[i]
		if not want or e.level == want then
			table.insert(picked, 1, e)
			if #picked >= count then
				break
			end
		end
	end
	return { ok = true, result = { lines = picked, total = #consoleRing } }
end

local function getSelection(): any
	local out = {}
	for _, inst in ipairs(Selection:Get()) do
		table.insert(out, pathInfo(inst))
	end
	return { ok = true, result = out }
end

local function searchInstances(p: any): any
	local root = resolvePath(p.root or "game") or game
	local query = p.query and string.lower(tostring(p.query)) or nil
	local className = p.className
	local tag = p.tag
	local limit = p.limit or 100
	local out = {}
	local function matches(inst: Instance): boolean
		if className then
			local okc, isa = pcall(function()
				return inst:IsA(className)
			end)
			if not okc or not isa then
				return false
			end
		end
		if query and not string.find(string.lower(inst.Name), query, 1, true) then
			return false
		end
		return true
	end
	if tag then
		for _, inst in ipairs(CollectionService:GetTagged(tag)) do
			if (root == game or inst:IsDescendantOf(root)) and matches(inst) then
				table.insert(out, pathInfo(inst))
				if #out >= limit then
					break
				end
			end
		end
	else
		for _, inst in ipairs(root:GetDescendants()) do
			if matches(inst) then
				table.insert(out, pathInfo(inst))
				if #out >= limit then
					break
				end
			end
		end
	end
	return { ok = true, result = out }
end

local function getScriptSource(path: string): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	if not inst:IsA("LuaSourceContainer") then
		return { ok = false, err = path .. " is not a script (" .. inst.ClassName .. ")" }
	end
	local src: any = nil
	local ok = pcall(function()
		src = ScriptEditorService:GetEditorSource(inst)
	end)
	if not ok or src == nil then
		local ok2 = pcall(function()
			local target = inst :: any
			src = target.Source
		end)
		if not ok2 then
			return { ok = false, err = "could not read source of " .. path }
		end
	end
	return { ok = true, result = { path = inst:GetFullName(), source = src } }
end

local function listScripts(rootPath: string): any
	local root = resolvePath(rootPath or "game") or game
	local out = {}
	for _, inst in ipairs(root:GetDescendants()) do
		if inst:IsA("LuaSourceContainer") then
			table.insert(out, pathInfo(inst))
		end
	end
	return { ok = true, result = out }
end

-- == Task 26: RoCreate asset scan (edit context) =============================
-- Walk the place collecting asset references from known instance properties plus
-- the current PlaceId (the download step needs it as Roblox-Place-Id). Script-
-- source IDs are collected by the Node side via grep_scripts; here we only do the
-- typed instance properties, which are exact (not heuristic).

-- property name -> asset kind. A property is read via pcall (not every class has
-- every property); a value of 0 / "" / "rbxassetid://0" is skipped.
local ROCREATE_ASSET_PROPS: { [string]: string } = {
	SoundId = "audio",
	MeshId = "mesh",
	TextureId = "image",
	Texture = "image",
	Image = "image",
	AnimationId = "animation",
	HeadColor = "skip", -- guard: never treat colors as ids (defensive; not an id prop)
}

-- Extract a numeric asset id from a Content/string value. Accepts
-- "rbxassetid://123", "http://www.roblox.com/asset/?id=123", or a bare "123".
local function rocreateExtractId(value: any): string?
	if typeof(value) == "number" then
		if value > 0 then
			return tostring(math.floor(value))
		end
		return nil
	end
	if typeof(value) ~= "string" then
		return nil
	end
	local id = string.match(value, "rbxassetid://(%d+)")
		or string.match(value, "[%?&]id=(%d+)")
		or string.match(value, "^(%d+)$")
	if id and tonumber(id) and tonumber(id) > 0 then
		return id
	end
	return nil
end

local function rocreateScan(rootPath: string): any
	if RunService:IsRunning() then
		return { ok = false, err = "rocreate_scan is edit-context only (stop the playtest first)" }
	end
	local root = resolvePath(rootPath or "game") or game
	local references = {}
	local seen: { [string]: boolean } = {}
	local function consider(inst: Instance)
		for prop, kind in pairs(ROCREATE_ASSET_PROPS) do
			if kind == "skip" then
				continue
			end
			local ok, value = pcall(function()
				return (inst :: any)[prop]
			end)
			if ok then
				local id = rocreateExtractId(value)
				if id then
					local dedup = inst:GetFullName() .. "|" .. prop
					if not seen[dedup] then
						seen[dedup] = true
						table.insert(references, {
							path = inst:GetFullName(),
							prop = prop,
							kind = kind,
							id = id,
						})
					end
				end
			end
		end
	end
	consider(root)
	for _, inst in ipairs(root:GetDescendants()) do
		consider(inst)
	end
	return {
		ok = true,
		result = {
			placeId = tostring(game.PlaceId),
			universeId = tostring(game.GameId),
			references = references,
		},
	}
end

-- == Task 25: disk<->Studio script sync (edit context ONLY) ===================
-- FNV-1a 32-bit over CRLF->LF-normalized source bytes. MUST stay bit-identical
-- to fnv1a32 in src/sync.ts. Test vectors (tests/sync-unit.mjs asserts the Node
-- side against these): "" = 811c9dc5, "a" = e40c292c, "hello" = 4f9f2cab,
-- "foobar" = bf9cf968.
local function syncFnv1a32(text: string): string
	local buf = buffer.fromstring(text)
	local h = 2166136261
	for i = 0, buffer.len(buf) - 1 do
		h = bit32.bxor(h, buffer.readu8(buf, i))
		-- h * 16777619 mod 2^32 without f64 precision loss: 0x01000193 =
		-- 2^24 + 2^8 + 0x93; lshift terms are already uint32-truncated.
		h = (bit32.lshift(h, 24) + bit32.lshift(h, 8) + h * 0x93) % 4294967296
	end
	return string.format("%08x", h)
end

local function syncNormalize(src: string): string
	return (string.gsub(src, "\r\n", "\n"))
end

-- Same access pattern as getScriptSource (GetEditorSource, fallback .Source).
local function syncReadSource(inst: Instance): (boolean, string)
	local src: any = nil
	local ok = pcall(function()
		src = ScriptEditorService:GetEditorSource(inst)
	end)
	if not ok or src == nil then
		local ok2 = pcall(function()
			src = (inst :: any).Source
		end)
		if not ok2 or src == nil then
			return false, "could not read source"
		end
	end
	return true, src :: string
end

local function syncHasScriptDescendant(inst: Instance): boolean
	for _, d in ipairs(inst:GetDescendants()) do
		if d:IsA("LuaSourceContainer") then
			return true
		end
	end
	return false
end

local function syncList(rootPath: string): any
	if RunService:IsRunning() then
		return { ok = false, err = "sync_list is edit-context only (stop the playtest first)" }
	end
	local root = resolvePath(rootPath or "game")
	if not root then
		return { ok = false, err = "path not found: " .. tostring(rootPath) }
	end
	local out = {}
	local function consider(inst: Instance)
		if not inst:IsA("LuaSourceContainer") then
			return
		end
		local okRead, src = syncReadSource(inst)
		if not okRead then
			return -- unreadable source (permissions); listed nowhere, never faked
		end
		table.insert(out, {
			path = inst:GetFullName(),
			className = inst.ClassName,
			hash = syncFnv1a32(syncNormalize(src)),
			hasChildren = syncHasScriptDescendant(inst),
		})
	end
	consider(root)
	for _, inst in ipairs(root:GetDescendants()) do
		consider(inst)
	end
	return { ok = true, result = out }
end

local function syncGetSources(paths: { string }): any
	if RunService:IsRunning() then
		return { ok = false, err = "sync_get_sources is edit-context only (stop the playtest first)" }
	end
	local out = {}
	for _, path in ipairs(paths) do
		local inst = resolvePath(path)
		if not inst or not inst:IsA("LuaSourceContainer") then
			table.insert(out, { path = path, err = "not found or not a script" })
		else
			local okRead, src = syncReadSource(inst)
			if okRead then
				table.insert(out, { path = path, source = syncNormalize(src) })
			else
				table.insert(out, { path = path, err = src })
			end
		end
	end
	return { ok = true, result = out }
end

-- Apply many sources inside ONE ChangeHistory recording (one undo step).
-- Best-effort per item; the recording is still finalized (Commit if anything
-- applied, Cancel if nothing did).
local function syncSetSources(items: { { path: string, source: string } }): any
	if RunService:IsRunning() then
		return { ok = false, err = "sync_set_sources is edit-context only (stop the playtest first)" }
	end
	if type(items) ~= "table" or #items == 0 then
		return { ok = false, err = "items array required" }
	end
	local results = {}
	local anyApplied = false
	local recording = ChangeHistoryService:TryBeginRecording("import_scripts")
	for _, it in ipairs(items) do
		local inst = it and it.path and resolvePath(it.path)
		if not inst or not inst:IsA("LuaSourceContainer") then
			table.insert(results, { path = it and it.path or "?", ok = false, err = "not found or not a script" })
		elseif type(it.source) ~= "string" then
			table.insert(results, { path = it.path, ok = false, err = "source missing" })
		else
			local newSource = it.source
			local ok, err = pcall(function()
				ScriptEditorService:UpdateSourceAsync(inst, function()
					return newSource
				end)
			end)
			table.insert(results, { path = it.path, ok = ok, err = if ok then nil else tostring(err) })
			anyApplied = anyApplied or ok
		end
	end
	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			anyApplied and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	return { ok = true, result = results }
end

local function getPlaceInfo(): any
	local KEY_SERVICES = {
		"Workspace", "Players", "ReplicatedStorage", "ReplicatedFirst",
		"ServerScriptService", "ServerStorage", "StarterGui", "StarterPack",
		"StarterPlayer", "Lighting", "SoundService", "Teams",
	}
	local services = {}
	for _, n in ipairs(KEY_SERVICES) do
		local found = false
		pcall(function()
			found = game:FindService(n) ~= nil
		end)
		services[n] = found
	end
	local counts = {}
	for _, child in ipairs(game:GetChildren()) do
		counts[child.Name] = #child:GetChildren()
	end
	local cam = workspace.CurrentCamera
	return {
		ok = true,
		result = {
			placeId = game.PlaceId,
			gameId = game.GameId,
			placeName = game.Name,
			services = services,
			topLevelCounts = counts,
			selectionCount = #Selection:Get(),
			camera = cam and Serializer.serialize(cam.CFrame) or nil,
		},
	}
end

local function getTagged(tag: string): any
	local out = {}
	for _, inst in ipairs(CollectionService:GetTagged(tag)) do
		table.insert(out, pathInfo(inst))
	end
	return { ok = true, result = out }
end

-- Curated common-property dump (Luau has no full reflection). Optional explicit
-- propertyNames overrides the curated set.
local CURATED_PROPS = {
	"Archivable", "Position", "Size", "CFrame", "Orientation", "Anchored",
	"CanCollide", "CanTouch", "CanQuery", "Transparency", "Reflectance",
	"Color", "BrickColor", "Material", "CastShadow", "Massless",
	"Enabled", "Visible", "Active", "Text", "TextColor3", "TextScaled",
	"BackgroundColor3", "BackgroundTransparency", "Image", "Value",
	"Adornee", "Locked", "AssetId", "SoundId", "Volume", "PlaybackSpeed",
	"Brightness", "Range", "Disabled", "PrimaryPart",
}

local function getProperties(path: string, propertyNames: { string }?): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local names = propertyNames or CURATED_PROPS
	local props: { [string]: any } = {}
	local target = inst :: any
	for _, name in ipairs(names) do
		local ok, value = pcall(function()
			return target[name]
		end)
		if ok and value ~= nil then
			props[name] = Serializer.serialize(value)
		end
	end
	return {
		ok = true,
		result = {
			path = inst:GetFullName(),
			className = inst.ClassName,
			name = inst.Name,
			properties = props,
			curated = propertyNames == nil,
		},
	}
end

-- == Phase C: write / edit (ChangeHistory-wrapped in edit) ===================
local function setSelection(paths: { string }): any
	local insts = {}
	for _, p in ipairs(paths) do
		local inst = resolvePath(p)
		if inst then
			table.insert(insts, inst)
		end
	end
	local ok, err = pcall(function()
		Selection:Set(insts)
	end)
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	return { ok = true, output = ("selected %d instance(s)"):format(#insts) }
end

local function createInstance(p: any): any
	local parent = resolvePath(p.parentPath)
	if not parent then
		return { ok = false, err = "parent path not found: " .. tostring(p.parentPath) }
	end
	local ok, ret = recorded("create_instance", function()
		local inst = Instance.new(p.className)
		if p.name then
			inst.Name = p.name
		end
		if type(p.properties) == "table" then
			local target = inst :: any
			for k, v in pairs(p.properties) do
				target[k] = Serializer.deserialize(v)
			end
		end
		inst.Parent = parent
		return inst
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = "created " .. ret:GetFullName(), result = pathInfo(ret) }
end

local function deleteInstance(path: string): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local full = inst:GetFullName()
	local ok, ret = recorded("delete_instance", function()
		inst:Destroy()
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = "deleted " .. full }
end

local function cloneInstance(path: string, parentPath: string?): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local parent = parentPath and resolvePath(parentPath) or inst.Parent
	if not parent then
		return { ok = false, err = "parent path not found" }
	end
	local ok, ret = recorded("clone_instance", function()
		inst.Archivable = true
		local clone = inst:Clone()
		if not clone then
			error("clone failed")
		end
		clone.Parent = parent
		return clone
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = "cloned to " .. ret:GetFullName(), result = pathInfo(ret) }
end

local function renameInstance(path: string, name: string): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local ok, ret = recorded("rename_instance", function()
		inst.Name = name
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("renamed to %s"):format(name), result = pathInfo(inst) }
end

local function setParent(path: string, parentPath: string): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local parent = resolvePath(parentPath)
	if not parent then
		return { ok = false, err = "parent path not found: " .. parentPath }
	end
	local ok, ret = recorded("set_parent", function()
		inst.Parent = parent
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = "moved " .. inst:GetFullName(), result = pathInfo(inst) }
end

local function moveInstance(p: any): any
	local inst = resolvePath(p.path)
	if not inst then
		return { ok = false, err = "path not found: " .. tostring(p.path) }
	end
	local ok, ret = recorded("move_instance", function()
		local target = inst :: any
		if p.cframe ~= nil then
			local cf = Serializer.deserialize(p.cframe)
			if inst:IsA("Model") then
				inst:PivotTo(cf)
			else
				target.CFrame = cf
			end
		elseif p.position ~= nil then
			local pos = Serializer.deserialize(p.position)
			if inst:IsA("Model") then
				inst:PivotTo(CFrame.new(pos))
			else
				target.Position = pos
			end
		else
			error("move_instance needs cframe or position")
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = "moved " .. inst:GetFullName() }
end

local function bulkSetProperty(paths: { string }, property: string, rawValue: any): any
	local value = Serializer.deserialize(rawValue)
	local count = 0
	local failed = {}
	local ok, ret = recorded("bulk_set_property:" .. property, function()
		for _, p in ipairs(paths) do
			local inst = resolvePath(p)
			if inst then
				local target = inst :: any
				local setOk = pcall(function()
					target[property] = value
				end)
				if setOk then
					count += 1
				else
					table.insert(failed, p)
				end
			else
				table.insert(failed, p)
			end
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return {
		ok = true,
		output = ("set %s on %d/%d"):format(property, count, #paths),
		result = { set = count, failed = failed },
	}
end

local function tagInstance(path: string, tag: string, add: boolean): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local ok, ret = recorded(add and "tag_instance" or "untag_instance", function()
		if add then
			CollectionService:AddTag(inst, tag)
		else
			CollectionService:RemoveTag(inst, tag)
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("%s %q on %s"):format(add and "added tag" or "removed tag", tag, inst:GetFullName()) }
end

local function insertAsset(assetId: number, parentPath: string?): any
	local parent = parentPath and resolvePath(parentPath) or workspace
	if not parent then
		return { ok = false, err = "parent path not found: " .. tostring(parentPath) }
	end
	local inserted = {}
	local ok, ret = recorded("insert_asset", function()
		local container = InsertService:LoadAsset(assetId)
		for _, child in ipairs(container:GetChildren()) do
			child.Parent = parent
			table.insert(inserted, pathInfo(child))
		end
		container:Destroy()
	end)
	if not ok then
		return { ok = false, err = "LoadAsset failed (asset must be owned or public): " .. tostring(ret) }
	end
	return { ok = true, output = ("inserted %d instance(s)"):format(#inserted), result = inserted }
end

-- == Batch 1: viewport capture + playtest control ===========================
-- base64 of a raw byte buffer (for JSON transport of the screenshot's RGBA).
-- Buffer-based (Boshy-style) so a multi-megapixel frame encodes fast and never
-- stalls the poll loop. The PNG itself is encoded in Node (src/png-encoder.ts) --
-- pure-Luau PNG encoding of a full frame was the old "capture never returns" stall.
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local B64BYTES = buffer.create(64)
for i = 0, 63 do
	buffer.writeu8(B64BYTES, i, string.byte(B64, i + 1))
end
local PAD = string.byte("=")

local function base64Buffer(buf: buffer): string
	local len = buffer.len(buf)
	local fullTriples = math.floor(len / 3)
	local remaining = len - fullTriples * 3
	local outLen = (fullTriples + (remaining > 0 and 1 or 0)) * 4
	local out = buffer.create(outLen)
	local si, di = 0, 0
	for _ = 1, fullTriples do
		local b0 = buffer.readu8(buf, si)
		local b1 = buffer.readu8(buf, si + 1)
		local b2 = buffer.readu8(buf, si + 2)
		buffer.writeu8(out, di, buffer.readu8(B64BYTES, bit32.rshift(b0, 2)))
		buffer.writeu8(out, di + 1, buffer.readu8(B64BYTES, bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))))
		buffer.writeu8(out, di + 2, buffer.readu8(B64BYTES, bit32.bor(bit32.lshift(bit32.band(b1, 15), 2), bit32.rshift(b2, 6))))
		buffer.writeu8(out, di + 3, buffer.readu8(B64BYTES, bit32.band(b2, 63)))
		si += 3
		di += 4
	end
	if remaining == 2 then
		local b0 = buffer.readu8(buf, si)
		local b1 = buffer.readu8(buf, si + 1)
		buffer.writeu8(out, di, buffer.readu8(B64BYTES, bit32.rshift(b0, 2)))
		buffer.writeu8(out, di + 1, buffer.readu8(B64BYTES, bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))))
		buffer.writeu8(out, di + 2, buffer.readu8(B64BYTES, bit32.lshift(bit32.band(b1, 15), 2)))
		buffer.writeu8(out, di + 3, PAD)
	elseif remaining == 1 then
		local b0 = buffer.readu8(buf, si)
		buffer.writeu8(out, di, buffer.readu8(B64BYTES, bit32.rshift(b0, 2)))
		buffer.writeu8(out, di + 1, buffer.readu8(B64BYTES, bit32.lshift(bit32.band(b0, 3), 4)))
		buffer.writeu8(out, di + 2, PAD)
		buffer.writeu8(out, di + 3, PAD)
	end
	return buffer.tostring(out)
end

-- EditableImage:ReadPixelsBuffer has a per-call size ceiling; read in <=1024x1024
-- tiles and stitch into one tightly-packed RGBA buffer (Boshy-style). Needed for
-- frames larger than 1024 on either axis.
local function readPixelsTiled(img: any, w: number, h: number): buffer
	local TILE = 1024
	local full = buffer.create(w * h * 4)
	local fullRowBytes = w * 4
	local ty = 0
	while ty < h do
		local tileH = math.min(TILE, h - ty)
		local tx = 0
		while tx < w do
			local tileW = math.min(TILE, w - tx)
			local tileBuf = img:ReadPixelsBuffer(Vector2.new(tx, ty), Vector2.new(tileW, tileH))
			local tileRowBytes = tileW * 4
			for row = 0, tileH - 1 do
				buffer.copy(full, (ty + row) * fullRowBytes + tx * 4, tileBuf, row * tileRowBytes, tileRowBytes)
			end
			tx += TILE
		end
		ty += TILE
	end
	return full
end

-- Real screenshot via CaptureService + EditableImage. Returns RAW RGBA (base64) +
-- dimensions; Node encodes the PNG. Capture ONLY works in Edit mode with the Studio
-- viewport visible and rendering (engine limit -- it reads the rendered screen) and
-- requires Game Settings > Security > "Allow Mesh / Image APIs".
local function captureViewport(): any
	local capturedId: string? = nil
	local okCap = pcall(function()
		local done = false
		CaptureService:CaptureScreenshot(function(id)
			capturedId = id
			done = true
		end)
		local waited = 0
		while not done and waited < 10 do
			task.wait(0.1)
			waited += 0.1
		end
	end)
	if not okCap or not capturedId then
		-- the screenshot step itself failed/timed out (callback never fired)
		return {
			ok = false,
			err = "capture_viewport: screenshot timed out (CaptureService:CaptureScreenshot never returned). "
				.. "Capture only works in Edit mode with the Studio viewport visible and rendering -- "
				.. "make sure the 3D viewport is focused and not hidden behind a playtest or another tab.",
		}
	end
	-- Pass the capture content id string directly; only wrap with Content.fromUri
	-- when that library exists (older Studio builds lack it).
	local imgArg: any = capturedId
	if (Content :: any) and (Content :: any).fromUri then
		imgArg = (Content :: any).fromUri(capturedId :: string)
	end
	local img: any = nil
	local okImg, errImg = pcall(function()
		img = AssetService:CreateEditableImageAsync(imgArg)
	end)
	if not okImg or not img then
		-- image-handle creation failed -- most commonly the Mesh/Image API toggle
		return {
			ok = false,
			err = "capture_viewport: could not create an EditableImage from the screenshot. If "
				.. "Game Settings > Security > 'Allow Mesh / Image APIs' is OFF, turn it ON and retry. "
				.. "(raw error: " .. tostring(errImg) .. ")",
		}
	end
	-- Read pixels in Luau (tiled), base64 the raw RGBA, and hand it to Node to PNG-encode.
	local okEnc, resultOrErr = pcall(function()
		local size = img.Size
		local w, h = math.floor(size.X), math.floor(size.Y)
		local rgba = readPixelsTiled(img, w, h)
		return { rgba = base64Buffer(rgba), width = w, height = h }
	end)
	pcall(function()
		(img :: any):Destroy()
	end)
	if not okEnc then
		return { ok = false, err = "capture_viewport: read pixels failed: " .. tostring(resultOrErr) }
	end
	return { ok = true, result = resultOrErr }
end

-- Start/stop a real playtest via StudioTestService:ExecuteRunModeAsync /
-- ExecutePlayModeAsync (the same API that drives F8/F5). These yield for the
-- whole playtest and spin up a SEPARATE run DataModel, so the edit-context
-- plugin sees RunService:IsRunning()==false throughout -- the true "is it live"
-- signal is the runtime agent's `server` liveness (merged in by the Node layer).
-- NOTE: RunService:Run() is a no-op from a plugin in this Studio build (verified
-- empirically: IsRunning() stays false even after a wait); ExecuteRunModeAsync
-- is the mechanism that actually starts the simulation.
local PLAYTEST_STOP_SIGNAL = "__MCP_STOP__"
local playtestStopListener: Instance? = nil

-- Inject a Script into ServerScriptService that, once cloned into the run
-- DataModel, ends the test when it sees the stop signal in the log stream.
-- Must be injected BEFORE Execute*ModeAsync so it travels into the run session.
local function injectPlaytestStopListener()
	-- Guard against duplicates (idempotent re-arm).
	local existing = ServerScriptService:FindFirstChild("__MCP_CommandListener")
	if existing then
		playtestStopListener = existing
		return
	end
	local listener = Instance.new("Script")
	listener.Name = "__MCP_CommandListener"
	local source = table.concat({
		'local LogService = game:GetService("LogService")',
		'local StudioTestService = game:GetService("StudioTestService")',
		'LogService.MessageOut:Connect(function(msg)',
		'\tif msg == "' .. PLAYTEST_STOP_SIGNAL .. '" then',
		'\t\tpcall(function() StudioTestService:EndTest("stopped_by_mcp") end)',
		'\tend',
		'end)',
	}, "\n")
	local seOk = pcall(function()
		ScriptEditorService:UpdateSourceAsync(listener, function()
			return source
		end)
	end)
	if not seOk then
		listener.Source = source
	end
	listener.Parent = ServerScriptService
	playtestStopListener = listener
end

local function cleanupPlaytestStopListener()
	if playtestStopListener then
		pcall(function()
			playtestStopListener:Destroy()
		end)
		playtestStopListener = nil
	end
	local stray = ServerScriptService:FindFirstChild("__MCP_CommandListener")
	if stray then
		pcall(function()
			stray:Destroy()
		end)
	end
end

-- Client agent (play mode only): HttpService is server-only, so a LocalScript
-- cannot reach the bridge directly -- it relays through the server agent
-- (RuntimeAgentSource) instead. Injected BEFORE ExecutePlayModeAsync so it
-- travels into the run DataModel; run mode never gets this (no client there).
local CLIENT_AGENT_NAME = "NikMCP_ClientAgent"

local function injectClientAgent()
	local starterPlayerScripts = StarterPlayer:FindFirstChild("StarterPlayerScripts")
	if not starterPlayerScripts then
		return
	end
	if starterPlayerScripts:FindFirstChild(CLIENT_AGENT_NAME) then
		return -- never two: name-check before parenting
	end
	local agent = Instance.new("LocalScript")
	agent.Name = CLIENT_AGENT_NAME
	agent.Archivable = true
	local seOk = pcall(function()
		ScriptEditorService:UpdateSourceAsync(agent, function()
			return ClientAgentSource
		end)
	end)
	if not seOk then
		agent.Source = ClientAgentSource
	end
	agent.Parent = starterPlayerScripts
end

local function cleanupClientAgent()
	local starterPlayerScripts = StarterPlayer:FindFirstChild("StarterPlayerScripts")
	if not starterPlayerScripts then
		return
	end
	local existing = starterPlayerScripts:FindFirstChild(CLIENT_AGENT_NAME)
	if existing then
		pcall(function()
			existing:Destroy()
		end)
	end
end

local function playtestControl(p: any): any
	local action = tostring(p.action)
	local mode = p.mode or "run"
	if action == "start" then
		if RunService:IsRunning() or playtestStartedAt ~= nil then
			return { ok = false, err = "a playtest/simulation is already running" }
		end
		if mode ~= "run" and mode ~= "play" then
			return { ok = false, err = "playtest_control: mode must be 'run' or 'play'" }
		end
		playtestRing = {}
		playtestCapturing = true
		playtestMode = mode
		if p.numPlayers ~= nil then
			pcall(function()
				TestService.NumberOfPlayers = math.clamp(tonumber(p.numPlayers) or 1, 1, 8)
			end)
		end
		injectPlaytestStopListener()
		if mode == "play" then
			-- Play mode only -- run mode has no client, period.
			injectClientAgent()
		end
		local launchErr: string? = nil
		task.spawn(function()
			local ok, err = pcall(function()
				if mode == "play" then
					return StudioTestService:ExecutePlayModeAsync({})
				end
				return StudioTestService:ExecuteRunModeAsync({})
			end)
			if not ok then
				launchErr = tostring(err)
			end
			-- Execute*ModeAsync returns only when the playtest ENDS.
			playtestCapturing = false
			playtestStartedAt = nil
			playtestMode = nil
			cleanupPlaytestStopListener()
			pcall(cleanupClientAgent)
		end)
		-- Brief wait to surface an immediate launch failure before reporting.
		task.wait(0.3)
		if launchErr ~= nil then
			playtestCapturing = false
			playtestMode = nil
			cleanupPlaytestStopListener()
			pcall(cleanupClientAgent)
			local fn = (mode == "play") and "ExecutePlayModeAsync" or "ExecuteRunModeAsync"
			return { ok = false, err = "StudioTestService:" .. fn .. " failed: " .. launchErr }
		end
		playtestStartedAt = os.time()
		playtestLastActivity = os.time()
		return {
			ok = true,
			output = "launched " .. mode .. " mode via StudioTestService (separate DataModel); "
				.. "confirm it is live with get_playtest_status (agentConnected/running) -- the edit "
				.. "plugin cannot see the run DataModel directly",
		}
	elseif action == "stop" then
		-- Primary: signal the in-run listener to EndTest. Fallback: EndTest direct.
		pcall(function()
			warn(PLAYTEST_STOP_SIGNAL)
		end)
		local endOk = pcall(function()
			StudioTestService:EndTest("stopped_by_mcp")
		end)
		playtestCapturing = false
		playtestStartedAt = nil
		playtestMode = nil
		cleanupPlaytestStopListener()
		pcall(cleanupClientAgent)
		return {
			ok = true,
			output = "sent stop (warn " .. PLAYTEST_STOP_SIGNAL
				.. (endOk and " + EndTest)" or " ; EndTest direct call errored, listener signal sent)"),
		}
	end
	return { ok = false, err = "playtest_control: action must be 'start' or 'stop'" }
end

-- Drain (default) or peek the captured playtest log ring.
local function getPlaytestOutput(p: any): any
	playtestLastActivity = os.time() -- agent is actively watching -> not idle
	local lines = playtestRing
	if p.drain ~= false then
		playtestRing = {}
	end
	local result: { [string]: any } = { lines = lines, capturing = playtestCapturing, count = #lines, client = {} }
	if playtestMode ~= "play" then
		result.note = "run mode has no client"
	end
	return { ok = true, result = result }
end

-- Playtest lifecycle status (feeds the ungated get_playtest_status tool). The
-- Node server merges in agentConnected from bridge `server` liveness.
local function getPlaytestStatus(): any
	-- Raw edit-context signals only. The authoritative "is a playtest live" signal
	-- is the runtime agent's `server` liveness, which only the Node layer can see;
	-- it gates `running`/`mode`/`duration` on that. We surface:
	--   simRunning      = RunService:IsRunning() (true only for same-DataModel sims)
	--   startedAtUnix   = our launch timestamp; non-nil ONLY while an Execute*ModeAsync
	--                     we started is still yielding (cleared the instant it returns)
	-- A StudioTestService run spins up a separate DataModel, so simRunning stays
	-- false there; the live signal is startedAtUnix + server liveness.
	local simRunning = RunService:IsRunning()
	local players = 0
	pcall(function()
		players = #game:GetService("Players"):GetPlayers()
	end)
	local duration = playtestStartedAt and (os.time() - playtestStartedAt) or 0
	return {
		ok = true,
		result = {
			running = simRunning,
			mode = playtestMode,
			startedAtUnix = playtestStartedAt,
			durationSec = duration,
			players = players,
		},
	}
end

-- == Batch 2: attributes ====================================================
local function getAttribute(path: string, name: string): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	return { ok = true, result = { path = inst:GetFullName(), name = name, value = Serializer.serialize(inst:GetAttribute(name)) } }
end

local function getAttributes(path: string): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local out: { [string]: any } = {}
	for k, v in pairs(inst:GetAttributes()) do
		out[k] = Serializer.serialize(v)
	end
	return { ok = true, result = { path = inst:GetFullName(), attributes = out } }
end

local function setAttribute(path: string, name: string, rawValue: any): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local ok, ret = recorded("set_attribute:" .. name, function()
		inst:SetAttribute(name, Serializer.deserialize(rawValue))
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("set attribute %q on %s"):format(name, inst:GetFullName()) }
end

local function setAttributes(path: string, attrs: any): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	if type(attrs) ~= "table" then
		return { ok = false, err = "set_attributes needs an 'attributes' table" }
	end
	local count = 0
	local ok, ret = recorded("set_attributes", function()
		for k, v in pairs(attrs) do
			inst:SetAttribute(k, Serializer.deserialize(v))
			count += 1
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("set %d attribute(s) on %s"):format(count, inst:GetFullName()) }
end

local function deleteAttribute(path: string, name: string): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local ok, ret = recorded("delete_attribute:" .. name, function()
		inst:SetAttribute(name, nil)
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("deleted attribute %q from %s"):format(name, inst:GetFullName()) }
end

-- == Batch 3: script editing depth ==========================================
local function readEditorSource(inst: Instance): (boolean, string)
	local src: any = nil
	local ok = pcall(function()
		src = ScriptEditorService:GetEditorSource(inst)
	end)
	if not ok or src == nil then
		local ok2 = pcall(function()
			src = (inst :: any).Source
		end)
		if not ok2 or src == nil then
			return false, "could not read source"
		end
	end
	return true, src
end

local function splice(lines: { string }, startIdx: number, deleteCount: number, insert: { string }?): { string }
	local out = {}
	for i = 1, startIdx - 1 do
		out[#out + 1] = lines[i]
	end
	if insert then
		for _, l in ipairs(insert) do
			out[#out + 1] = l
		end
	end
	for i = startIdx + deleteCount, #lines do
		out[#out + 1] = lines[i]
	end
	return out
end

local function escapePattern(s: string): string
	return (s:gsub("([%(%)%.%%%+%-%*%?%[%]%^%$])", "%%%1"))
end

-- Resolve a script + read source; returns (inst, source) or (nil, errResult).
local function resolveScript(path: string): (Instance?, string?, any?)
	local inst = resolvePath(path)
	if not inst then
		return nil, nil, { ok = false, err = "path not found: " .. path }
	end
	if not inst:IsA("LuaSourceContainer") then
		return nil, nil, { ok = false, err = path .. " is not a script (" .. inst.ClassName .. ")" }
	end
	local rok, src = readEditorSource(inst)
	if not rok then
		return nil, nil, { ok = false, err = "could not read source of " .. path }
	end
	return inst, src, nil
end

local function writeLineEdit(inst: Instance, newLines: { string }, label: string): any
	local newSrc = table.concat(newLines, "\n")
	local ok, err = recorded(label, function()
		ScriptEditorService:UpdateSourceAsync(inst, function()
			return newSrc
		end)
	end)
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	return { ok = true, output = ("%s %s (%d lines)"):format(label, inst:GetFullName(), #newLines) }
end

local function editScriptLines(p: any): any
	if RunService:IsRunning() then
		return { ok = false, err = "script editing is edit-context only" }
	end
	local inst, src, errRes = resolveScript(p.path)
	if not inst then
		return errRes
	end
	local lines = string.split(src :: string, "\n")
	local startLine = math.max(1, math.floor(p.startLine or 1))
	local endLine = math.min(#lines, math.floor(p.endLine or startLine))
	if endLine < startLine then
		endLine = startLine - 1 -- nothing deleted; pure insert at startLine
	end
	local inserted = string.split(tostring(p.newText or ""), "\n")
	local newLines = splice(lines, startLine, endLine - startLine + 1, inserted)
	return writeLineEdit(inst, newLines, "edit_script_lines")
end

local function insertScriptLines(p: any): any
	if RunService:IsRunning() then
		return { ok = false, err = "script editing is edit-context only" }
	end
	local inst, src, errRes = resolveScript(p.path)
	if not inst then
		return errRes
	end
	local lines = string.split(src :: string, "\n")
	local at = math.max(1, math.min(#lines + 1, math.floor(p.line or (#lines + 1))))
	local inserted = string.split(tostring(p.newText or ""), "\n")
	local newLines = splice(lines, at, 0, inserted)
	return writeLineEdit(inst, newLines, "insert_script_lines")
end

local function deleteScriptLines(p: any): any
	if RunService:IsRunning() then
		return { ok = false, err = "script editing is edit-context only" }
	end
	local inst, src, errRes = resolveScript(p.path)
	if not inst then
		return errRes
	end
	local lines = string.split(src :: string, "\n")
	local startLine = math.max(1, math.floor(p.startLine or 1))
	local endLine = math.min(#lines, math.floor(p.endLine or startLine))
	if endLine < startLine then
		return { ok = false, err = "delete_script_lines: endLine < startLine" }
	end
	local newLines = splice(lines, startLine, endLine - startLine + 1, nil)
	return writeLineEdit(inst, newLines, "delete_script_lines")
end

local function findReplaceInScripts(p: any): any
	if RunService:IsRunning() then
		return { ok = false, err = "find_and_replace_in_scripts is edit-context only" }
	end
	local find = p.find
	if not find or find == "" then
		return { ok = false, err = "find_and_replace_in_scripts: 'find' is required" }
	end
	local root = resolvePath(p.root or "game") or game
	local replace = tostring(p.replace or "")
	local useRegex = p.regex == true
	local pat = useRegex and find or escapePattern(find)
	local repl = useRegex and replace or (replace:gsub("%%", "%%%%"))
	local changed = {}
	local ok, ret = recorded("find_and_replace_in_scripts", function()
		for _, inst in ipairs(root:GetDescendants()) do
			if inst:IsA("LuaSourceContainer") then
				local rok, src = readEditorSource(inst)
				if rok then
					local newSrc, count = string.gsub(src, pat, repl)
					if count > 0 and newSrc ~= src then
						ScriptEditorService:UpdateSourceAsync(inst, function()
							return newSrc
						end)
						table.insert(changed, { path = inst:GetFullName(), replacements = count })
					end
				end
			end
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("changed %d script(s)"):format(#changed), result = changed }
end

local function grepScripts(p: any): any
	local pattern = p.pattern
	if not pattern or pattern == "" then
		return { ok = false, err = "grep_scripts: 'pattern' is required" }
	end
	local root = resolvePath(p.root or "game") or game
	local useRegex = p.regex == true
	local limit = p.limit or 500
	local out = {}
	for _, inst in ipairs(root:GetDescendants()) do
		if inst:IsA("LuaSourceContainer") then
			local rok, src = readEditorSource(inst)
			if rok then
				local lineNo = 0
				for line in (src .. "\n"):gmatch("(.-)\n") do
					lineNo += 1
					local hit
					if useRegex then
						hit = string.find(line, pattern) ~= nil
					else
						hit = string.find(line, pattern, 1, true) ~= nil
					end
					if hit then
						table.insert(out, { path = inst:GetFullName(), line = lineNo, text = line })
						if #out >= limit then
							break
						end
					end
				end
			end
		end
		if #out >= limit then
			break
		end
	end
	return { ok = true, result = { matches = out, truncated = #out >= limit } }
end

local function getScriptAnalysis(p: any): any
	local inst, src, errRes = resolveScript(p.path)
	if not inst then
		return errRes
	end
	local chunk, err = loadstring(src :: string)
	if not chunk then
		return { ok = true, result = { path = inst:GetFullName(), compiles = false, diagnostics = { tostring(err) } } }
	end
	return { ok = true, result = { path = inst:GetFullName(), compiles = true, diagnostics = {} } }
end

-- == Batch 4: undo / redo + mass ops ========================================
local function undo(): any
	if RunService:IsRunning() then
		return { ok = false, err = "undo is edit-context only" }
	end
	local ok, err = pcall(function()
		ChangeHistoryService:Undo()
	end)
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	return { ok = true, output = "undo" }
end

local function redo(): any
	if RunService:IsRunning() then
		return { ok = false, err = "redo is edit-context only" }
	end
	local ok, err = pcall(function()
		ChangeHistoryService:Redo()
	end)
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	return { ok = true, output = "redo" }
end

-- Translate a PVInstance (BasePart or Model) by a WORLD-space delta.
local function translateInstance(inst: Instance, delta: Vector3)
	if inst:IsA("PVInstance") then
		pcall(function()
			(inst :: any):PivotTo((inst :: any):GetPivot() + delta)
		end)
	end
end

local function massCreateObjects(items: any): any
	if type(items) ~= "table" then
		return { ok = false, err = "mass_create_objects needs an items[] array" }
	end
	local made, failed = {}, {}
	local ok, ret = recorded("mass_create_objects", function()
		for _, item in ipairs(items) do
			local parent = item.parentPath and resolvePath(item.parentPath) or nil
			if not parent then
				table.insert(failed, { parentPath = item.parentPath, err = "parent not found" })
				continue
			end
			local cok, cerr = pcall(function()
				local inst = Instance.new(item.className)
				if item.name then
					inst.Name = item.name
				end
				if type(item.properties) == "table" then
					local target = inst :: any
					for k, v in pairs(item.properties) do
						pcall(function()
							target[k] = Serializer.deserialize(v)
						end)
					end
				end
				inst.Parent = parent
				table.insert(made, pathInfo(inst))
			end)
			if not cok then
				table.insert(failed, { className = item.className, err = tostring(cerr) })
			end
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return {
		ok = true,
		output = ("created %d, %d failed"):format(#made, #failed),
		result = { created = made, failed = failed },
	}
end

local function massDuplicate(p: any): any
	local inst = resolvePath(p.path)
	if not inst then
		return { ok = false, err = "path not found: " .. tostring(p.path) }
	end
	local count = math.max(1, math.floor(p.count or 1))
	local offset = p.offset ~= nil and Serializer.deserialize(p.offset) or Vector3.new(0, 0, 0)
	local parent = inst.Parent
	if not parent then
		return { ok = false, err = "cannot duplicate the root" }
	end
	local made = {}
	local ok, ret = recorded("mass_duplicate", function()
		inst.Archivable = true
		for i = 1, count do
			local clone = inst:Clone()
			clone.Parent = parent
			if typeof(offset) == "Vector3" and offset.Magnitude > 0 then
				translateInstance(clone, offset * i)
			end
			table.insert(made, pathInfo(clone))
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("duplicated %d time(s)"):format(#made), result = made }
end

-- Grid/line clone layout. mode='grid' (default) tiles by columns+spacing;
-- mode='line' steps by spacing*i.
local function smartDuplicate(p: any): any
	local inst = resolvePath(p.path)
	if not inst then
		return { ok = false, err = "path not found: " .. tostring(p.path) }
	end
	local parent = inst.Parent
	if not parent then
		return { ok = false, err = "cannot duplicate the root" }
	end
	local count = math.max(1, math.floor(p.count or 1))
	local mode = p.mode or "grid"
	local spacing = p.spacing ~= nil and Serializer.deserialize(p.spacing) or Vector3.new(10, 0, 10)
	if typeof(spacing) ~= "Vector3" then
		spacing = Vector3.new(10, 0, 10)
	end
	local columns = math.max(1, math.floor(p.columns or math.ceil(math.sqrt(count))))
	local made = {}
	local ok, ret = recorded("smart_duplicate", function()
		inst.Archivable = true
		for i = 0, count - 1 do
			local clone = inst:Clone()
			clone.Parent = parent
			local delta: Vector3
			if mode == "line" then
				delta = spacing * i
			else
				local col = i % columns
				local row = math.floor(i / columns)
				delta = Vector3.new(spacing.X * col, spacing.Y * row, spacing.Z * row)
			end
			if delta.Magnitude > 0 then
				translateInstance(clone, delta)
			end
			table.insert(made, pathInfo(clone))
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("placed %d clone(s) in %s pattern"):format(#made, mode), result = made }
end

local function massGetProperty(paths: { string }, property: string): any
	local out: { [string]: any } = {}
	local missing = {}
	for _, path in ipairs(paths) do
		local inst = resolvePath(path)
		if inst then
			local ok, val = pcall(function()
				return (inst :: any)[property]
			end)
			if ok then
				out[path] = Serializer.serialize(val)
			else
				table.insert(missing, path)
			end
		else
			table.insert(missing, path)
		end
	end
	return { ok = true, result = { property = property, values = out, missing = missing } }
end

-- == Batch 5: deeper inspection =============================================
-- Luau has no full reflection from a plugin. We return what IS discoverable
-- (creatable? which curated props apply) and document the limitation honestly.
local function getClassInfo(className: string): any
	local okNew, inst = pcall(function()
		return Instance.new(className)
	end)
	if not okNew or not inst then
		return {
			ok = true,
			result = {
				className = className,
				creatable = false,
				note = "Not creatable via Instance.new (abstract/service/unknown). Luau has no "
					.. "full reflection from a plugin; methods/events/full property lists need the "
					.. "Roblox API dump JSON, which is not bundled.",
			},
		}
	end
	local applicable = {}
	local target = inst :: any
	for _, name in ipairs(CURATED_PROPS) do
		local ok = pcall(function()
			return target[name]
		end)
		if ok then
			table.insert(applicable, name)
		end
	end
	inst:Destroy()
	return {
		ok = true,
		result = {
			className = className,
			creatable = true,
			applicableCuratedProperties = applicable,
			note = "Luau has no full reflection from a plugin; methods/events and the complete "
				.. "property list are not enumerable without bundling the Roblox API dump. Listed "
				.. "props are the curated subset that apply to this class.",
		},
	}
end

local function getServices(): any
	local out = {}
	for _, child in ipairs(game:GetChildren()) do
		table.insert(out, { name = child.Name, className = child.ClassName })
	end
	return { ok = true, result = out }
end

local function getDescendants(path: string, maxDepth: number?): any
	local root = resolvePath(path)
	if not root then
		return { ok = false, err = "path not found: " .. path }
	end
	local out = {}
	local cap = 5000
	if maxDepth then
		local function walk(inst: Instance, d: number)
			for _, c in ipairs(inst:GetChildren()) do
				if #out >= cap then
					return
				end
				table.insert(out, pathInfo(c))
				if d < maxDepth then
					walk(c, d + 1)
				end
			end
		end
		walk(root, 1)
	else
		for _, d in ipairs(root:GetDescendants()) do
			table.insert(out, pathInfo(d))
			if #out >= cap then
				break
			end
		end
	end
	return { ok = true, result = { descendants = out, truncated = #out >= cap } }
end

local OBJECT_PROPS = { "PrimaryPart", "Adornee", "Part0", "Part1", "Attachment0", "Attachment1" }
local function getConnectedInstances(path: string): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	local out = {}
	local seen: { [Instance]: boolean } = {}
	local function add(i: Instance?)
		if i and i ~= inst and not seen[i] then
			seen[i] = true
			table.insert(out, pathInfo(i))
		end
	end
	if inst:IsA("BasePart") then
		local ok, parts = pcall(function()
			return (inst :: any):GetConnectedParts(true)
		end)
		if ok and type(parts) == "table" then
			for _, part in ipairs(parts) do
				add(part)
			end
		end
	end
	local target = inst :: any
	for _, name in ipairs(OBJECT_PROPS) do
		local ok, val = pcall(function()
			return target[name]
		end)
		if ok and typeof(val) == "Instance" then
			add(val)
		end
	end
	return { ok = true, result = out }
end

local function compareInstances(pathA: string, pathB: string): any
	local ia, ib = resolvePath(pathA), resolvePath(pathB)
	if not ia or not ib then
		return { ok = false, err = "one or both paths not found" }
	end
	local diffs: { [string]: any } = {}
	local ta, tb = ia :: any, ib :: any
	for _, name in ipairs(CURATED_PROPS) do
		local oka, va = pcall(function()
			return ta[name]
		end)
		local okb, vb = pcall(function()
			return tb[name]
		end)
		if oka and okb and va ~= vb then
			diffs[name] = { a = Serializer.serialize(va), b = Serializer.serialize(vb) }
		end
	end
	return {
		ok = true,
		result = {
			a = ia:GetFullName(),
			b = ib:GetFullName(),
			classA = ia.ClassName,
			classB = ib.ClassName,
			differences = diffs,
		},
	}
end

local function getProjectStructure(): any
	local services = {}
	for _, child in ipairs(game:GetChildren()) do
		local byClass: { [string]: number } = {}
		for _, c in ipairs(child:GetChildren()) do
			byClass[c.ClassName] = (byClass[c.ClassName] or 0) + 1
		end
		table.insert(services, {
			name = child.Name,
			className = child.ClassName,
			childCount = #child:GetChildren(),
			childrenByClass = byClass,
		})
	end
	return { ok = true, result = { placeId = game.PlaceId, gameId = game.GameId, services = services } }
end

-- Nested tree of scripts (only branches that contain a LuaSourceContainer).
local function getFileTree(rootPath: string?): any
	local root = resolvePath(rootPath or "game") or game
	local function build(inst: Instance): any
		local node = {
			name = inst.Name,
			className = inst.ClassName,
			isScript = inst:IsA("LuaSourceContainer"),
			children = {} :: { any },
		}
		for _, c in ipairs(inst:GetChildren()) do
			local child = build(c)
			if child.isScript or #child.children > 0 then
				table.insert(node.children, child)
			end
		end
		return node
	end
	return { ok = true, result = build(root) }
end

local function setProperties(path: string, props: any): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	if type(props) ~= "table" then
		return { ok = false, err = "set_properties needs a 'properties' table" }
	end
	local set, failed = 0, {}
	local target = inst :: any
	local ok, ret = recorded("set_properties", function()
		for k, v in pairs(props) do
			local sok = pcall(function()
				target[k] = Serializer.deserialize(v)
			end)
			if sok then
				set += 1
			else
				table.insert(failed, k)
			end
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("set %d property(ies) on %s"):format(set, inst:GetFullName()), result = { set = set, failed = failed } }
end

-- Type-aware match. The MCP client can deliver top-level scalar args as STRINGS
-- ("true"/"0"), so a plain `val == want` never matches boolean/number properties.
-- Coerce `want` to the actual property value's type before comparing.
local function valueMatches(val: any, want: any): boolean
	if val == want then
		return true
	end
	local vt = type(val)
	if vt == "boolean" then
		return val == (want == true or want == "true")
	elseif vt == "number" then
		return val == tonumber(want)
	end
	return false
end

local function searchByProperty(p: any): any
	local property = p.property
	if not property then
		return { ok = false, err = "search_by_property: 'property' is required" }
	end
	local root = resolvePath(p.root or "game") or game
	local want = Serializer.deserialize(p.value)
	local limit = p.limit or 100
	local out = {}
	for _, inst in ipairs(root:GetDescendants()) do
		local ok, val = pcall(function()
			return (inst :: any)[property]
		end)
		if ok and valueMatches(val, want) then
			table.insert(out, pathInfo(inst))
			if #out >= limit then
				break
			end
		end
	end
	return { ok = true, result = out }
end

local function getTags(path: string): any
	local inst = resolvePath(path)
	if not inst then
		return { ok = false, err = "path not found: " .. path }
	end
	return { ok = true, result = { path = inst:GetFullName(), tags = CollectionService:GetTags(inst) } }
end

-- == Batch 6: assets / marketplace ==========================================
local function getAssetDetails(assetId: number): any
	local ok, info = pcall(function()
		return MarketplaceService:GetProductInfo(assetId)
	end)
	if not ok then
		return { ok = false, err = "GetProductInfo failed: " .. tostring(info) }
	end
	return { ok = true, result = info }
end

local function thumbId(assetId: number, size: number?): string
	local s = size or 420
	return ("rbxthumb://type=Asset&id=%d&w=%d&h=%d"):format(assetId, s, s)
end

local function getAssetThumbnail(assetId: number, size: number?): any
	return { ok = true, result = { assetId = assetId, thumbnail = thumbId(assetId, size) } }
end

local function previewAsset(assetId: number): any
	local details = getAssetDetails(assetId)
	if details.ok and type(details.result) == "table" then
		details.result.thumbnail = thumbId(assetId, 420)
	end
	return details
end

local function searchMaterials(query: string?): any
	local q = query and string.lower(query) or nil
	local out = {}
	for _, m in ipairs(Enum.Material:GetEnumItems()) do
		if not q or string.find(string.lower(m.Name), q, 1, true) then
			table.insert(out, m.Name)
		end
	end
	return { ok = true, result = out }
end

local function searchAssets(): any
	return {
		ok = false,
		err = "search_assets is not supported from a plugin: catalog/marketplace search needs the "
			.. "Roblox web / Open Cloud API. Use get_asset_details with a known assetId, or insert_asset.",
	}
end

local function listLibrary(): any
	return {
		ok = false,
		err = "list_library is not supported from a plugin: no API enumerates your inventory/library "
			.. "from edit. Use the Open Cloud / web API.",
	}
end

local function uploadDecal(): any
	return {
		ok = false,
		err = "upload_decal is not supported from a plugin: publishing an image asset requires Open "
			.. "Cloud Assets API credentials (an API key), which a Studio plugin cannot supply.",
	}
end

-- == Batch 7: input simulation (mostly restricted; honest where it is) =======
-- VirtualInputManager needs RobloxScriptSecurity; a normal plugin/game script
-- cannot access it, so SendKey/Mouse calls fail and we report that honestly.
local function getVIM(): any
	local ok, vim = pcall(function()
		return game:GetService("VirtualInputManager")
	end)
	return ok and vim or nil
end

local function simulateKeyboardInput(p: any): any
	local vim = getVIM()
	if not vim then
		return { ok = false, err = "simulate_keyboard_input: VirtualInputManager is not accessible (RobloxScriptSecurity)." }
	end
	local ok, err = pcall(function()
		local keyCode = (Enum.KeyCode :: any)[p.key]
		local action = p.action or "press"
		if action ~= "up" then
			vim:SendKeyEvent(true, keyCode, false, game)
		end
		if action ~= "down" then
			vim:SendKeyEvent(false, keyCode, false, game)
		end
	end)
	if not ok then
		return { ok = false, err = "SendKeyEvent failed (VirtualInputManager is restricted from this context): " .. tostring(err) }
	end
	return { ok = true, output = "sent key " .. tostring(p.key) }
end

local function simulateMouseInput(p: any): any
	local vim = getVIM()
	if not vim then
		return { ok = false, err = "simulate_mouse_input: VirtualInputManager is not accessible (RobloxScriptSecurity)." }
	end
	local ok, err = pcall(function()
		local x, y = p.x or 0, p.y or 0
		local action = p.action or "move"
		if action == "move" then
			vim:SendMouseMoveEvent(x, y, game)
		else
			local button = p.button or 0
			vim:SendMouseButtonEvent(x, y, button, action == "down", game, 1)
		end
	end)
	if not ok then
		return { ok = false, err = "SendMouseEvent failed (VirtualInputManager is restricted from this context): " .. tostring(err) }
	end
	return { ok = true, output = "sent mouse " .. tostring(p.action or "move") }
end

local function characterNavigation(p: any): any
	if not RunService:IsRunning() then
		return {
			ok = false,
			err = "character_navigation needs a running playtest (no player character exists in edit). "
				.. "Run during F5 so the runtime agent handles it.",
		}
	end
	local Players = game:GetService("Players")
	local player = Players:GetPlayers()[1]
	if not player or not player.Character then
		return { ok = false, err = "character_navigation: no player character in the running game" }
	end
	local hum = player.Character:FindFirstChildOfClass("Humanoid")
	if not hum then
		return { ok = false, err = "character_navigation: player has no Humanoid" }
	end
	local target = Serializer.deserialize(p.position)
	if typeof(target) ~= "Vector3" then
		return { ok = false, err = "character_navigation needs a Vector3 'position'" }
	end
	hum:MoveTo(target)
	return { ok = true, output = ("moving character toward (%.1f, %.1f, %.1f)"):format(target.X, target.Y, target.Z) }
end

-- == Task 16 Batch A: build / scene / UI tree / file search =================
-- A "build" = { className, name, properties?, attributes?, tags?, children:[...] }.
local function serializeBuild(inst: Instance, depth: number, maxDepth: number): any
	local node: any = { className = inst.ClassName, name = inst.Name }
	local props: { [string]: any } = {}
	local target = inst :: any
	for _, name in ipairs(CURATED_PROPS) do
		local ok, val = pcall(function()
			return target[name]
		end)
		-- skip Instance-valued props: they reference other instances and don't
		-- round-trip through a self-contained build JSON.
		if ok and val ~= nil and typeof(val) ~= "Instance" then
			props[name] = Serializer.serialize(val)
		end
	end
	if next(props) then
		node.properties = props
	end
	local attrs: { [string]: any } = {}
	for k, v in pairs(inst:GetAttributes()) do
		attrs[k] = Serializer.serialize(v)
	end
	if next(attrs) then
		node.attributes = attrs
	end
	local tags = CollectionService:GetTags(inst)
	if #tags > 0 then
		node.tags = tags
	end
	if depth < maxDepth then
		local children = {}
		for _, c in ipairs(inst:GetChildren()) do
			table.insert(children, serializeBuild(c, depth + 1, maxDepth))
		end
		if #children > 0 then
			node.children = children
		end
	end
	return node
end

local function exportBuild(p: any): any
	local inst = resolvePath(p.path)
	if not inst then
		return { ok = false, err = "path not found: " .. tostring(p.path) }
	end
	local maxDepth = p.maxDepth and math.floor(p.maxDepth) or 8
	return { ok = true, result = serializeBuild(inst, 0, maxDepth) }
end

local function createBuild(p: any): any
	local res = exportBuild(p)
	if not res.ok then
		return res
	end
	return { ok = true, result = { kind = "build", name = p.name or res.result.name, build = res.result } }
end

-- Recursively instantiate a build node under parent. Properties/attributes via
-- Serializer.deserialize (best-effort, pcall-guarded); tags via CollectionService.
local function instantiateBuild(node: any, parent: Instance): Instance
	local inst = Instance.new(node.className)
	if node.name then
		inst.Name = node.name
	end
	if type(node.properties) == "table" then
		local target = inst :: any
		for k, v in pairs(node.properties) do
			pcall(function()
				target[k] = Serializer.deserialize(v)
			end)
		end
	end
	if type(node.attributes) == "table" then
		for k, v in pairs(node.attributes) do
			pcall(function()
				inst:SetAttribute(k, Serializer.deserialize(v))
			end)
		end
	end
	if type(node.tags) == "table" then
		for _, tg in ipairs(node.tags) do
			pcall(function()
				CollectionService:AddTag(inst, tostring(tg))
			end)
		end
	end
	inst.Parent = parent
	if type(node.children) == "table" then
		for _, child in ipairs(node.children) do
			instantiateBuild(child, inst)
		end
	end
	return inst
end

local function importBuild(p: any): any
	if type(p.build) ~= "table" or not p.build.className then
		return { ok = false, err = "import_build needs a 'build' object with a className" }
	end
	local parent = resolvePath(p.parentPath)
	if not parent then
		return { ok = false, err = "parent path not found: " .. tostring(p.parentPath) }
	end
	local ok, ret = recorded("import_build", function()
		local b = p.build
		if p.name then
			b = table.clone(b)
			b.name = p.name
		end
		return instantiateBuild(b, parent)
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = "imported build under " .. parent:GetFullName(), result = pathInfo(ret) }
end

-- Compact high-level generators (distinct from import_build's literal JSON).
local function generateBuild(p: any): any
	local spec = p.spec
	if type(spec) ~= "table" or not spec.kind then
		return { ok = false, err = "generate_build needs a 'spec' with a 'kind' (grid|baseplate)" }
	end
	if spec.kind == "baseplate" then
		local ok, ret = recorded("generate_build:baseplate", function()
			local base = Instance.new("Part")
			base.Name = spec.name or "Baseplate"
			base.Anchored = true
			base.Size = Vector3.new(512, 16, 512)
			base.Position = Vector3.new(0, -8, 0)
			base.BrickColor = BrickColor.new("Dark green")
			base.Material = Enum.Material.Grass
			base.TopSurface = Enum.SurfaceType.Smooth
			base.Parent = workspace
			return base
		end)
		if not ok then
			return { ok = false, err = tostring(ret) }
		end
		return { ok = true, output = "created baseplate", result = pathInfo(ret) }
	elseif spec.kind == "grid" then
		local parent = resolvePath(spec.parentPath or "game.Workspace") or workspace
		local className = spec.className or "Part"
		local rows = math.max(1, math.floor(spec.rows or 1))
		local cols = math.max(1, math.floor(spec.cols or 1))
		local spacing = spec.spacing ~= nil and Serializer.deserialize(spec.spacing) or Vector3.new(8, 0, 8)
		if typeof(spacing) ~= "Vector3" then
			spacing = Vector3.new(8, 0, 8)
		end
		local made = {}
		local ok, ret = recorded("generate_build:grid", function()
			for r = 0, rows - 1 do
				for c = 0, cols - 1 do
					local inst = Instance.new(className)
					if type(spec.properties) == "table" then
						local target = inst :: any
						for k, v in pairs(spec.properties) do
							pcall(function()
								target[k] = Serializer.deserialize(v)
							end)
						end
					end
					if inst:IsA("BasePart") then
						pcall(function()
							local part = inst :: any
							part.Anchored = true
							part.Position = Vector3.new(spacing.X * c, spacing.Y, spacing.Z * r)
						end)
					end
					inst.Parent = parent
					table.insert(made, pathInfo(inst))
				end
			end
		end)
		if not ok then
			return { ok = false, err = tostring(ret) }
		end
		return { ok = true, output = ("generated %d instance(s) in a %dx%d grid"):format(#made, rows, cols), result = made }
	end
	return { ok = false, err = "generate_build: unknown spec.kind '" .. tostring(spec.kind) .. "' (supported: grid, baseplate)" }
end

-- == Task 20: create_keyframe_sequence (animation build) ====================
-- Resolve an Enum item by name; fall back to `default` for missing/bad names
-- (per spec: never reject the whole call over one bad enum string).
local function enumOr(enumType: Enum, name: any, default: EnumItem): EnumItem
	if type(name) == "string" then
		local ok, item = pcall(function()
			return (enumType :: any)[name]
		end)
		if ok and typeof(item) == "EnumItem" then
			return item
		end
	end
	return default
end

-- Deserialize a tagged CFrame value; returns nil if it is not actually a CFrame.
local function toCFrame(v: any): CFrame?
	local ok, cf = pcall(function()
		return Serializer.deserialize(v)
	end)
	if ok and typeof(cf) == "CFrame" then
		return cf
	end
	return nil
end

local function createKeyframeSequence(p: any): any
	local kfs = p.keyframes
	if type(kfs) ~= "table" then
		return { ok = false, err = "create_keyframe_sequence needs a 'keyframes' array" }
	end
	local kfCount = #kfs
	if kfCount < 1 or kfCount > 240 then
		return { ok = false, err = "keyframes count out of range (1-240): " .. tostring(kfCount) }
	end
	-- Destination is a shared folder so the built sequence is easy to find and
	-- MANUALLY upload (right-click -> Save to Roblox, or open in the Animation
	-- Editor). Default base = ServerStorage; parentPath overrides the base if given.
	local baseParent
	if type(p.parentPath) == "string" and p.parentPath ~= "" then
		baseParent = resolvePath(p.parentPath)
		if not baseParent then
			return { ok = false, err = "path not found: " .. tostring(p.parentPath) }
		end
	else
		baseParent = game:GetService("ServerStorage")
	end
	local folderName = (type(p.folderName) == "string" and p.folderName ~= "") and p.folderName or "GeneratedAnimations"
	-- Validate EVERYTHING before creating anything (no partial writes).
	for i, kf in ipairs(kfs) do
		if type(kf) ~= "table" then
			return { ok = false, err = ("keyframe[%d]: not an object"):format(i) }
		end
		local t = kf.time
		if type(t) ~= "number" or t ~= t or t == math.huge or t == -math.huge or t < 0 then
			return { ok = false, err = ("keyframe[%d]: time must be finite and >= 0"):format(i) }
		end
		local poses = kf.poses
		if type(poses) ~= "table" then
			return { ok = false, err = ("keyframe[%d]: needs a 'poses' array"):format(i) }
		end
		local poseCount = #poses
		if poseCount < 1 or poseCount > 100 then
			return { ok = false, err = ("keyframe[%d]: poses count out of range (1-100): %d"):format(i, poseCount) }
		end
		local names: { [string]: boolean } = {}
		for j, pose in ipairs(poses) do
			if type(pose) ~= "table" or type(pose.part) ~= "string" or pose.part == "" then
				return { ok = false, err = ("keyframe[%d].pose[%d]: missing 'part' name"):format(i, j) }
			end
			if not toCFrame(pose.cframe) then
				return { ok = false, err = ("keyframe[%d].pose[%d]: invalid cframe"):format(i, j) }
			end
			names[pose.part] = true
		end
		-- parentPart must reference another pose.part in the SAME keyframe.
		for j, pose in ipairs(poses) do
			if pose.parentPart ~= nil then
				if type(pose.parentPart) ~= "string" or not names[pose.parentPart] then
					return {
						ok = false,
						err = ("keyframe[%d].pose[%d]: parentPart '%s' not found in this keyframe"):format(
							i,
							j,
							tostring(pose.parentPart)
						),
					}
				end
				if pose.parentPart == pose.part then
					return { ok = false, err = ("keyframe[%d].pose[%d]: parentPart cannot reference itself"):format(i, j) }
				end
			end
		end
	end

	local priority = enumOr(Enum.AnimationPriority, p.priority, Enum.AnimationPriority.Action)
	-- Whole build + (optional) preview registration in ONE undo waypoint.
	local ok, ret = recorded("create_keyframe_sequence", function()
		local seq = Instance.new("KeyframeSequence")
		seq.Name = (type(p.name) == "string" and p.name ~= "") and p.name or "Animation"
		seq.Loop = p.loop == true
		seq.Priority = priority
		local poseTotal = 0
		for i, kf in ipairs(kfs) do
			local keyframe = Instance.new("Keyframe")
			keyframe.Time = kf.time
			keyframe.Name = (type(kf.name) == "string" and kf.name ~= "") and kf.name or ("Keyframe" .. tostring(i))
			-- Build ALL poses before parenting any, so parentPart lookups resolve.
			local byName: { [string]: Instance } = {}
			local built: { { inst: Instance, parentPart: any } } = {}
			for _, pose in ipairs(kf.poses) do
				local pInst = Instance.new("Pose")
				pInst.Name = pose.part
				pInst.CFrame = toCFrame(pose.cframe) :: CFrame
				pInst.Weight = type(pose.weight) == "number" and pose.weight or 1
				pInst.EasingStyle = enumOr(Enum.PoseEasingStyle, pose.easingStyle, Enum.PoseEasingStyle.Linear)
				pInst.EasingDirection = enumOr(Enum.PoseEasingDirection, pose.easingDirection, Enum.PoseEasingDirection.In)
				byName[pose.part] = pInst
				table.insert(built, { inst = pInst, parentPart = pose.parentPart })
				poseTotal += 1
			end
			for _, b in ipairs(built) do
				if type(b.parentPart) == "string" then
					b.inst.Parent = byName[b.parentPart]
				else
					b.inst.Parent = keyframe
				end
			end
			keyframe.Parent = seq
		end
		-- Get-or-create the collection folder under the base, then park the KFS in it.
		local folder = baseParent:FindFirstChild(folderName)
		if not folder or not folder:IsA("Folder") then
			folder = Instance.new("Folder")
			folder.Name = folderName
			folder.Parent = baseParent
		end
		seq.Parent = folder
		local regId, regErr
		if p.registerPreview ~= false then
			local okReg, idOrErr = pcall(function()
				return game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(seq)
			end)
			if okReg then
				regId = tostring(idOrErr)
			else
				regErr = tostring(idOrErr)
			end
		end
		return { seq = seq, folder = folder, poseCount = poseTotal, regId = regId, regErr = regErr }
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	local seq = ret.seq
	local result: any = { path = seq:GetFullName(), keyframeCount = kfCount, poseCount = ret.poseCount }
	local output = "created KeyframeSequence in " .. ret.folder:GetFullName() .. " (ready for manual upload)"
	if ret.regId then
		result.tempAnimationId = ret.regId
	elseif ret.regErr then
		output = output .. " (preview registration failed: " .. ret.regErr .. ")"
	end
	return { ok = true, output = output, result = result }
end

-- == Task 22: create_sound / set_lighting (edit-context wrappers) =============
-- Coerce "rbxassetid://<n>" | "<n>" | <number> -> a canonical content id, else nil.
local function coerceAssetId(raw: any): string?
	if type(raw) == "number" then
		return "rbxassetid://" .. tostring(math.floor(raw))
	elseif type(raw) == "string" and raw ~= "" then
		if string.match(raw, "^%d+$") then
			return "rbxassetid://" .. raw
		end
		return raw
	end
	return nil
end

local ROLLOFF_MODES: { [string]: boolean } =
	{ Inverse = true, Linear = true, LinearSquare = true, InverseTapered = true }

local function createSound(p: any): any
	local parent = resolvePath(p.parentPath)
	if not parent then
		return { ok = false, err = "path not found: " .. tostring(p.parentPath) }
	end
	local soundId = coerceAssetId(p.soundId)
	if not soundId then
		return { ok = false, err = "create_sound: invalid soundId" }
	end
	local ok, ret = recorded("create_sound", function()
		local s = Instance.new("Sound")
		s.Name = (type(p.name) == "string" and p.name ~= "") and p.name or "Sound"
		s.SoundId = soundId
		local vol = type(p.volume) == "number" and p.volume or 0.5
		s.Volume = math.clamp(vol, 0, 10)
		if type(p.looped) == "boolean" then
			s.Looped = p.looped
		end
		if type(p.playbackSpeed) == "number" then
			s.PlaybackSpeed = p.playbackSpeed
		end
		if type(p.rollOffMode) == "string" and ROLLOFF_MODES[p.rollOffMode] then
			s.RollOffMode = (Enum.RollOffMode :: any)[p.rollOffMode]
		end
		if type(p.rollOffMinDistance) == "number" then
			s.RollOffMinDistance = p.rollOffMinDistance
		end
		if type(p.rollOffMaxDistance) == "number" then
			s.RollOffMaxDistance = p.rollOffMaxDistance
		end
		s.Parent = parent
		if p.playOnCreate == true then
			pcall(function()
				s:Play()
			end)
		end
		return s
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = "created Sound under " .. parent:GetFullName(), result = { path = ret:GetFullName() } }
end

local LIGHTING_EFFECT_CLASSES: { [string]: boolean } = {
	Atmosphere = true,
	Sky = true,
	BloomEffect = true,
	ColorCorrectionEffect = true,
	DepthOfFieldEffect = true,
	SunRaysEffect = true,
}

local function setLighting(p: any): any
	local Lighting = game:GetService("Lighting")
	local props = p.properties
	local effects = p.effects
	if props ~= nil and type(props) ~= "table" then
		return { ok = false, err = "set_lighting: 'properties' must be an object" }
	end
	if effects ~= nil and type(effects) ~= "table" then
		return { ok = false, err = "set_lighting: 'effects' must be an object" }
	end
	-- Phase 1: validate ALL keys/classes before any write (no partial commit). A real
	-- property is readable; an unknown key errors the read. Effect classes are
	-- whitelisted; effect prop names are validated against a scratch instance.
	local lt = Lighting :: any
	if type(props) == "table" then
		for key in pairs(props) do
			local okRead = pcall(function()
				return lt[key]
			end)
			if not okRead then
				return { ok = false, err = "set_lighting: unknown Lighting property '" .. tostring(key) .. "'" }
			end
		end
	end
	if type(effects) == "table" then
		for className, pmap in pairs(effects) do
			if not LIGHTING_EFFECT_CLASSES[className] then
				return { ok = false, err = "set_lighting: unknown effect class '" .. tostring(className) .. "'" }
			end
			if type(pmap) == "table" then
				local sample = Lighting:FindFirstChildOfClass(className)
				local scratch = nil
				if not sample then
					scratch = Instance.new(className)
					sample = scratch
				end
				local st = sample :: any
				for key in pairs(pmap) do
					local okRead = pcall(function()
						return st[key]
					end)
					if not okRead then
						if scratch then
							scratch:Destroy()
						end
						return { ok = false, err = "set_lighting: unknown " .. className .. " property '" .. tostring(key) .. "'" }
					end
				end
				if scratch then
					scratch:Destroy()
				end
			end
		end
	end
	-- Phase 2: apply, all validated -> single undo.
	local applied = {}
	local effectsApplied = {}
	local ok, ret = recorded("set_lighting", function()
		if type(props) == "table" then
			for key, raw in pairs(props) do
				lt[key] = Serializer.deserialize(raw)
				table.insert(applied, key)
			end
		end
		if type(effects) == "table" then
			for className, pmap in pairs(effects) do
				local inst = Lighting:FindFirstChildOfClass(className)
				if not inst then
					inst = Instance.new(className)
					inst.Parent = Lighting
				end
				local it = inst :: any
				if type(pmap) == "table" then
					for key, raw in pairs(pmap) do
						it[key] = Serializer.deserialize(raw)
					end
				end
				table.insert(effectsApplied, className)
			end
		end
		return true
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, result = { applied = applied, effects = effectsApplied } }
end

-- Multi-root scene import. scene = { roots: [ { parentPath, build } ] } (a bare
-- array is also accepted). mode='replace' clears each parent first (gated by confirm).
local function importScene(p: any): any
	local scene = p.scene
	local roots: any = nil
	if type(scene) == "table" then
		if type(scene.roots) == "table" then
			roots = scene.roots
		elseif scene[1] ~= nil then
			roots = scene
		end
	end
	if type(roots) ~= "table" then
		return { ok = false, err = "import_scene needs a 'scene' with roots[] of { parentPath, build }" }
	end
	local mode = p.mode or "merge"
	if mode == "replace" and p.confirm ~= true then
		return {
			ok = false,
			err = "import_scene mode='replace' is destructive (clears each target parent's children first); "
				.. "pass confirm:true to proceed.",
		}
	end
	local created, failed = {}, {}
	local ok, ret = recorded("import_scene", function()
		for _, entry in ipairs(roots) do
			local parent = resolvePath(entry.parentPath)
			if not parent then
				table.insert(failed, { parentPath = entry.parentPath, err = "parent not found" })
				continue
			end
			if mode == "replace" then
				for _, c in ipairs(parent:GetChildren()) do
					pcall(function()
						c:Destroy()
					end)
				end
			end
			if type(entry.build) == "table" and entry.build.className then
				local cok, cret = pcall(function()
					return instantiateBuild(entry.build, parent)
				end)
				if cok then
					table.insert(created, pathInfo(cret))
				else
					table.insert(failed, { parentPath = entry.parentPath, err = tostring(cret) })
				end
			else
				table.insert(failed, { parentPath = entry.parentPath, err = "entry has no build.className" })
			end
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return {
		ok = true,
		output = ("imported %d root(s), %d failed"):format(#created, #failed),
		result = { created = created, failed = failed },
	}
end

-- Build a GUI hierarchy. Default parent = a fresh ScreenGui in StarterGui.
local function createUiTree(p: any): any
	if type(p.tree) ~= "table" or not p.tree.className then
		return { ok = false, err = "create_ui_tree needs a 'tree' object with a className" }
	end
	local ok, ret = recorded("create_ui_tree", function()
		local parent: Instance
		if p.parentPath then
			local resolved = resolvePath(p.parentPath)
			if not resolved then
				error("parent path not found: " .. tostring(p.parentPath))
			end
			parent = resolved
		else
			local sg = Instance.new("ScreenGui")
			sg.Name = (p.tree.name and tostring(p.tree.name) .. "Gui") or "McpScreenGui"
			sg.ResetOnSpawn = false
			sg.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
			sg.Parent = game:GetService("StarterGui")
			parent = sg
		end
		return instantiateBuild(p.tree, parent)
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = "built UI tree at " .. ret:GetFullName(), result = pathInfo(ret) }
end

-- Match instance names AND full paths (distinct from grep_scripts = content).
local function searchFiles(p: any): any
	local pattern = p.pattern
	if not pattern or pattern == "" then
		return { ok = false, err = "search_files: 'pattern' is required" }
	end
	local root = resolvePath(p.root or "game") or game
	local useRegex = p.regex == true
	local needle = useRegex and pattern or string.lower(pattern)
	local limit = p.limit or 500
	local out = {}
	local function hit(s: string): boolean
		if useRegex then
			return string.find(s, pattern) ~= nil
		end
		return string.find(string.lower(s), needle, 1, true) ~= nil
	end
	for _, inst in ipairs(root:GetDescendants()) do
		if hit(inst.Name) or hit(inst:GetFullName()) then
			table.insert(out, pathInfo(inst))
			if #out >= limit then
				break
			end
		end
	end
	return { ok = true, result = { matches = out, truncated = #out >= limit } }
end

-- == Task 16 Batch B: raycast / bounds / camera / perf / group / align =======
-- Coerce an [x,y,z] array (or a serialized/tagged Vector3) to a Vector3.
local function arrToV3(a: any): Vector3?
	if typeof(a) == "Vector3" then
		return a
	end
	if type(a) ~= "table" then
		return nil
	end
	if a.__t == "Vector3" then
		return Serializer.deserialize(a)
	end
	local x = a[1] or a.x
	local y = a[2] or a.y
	local z = a[3] or a.z
	if x and y and z then
		return Vector3.new(x, y, z)
	end
	return nil
end

local function axisGet(v: Vector3, comp: string): number
	if comp == "X" then
		return v.X
	elseif comp == "Y" then
		return v.Y
	end
	return v.Z
end

local function axisVector(comp: string, v: number): Vector3
	if comp == "X" then
		return Vector3.new(v, 0, 0)
	elseif comp == "Y" then
		return Vector3.new(0, v, 0)
	end
	return Vector3.new(0, 0, v)
end

local function raycastCmd(p: any): any
	local origin = arrToV3(p.origin)
	local dir = arrToV3(p.direction)
	if not origin or not dir then
		return { ok = false, err = "raycast needs origin:[x,y,z] and direction:[x,y,z]" }
	end
	if dir.Magnitude == 0 then
		return { ok = false, err = "raycast direction cannot be zero" }
	end
	local maxDist = p.maxDistance or 1000
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	local ignore = {}
	if type(p.ignorePaths) == "table" then
		for _, ip in ipairs(p.ignorePaths) do
			local inst = resolvePath(ip)
			if inst then
				table.insert(ignore, inst)
			end
		end
	end
	params.FilterDescendantsInstances = ignore
	local result = workspace:Raycast(origin, dir.Unit * maxDist, params)
	if not result then
		return { ok = true, result = { hit = false } }
	end
	return {
		ok = true,
		result = {
			hit = true,
			hitPath = result.Instance and result.Instance:GetFullName() or nil,
			position = Serializer.serialize(result.Position),
			normal = Serializer.serialize(result.Normal),
			material = result.Material.Name,
			distance = result.Distance,
		},
	}
end

local function boundsOf(inst: Instance): (CFrame?, Vector3?)
	if inst:IsA("Model") then
		local cf, size
		local ok = pcall(function()
			cf, size = (inst :: any):GetBoundingBox()
		end)
		if ok then
			return cf, size
		end
		return nil, nil
	elseif inst:IsA("BasePart") then
		return (inst :: any).CFrame, (inst :: any).Size
	end
	return nil, nil
end

local function getBoundingBox(p: any): any
	local inst = resolvePath(p.path)
	if not inst then
		return { ok = false, err = "path not found: " .. tostring(p.path) }
	end
	local cf, size = boundsOf(inst)
	if not cf or not size then
		return { ok = false, err = p.path .. " is not a Model or BasePart (no bounding box)" }
	end
	return {
		ok = true,
		result = { path = inst:GetFullName(), cframe = Serializer.serialize(cf), size = Serializer.serialize(size) },
	}
end

-- World-space AABB expansion over a part's 8 corners.
local function expandAabb(min: Vector3, max: Vector3, cf: CFrame, size: Vector3): (Vector3, Vector3)
	local hs = size / 2
	for sx = -1, 1, 2 do
		for sy = -1, 1, 2 do
			for sz = -1, 1, 2 do
				local wp = cf * Vector3.new(hs.X * sx, hs.Y * sy, hs.Z * sz)
				min = Vector3.new(math.min(min.X, wp.X), math.min(min.Y, wp.Y), math.min(min.Z, wp.Z))
				max = Vector3.new(math.max(max.X, wp.X), math.max(max.Y, wp.Y), math.max(max.Z, wp.Z))
			end
		end
	end
	return min, max
end

local function collectParts(insts: { Instance }): { BasePart }
	local parts = {}
	for _, inst in ipairs(insts) do
		if inst:IsA("BasePart") then
			table.insert(parts, inst)
		end
		for _, d in ipairs(inst:GetDescendants()) do
			if d:IsA("BasePart") then
				table.insert(parts, d)
			end
		end
	end
	return parts
end

local function getSelectionBounds(): any
	local sel = Selection:Get()
	if #sel == 0 then
		return { ok = false, err = "get_selection_bounds: selection is empty" }
	end
	local parts = collectParts(sel)
	if #parts == 0 then
		return { ok = false, err = "get_selection_bounds: selection contains no BaseParts" }
	end
	local min = Vector3.new(math.huge, math.huge, math.huge)
	local max = Vector3.new(-math.huge, -math.huge, -math.huge)
	for _, part in ipairs(parts) do
		min, max = expandAabb(min, max, (part :: any).CFrame, (part :: any).Size)
	end
	local center = (min + max) / 2
	return {
		ok = true,
		result = {
			partCount = #parts,
			center = Serializer.serialize(center),
			size = Serializer.serialize(max - min),
			min = Serializer.serialize(min),
			max = Serializer.serialize(max),
		},
	}
end

local function getCamera(): any
	local cam = workspace.CurrentCamera
	if not cam then
		return { ok = false, err = "no CurrentCamera in this context" }
	end
	return {
		ok = true,
		result = {
			cframe = Serializer.serialize(cam.CFrame),
			position = Serializer.serialize(cam.CFrame.Position),
			fieldOfView = cam.FieldOfView,
		},
	}
end

-- View-only (not a place mutation): kept OUT of WRITE_TOOLS so read-only sessions
-- can still aim the camera.
local function setCamera(p: any): any
	local cam = workspace.CurrentCamera
	if not cam then
		return { ok = false, err = "no CurrentCamera in this context" }
	end
	local ok, err = pcall(function()
		if p.cframe ~= nil then
			cam.CFrame = Serializer.deserialize(p.cframe)
		elseif p.position ~= nil then
			local pos = arrToV3(p.position)
			if not pos then
				error("set_camera: invalid position")
			end
			if p.lookAt ~= nil then
				local look = arrToV3(p.lookAt)
				if not look then
					error("set_camera: invalid lookAt")
				end
				cam.CFrame = CFrame.lookAt(pos, look)
			else
				cam.CFrame = CFrame.new(pos)
			end
		else
			error("set_camera needs cframe, or position (+ optional lookAt)")
		end
	end)
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	return { ok = true, output = "moved camera", result = { cframe = Serializer.serialize(cam.CFrame) } }
end

local function focusInstance(p: any): any
	local inst = resolvePath(p.path)
	if not inst then
		return { ok = false, err = "path not found: " .. tostring(p.path) }
	end
	local ok, ret = recorded("focus_instance", function()
		Selection:Set({ inst })
	end)
	-- aim the camera at the instance (view change, outside the undo recording)
	local cam = workspace.CurrentCamera
	if cam then
		local cf, size = boundsOf(inst)
		if cf and size then
			local radius = math.max(size.X, size.Y, size.Z, 1)
			local dist = radius * 2 + 5
			local pos = cf.Position + Vector3.new(1, 1, 1).Unit * dist
			pcall(function()
				cam.CFrame = CFrame.lookAt(pos, cf.Position)
			end)
		end
	end
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = "focused " .. inst:GetFullName(), result = pathInfo(inst) }
end

local function getPerfStats(): any
	local totalMem: any = nil
	pcall(function()
		totalMem = Stats:GetTotalMemoryUsageMb()
	end)
	local instanceCount, partCount, scriptCount = 0, 0, 0
	for _, d in ipairs(game:GetDescendants()) do
		instanceCount += 1
		if d:IsA("BasePart") then
			partCount += 1
		elseif d:IsA("LuaSourceContainer") then
			scriptCount += 1
		end
	end
	return {
		ok = true,
		result = {
			totalMemoryMb = totalMem,
			instanceCount = instanceCount,
			partCount = partCount,
			scriptCount = scriptCount,
		},
	}
end

local function groupInstances(p: any): any
	local paths = p.paths
	if type(paths) ~= "table" or #paths == 0 then
		return { ok = false, err = "group_instances needs a non-empty 'paths' array" }
	end
	local insts = {}
	local commonParent: Instance? = nil
	for _, path in ipairs(paths) do
		local inst = resolvePath(path)
		if inst then
			table.insert(insts, inst)
			if not commonParent then
				commonParent = inst.Parent
			end
		end
	end
	if #insts == 0 then
		return { ok = false, err = "group_instances: no valid instances at the given paths" }
	end
	local ok, ret = recorded("group_instances", function()
		local model = Instance.new("Model")
		model.Name = p.name or "Group"
		model.Parent = commonParent or workspace
		for _, inst in ipairs(insts) do
			inst.Parent = model
		end
		for _, inst in ipairs(insts) do
			if inst:IsA("BasePart") then
				model.PrimaryPart = inst
				break
			end
		end
		return model
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("grouped %d instance(s)"):format(#insts), result = pathInfo(ret) }
end

local function ungroupInstance(p: any): any
	local inst = resolvePath(p.path)
	if not inst then
		return { ok = false, err = "path not found: " .. tostring(p.path) }
	end
	if not (inst:IsA("Model") or inst:IsA("Folder")) then
		return { ok = false, err = "ungroup_instance target must be a Model or Folder (got " .. inst.ClassName .. ")" }
	end
	local parent = inst.Parent
	if not parent then
		return { ok = false, err = "cannot ungroup the root" }
	end
	local moved = {}
	local ok, ret = recorded("ungroup_instance", function()
		for _, c in ipairs(inst:GetChildren()) do
			c.Parent = parent
			table.insert(moved, pathInfo(c))
		end
		inst:Destroy()
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("ungrouped %d child(ren)"):format(#moved), result = moved }
end

local AXIS_INDEX = { x = "X", y = "Y", z = "Z" }
local function alignInstances(p: any): any
	local axisKey = string.lower(tostring(p.axis or ""))
	local comp = AXIS_INDEX[axisKey]
	if not comp then
		return { ok = false, err = "align_instances needs axis 'x', 'y', or 'z'" }
	end
	local mode = p.mode or "center"
	local paths = p.paths
	if type(paths) ~= "table" or #paths < 2 then
		return { ok = false, err = "align_instances needs at least 2 'paths'" }
	end
	local items = {}
	for _, path in ipairs(paths) do
		local inst = resolvePath(path)
		if inst and inst:IsA("PVInstance") then
			local pivot = (inst :: any):GetPivot()
			table.insert(items, { inst = inst, v = axisGet(pivot.Position, comp) })
		end
	end
	if #items < 2 then
		return { ok = false, err = "align_instances needs at least 2 PVInstances (parts/models)" }
	end
	local count = 0
	local ok, ret = recorded("align_instances", function()
		if mode == "distribute" then
			table.sort(items, function(a, b)
				return a.v < b.v
			end)
			local startV = items[1].v
			local spacing = p.spacing and tonumber(p.spacing) or nil
			local endV = items[#items].v
			for i, it in ipairs(items) do
				local targetV
				if spacing then
					targetV = startV + spacing * (i - 1)
				else
					targetV = startV + (endV - startV) * ((i - 1) / (#items - 1))
				end
				local delta = targetV - it.v
				if math.abs(delta) > 1e-6 then
					local target = it.inst :: any
					target:PivotTo(target:GetPivot() + axisVector(comp, delta))
					count += 1
				end
			end
		else
			local ref
			if mode == "min" then
				ref = math.huge
				for _, it in ipairs(items) do
					ref = math.min(ref, it.v)
				end
			elseif mode == "max" then
				ref = -math.huge
				for _, it in ipairs(items) do
					ref = math.max(ref, it.v)
				end
			else
				local sum = 0
				for _, it in ipairs(items) do
					sum += it.v
				end
				ref = sum / #items
			end
			for _, it in ipairs(items) do
				local delta = ref - it.v
				if math.abs(delta) > 1e-6 then
					local target = it.inst :: any
					target:PivotTo(target:GetPivot() + axisVector(comp, delta))
					count += 1
				end
			end
		end
	end)
	if not ok then
		return { ok = false, err = tostring(ret) }
	end
	return { ok = true, output = ("aligned %d instance(s) on %s (%s)"):format(count, axisKey, mode), result = { moved = count } }
end

local function measureDistance(p: any): any
	local ia, ib = resolvePath(p.pathA), resolvePath(p.pathB)
	if not ia or not ib then
		return { ok = false, err = "measure_distance: one or both paths not found" }
	end
	local function pivotPos(inst: Instance): Vector3?
		if inst:IsA("PVInstance") then
			local ok, piv = pcall(function()
				return (inst :: any):GetPivot()
			end)
			if ok then
				return piv.Position
			end
		end
		return nil
	end
	local pa, pb = pivotPos(ia), pivotPos(ib)
	if not pa or not pb then
		return { ok = false, err = "measure_distance: both instances must be PVInstances (parts/models)" }
	end
	return {
		ok = true,
		result = {
			distance = (pa - pb).Magnitude,
			a = ia:GetFullName(),
			b = ib:GetFullName(),
			positionA = Serializer.serialize(pa),
			positionB = Serializer.serialize(pb),
		},
	}
end

-- Dispatch one command table -> result table.
-- (enable_playtest_agent is handled in the plugin entry, not here.)
function Executor.execute(cmd: { type: string, payload: any }): any
	local p = cmd.payload or {}
	if cmd.type == "run_luau" then
		return runLuau(p.code)
	elseif cmd.type == "get_instance_tree" then
		return getInstanceTree(p.path or "game", p.maxDepth or 4)
	elseif cmd.type == "set_property" then
		return setProperty(p.path, p.property, p.value)
	elseif cmd.type == "write_script" then
		return writeScript(p.path, p.source, p.className)
	-- read / inspect
	elseif cmd.type == "read_console" then
		return readConsole(p.count or 100, p.levelFilter)
	elseif cmd.type == "get_selection" then
		return getSelection()
	elseif cmd.type == "search_instances" then
		return searchInstances(p)
	elseif cmd.type == "get_script_source" then
		return getScriptSource(p.path)
	elseif cmd.type == "list_scripts" then
		return listScripts(p.root or "game")
	elseif cmd.type == "get_place_info" then
		return getPlaceInfo()
	elseif cmd.type == "get_tagged" then
		return getTagged(p.tag)
	elseif cmd.type == "get_properties" then
		return getProperties(p.path, p.propertyNames)
	-- write / edit
	elseif cmd.type == "set_selection" then
		return setSelection(p.paths or {})
	elseif cmd.type == "create_instance" then
		return createInstance(p)
	elseif cmd.type == "delete_instance" then
		return deleteInstance(p.path)
	elseif cmd.type == "clone_instance" then
		return cloneInstance(p.path, p.parentPath)
	elseif cmd.type == "rename_instance" then
		return renameInstance(p.path, p.name)
	elseif cmd.type == "set_parent" then
		return setParent(p.path, p.parentPath)
	elseif cmd.type == "move_instance" then
		return moveInstance(p)
	elseif cmd.type == "bulk_set_property" then
		return bulkSetProperty(p.paths or {}, p.property, p.value)
	elseif cmd.type == "tag_instance" then
		return tagInstance(p.path, p.tag, true)
	elseif cmd.type == "untag_instance" then
		return tagInstance(p.path, p.tag, false)
	elseif cmd.type == "insert_asset" then
		return insertAsset(p.assetId, p.parentPath)
	-- experimental
	elseif cmd.type == "capture_viewport" then
		return captureViewport()
	elseif cmd.type == "playtest_control" then
		return playtestControl(p)
	elseif cmd.type == "get_playtest_output" then
		return getPlaytestOutput(p)
	elseif cmd.type == "get_playtest_status" then
		return getPlaytestStatus()
	-- attributes
	elseif cmd.type == "get_attribute" then
		return getAttribute(p.path, p.name)
	elseif cmd.type == "get_attributes" then
		return getAttributes(p.path)
	elseif cmd.type == "set_attribute" then
		return setAttribute(p.path, p.name, p.value)
	elseif cmd.type == "set_attributes" then
		return setAttributes(p.path, p.attributes)
	elseif cmd.type == "delete_attribute" then
		return deleteAttribute(p.path, p.name)
	-- script editing depth
	elseif cmd.type == "edit_script_lines" then
		return editScriptLines(p)
	elseif cmd.type == "insert_script_lines" then
		return insertScriptLines(p)
	elseif cmd.type == "delete_script_lines" then
		return deleteScriptLines(p)
	elseif cmd.type == "find_and_replace_in_scripts" then
		return findReplaceInScripts(p)
	elseif cmd.type == "grep_scripts" then
		return grepScripts(p)
	elseif cmd.type == "get_script_analysis" then
		return getScriptAnalysis(p)
	-- task 26: RoCreate asset scan (edit context only)
	elseif cmd.type == "rocreate_scan" then
		return rocreateScan(p.root or "game")
	-- task 25: disk<->Studio script sync primitives (edit context only)
	elseif cmd.type == "sync_list" then
		return syncList(p.root or "game")
	elseif cmd.type == "sync_get_sources" then
		return syncGetSources(p.paths or {})
	elseif cmd.type == "sync_set_sources" then
		return syncSetSources(p.items or {})
	-- undo/redo + mass ops
	elseif cmd.type == "undo" then
		return undo()
	elseif cmd.type == "redo" then
		return redo()
	elseif cmd.type == "mass_create_objects" then
		return massCreateObjects(p.items)
	elseif cmd.type == "mass_duplicate" then
		return massDuplicate(p)
	elseif cmd.type == "smart_duplicate" then
		return smartDuplicate(p)
	elseif cmd.type == "mass_get_property" then
		return massGetProperty(p.paths or {}, p.property)
	elseif cmd.type == "mass_set_property" then
		return bulkSetProperty(p.paths or {}, p.property, p.value)
	-- deeper inspection
	elseif cmd.type == "get_class_info" then
		return getClassInfo(p.className)
	elseif cmd.type == "get_services" then
		return getServices()
	elseif cmd.type == "get_descendants" then
		return getDescendants(p.path or "game", p.maxDepth)
	elseif cmd.type == "get_connected_instances" then
		return getConnectedInstances(p.path)
	elseif cmd.type == "compare_instances" then
		return compareInstances(p.pathA, p.pathB)
	elseif cmd.type == "get_project_structure" then
		return getProjectStructure()
	elseif cmd.type == "get_file_tree" then
		return getFileTree(p.root)
	elseif cmd.type == "set_properties" then
		return setProperties(p.path, p.properties)
	elseif cmd.type == "search_by_property" then
		return searchByProperty(p)
	elseif cmd.type == "get_tags" then
		return getTags(p.path)
	-- assets / marketplace
	elseif cmd.type == "get_asset_details" then
		return getAssetDetails(p.assetId)
	elseif cmd.type == "get_asset_thumbnail" then
		return getAssetThumbnail(p.assetId, p.size)
	elseif cmd.type == "preview_asset" then
		return previewAsset(p.assetId)
	elseif cmd.type == "search_materials" then
		return searchMaterials(p.query)
	elseif cmd.type == "search_assets" then
		return searchAssets()
	elseif cmd.type == "list_library" then
		return listLibrary()
	elseif cmd.type == "upload_decal" then
		return uploadDecal()
	-- build / scene / UI tree / file search (Task 16 Batch A)
	elseif cmd.type == "export_build" then
		return exportBuild(p)
	elseif cmd.type == "create_build" then
		return createBuild(p)
	elseif cmd.type == "import_build" then
		return importBuild(p)
	elseif cmd.type == "generate_build" then
		return generateBuild(p)
	elseif cmd.type == "create_keyframe_sequence" then
		return createKeyframeSequence(p)
	elseif cmd.type == "create_sound" then
		return createSound(p)
	elseif cmd.type == "set_lighting" then
		return setLighting(p)
	elseif cmd.type == "import_scene" then
		return importScene(p)
	elseif cmd.type == "create_ui_tree" then
		return createUiTree(p)
	elseif cmd.type == "search_files" then
		return searchFiles(p)
	-- raycast / bounds / camera / perf / group / align (Task 16 Batch B)
	elseif cmd.type == "raycast" then
		return raycastCmd(p)
	elseif cmd.type == "get_bounding_box" then
		return getBoundingBox(p)
	elseif cmd.type == "get_selection_bounds" then
		return getSelectionBounds()
	elseif cmd.type == "get_camera" then
		return getCamera()
	elseif cmd.type == "set_camera" then
		return setCamera(p)
	elseif cmd.type == "focus_instance" then
		return focusInstance(p)
	elseif cmd.type == "get_perf_stats" then
		return getPerfStats()
	elseif cmd.type == "group_instances" then
		return groupInstances(p)
	elseif cmd.type == "ungroup_instance" then
		return ungroupInstance(p)
	elseif cmd.type == "align_instances" then
		return alignInstances(p)
	elseif cmd.type == "measure_distance" then
		return measureDistance(p)
	-- input simulation
	elseif cmd.type == "simulate_keyboard_input" then
		return simulateKeyboardInput(p)
	elseif cmd.type == "simulate_mouse_input" then
		return simulateMouseInput(p)
	elseif cmd.type == "character_navigation" then
		return characterNavigation(p)
	else
		return { ok = false, err = "unknown command type: " .. tostring(cmd.type) }
	end
end

-- Called from the edit plugin's maintenance loop when a server context is live,
-- so a watched playtest doesn't look idle even without get_playtest_output calls.
function Executor.notePlaytestActivity()
	if playtestStartedAt ~= nil then
		playtestLastActivity = os.time()
	end
end

-- Auto-stop safety net for a Run-mode playtest started via playtest_control.
-- Stops if it has run past maxSeconds OR been idle past idleSeconds. Returns a
-- reason string when it stops (for the caller to log), else nil. No-op for
-- user-initiated playtests (playtestStartedAt is nil unless we started it).
function Executor.maybeAutoStopPlaytest(opts: any): string?
	if not opts or opts.enabled == false then
		return nil
	end
	-- A StudioTestService run lives in a separate DataModel, so edit-context
	-- RunService:IsRunning() is false; playtestStartedAt being set is our liveness.
	if playtestStartedAt == nil then
		return nil
	end
	local now = os.time()
	local maxSeconds = tonumber(opts.maxSeconds) or 300
	local idleSeconds = tonumber(opts.idleSeconds) or 120
	local ranFor = now - playtestStartedAt
	local idleFor = now - playtestLastActivity
	local reason: string? = nil
	if ranFor > maxSeconds then
		reason = ("ran %ds (cap %ds)"):format(ranFor, maxSeconds)
	elseif idleFor > idleSeconds then
		reason = ("idle %ds (cap %ds)"):format(idleFor, idleSeconds)
	end
	if not reason then
		return nil
	end
	-- Signal the in-run listener to EndTest; fall back to a direct EndTest.
	pcall(function()
		warn(PLAYTEST_STOP_SIGNAL)
	end)
	pcall(function()
		StudioTestService:EndTest("stopped_by_mcp")
	end)
	cleanupPlaytestStopListener()
	playtestCapturing = false
	playtestStartedAt = nil
	return reason
end

Executor.resolvePath = resolvePath
return Executor
