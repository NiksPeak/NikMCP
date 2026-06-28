-- Returns the runtime-agent source as a string. The {{PORT}} token is replaced
-- by the plugin (init.server.luau) before the source is written into a Script
-- in ServerScriptService. The agent activates only inside an F5 playtest server.
local SOURCE = [==[
--!nonstrict
-- Roblox Studio MCP - runtime agent. Auto-injected by the Studio MCP plugin.
-- Does nothing in edit mode; activates only inside an F5 playtest server.
local RunService = game:GetService("RunService")
if not RunService:IsRunning() or not RunService:IsServer() then
	return
end

local HttpService = game:GetService("HttpService")
local PORT = script:GetAttribute("McpPort") or {{PORT}}
local TOKEN = script:GetAttribute("McpToken") or ""
local CANDIDATES = { PORT, 58741, 58742, 58743 }
local POLL_INTERVAL = 0.5
local BACKOFF_START = 1
local BACKOFF_MAX = 5
local CONTEXT = "server"
local base = nil

local function urlFor(port)
	return ("http://127.0.0.1:%d"):format(port)
end

-- Optional auth header (matches the edit plugin's TOFU token); nil when off.
local function authHeaders()
	if TOKEN ~= "" then
		return { ["x-mcp-token"] = TOKEN }
	end
	return nil
end

local function tryHeartbeat(port)
	local ok = pcall(function()
		HttpService:GetAsync(urlFor(port) .. "/heartbeat?context=" .. CONTEXT)
	end)
	return ok
end

-- Try to resolve a bridge port now (fast path). If the run DM's networking isn't
-- ready yet at t=0 (heavy boot), that's fine -- do NOT early-exit: the Heartbeat
-- scheduler below reprobes with backoff until the bridge answers.
for _, port in ipairs(CANDIDATES) do
	if tryHeartbeat(port) then
		base = urlFor(port)
		break
	end
end

-- Minimal serializer (returned values only).
local function serialize(v)
	local t = typeof(v)
	if t == "Vector3" then
		return { __t = "Vector3", x = v.X, y = v.Y, z = v.Z }
	elseif t == "CFrame" then
		return { __t = "CFrame", comps = { v:GetComponents() } }
	elseif t == "Color3" then
		return { __t = "Color3", r = v.R, g = v.G, b = v.B }
	elseif t == "Vector2" then
		return { __t = "Vector2", x = v.X, y = v.Y }
	elseif t == "EnumItem" then
		return { __t = "EnumItem", enum = tostring(v.EnumType), name = v.Name }
	elseif t == "Instance" then
		return { __t = "Instance", className = v.ClassName, path = v:GetFullName() }
	elseif t == "table" then
		local out = {}
		for k, val in pairs(v) do
			out[k] = serialize(val)
		end
		return out
	elseif t == "string" or t == "number" or t == "boolean" or t == "nil" then
		return v
	else
		-- any other datatype: stringify so JSONEncode never fails on the response
		return { __t = t, value = tostring(v) }
	end
end

-- Shared resolve + a console ring so read tools have parity with the edit
-- Executor during a live playtest.
local CollectionService = game:GetService("CollectionService")
local LogService = game:GetService("LogService")
local function resolve(path)
	if not path or path == "" or path == "game" then
		return game
	end
	local node = game
	for seg in string.gmatch(path, "[^%.]+") do
		if seg ~= "game" then
			node = node and node:FindFirstChild(seg)
		end
	end
	return node
end
local function pathInfo(inst)
	return { path = inst:GetFullName(), className = inst.ClassName, name = inst.Name }
end
local CURATED = {
	"Archivable", "Position", "Size", "CFrame", "Orientation", "Anchored", "CanCollide",
	"CanTouch", "CanQuery", "Transparency", "Reflectance", "Color", "Material", "CastShadow",
	"Enabled", "Visible", "Active", "Text", "Value", "Locked", "PrimaryPart", "Name", "ClassName",
}
-- Build serializer (parity with the edit Executor's export_build).
local function buildOf(inst, depth, maxDepth)
	local node = { className = inst.ClassName, name = inst.Name }
	local props = {}
	for _, name in ipairs(CURATED) do
		local ok, val = pcall(function()
			return inst[name]
		end)
		if ok and val ~= nil and typeof(val) ~= "Instance" then
			props[name] = serialize(val)
		end
	end
	if next(props) then
		node.properties = props
	end
	local attrs = {}
	for k, v in pairs(inst:GetAttributes()) do
		attrs[k] = serialize(v)
	end
	if next(attrs) then
		node.attributes = attrs
	end
	local tags = CollectionService:GetTags(inst)
	if #tags > 0 then
		node.tags = tags
	end
	if depth < maxDepth then
		local kids = {}
		for _, c in ipairs(inst:GetChildren()) do
			table.insert(kids, buildOf(c, depth + 1, maxDepth))
		end
		if #kids > 0 then
			node.children = kids
		end
	end
	return node
end

local consoleRing = {}
LogService.MessageOut:Connect(function(msg, mt)
	table.insert(consoleRing, { text = tostring(msg), level = mt.Name, t = os.time() })
	if #consoleRing > 500 then
		table.remove(consoleRing, 1)
	end
end)

local function runLuau(code)
	local buffer = {}
	local function capture(...)
		local n = select("#", ...)
		local parts = table.create(n)
		for i = 1, n do
			parts[i] = tostring((select(i, ...)))
		end
		table.insert(buffer, table.concat(parts, "\t"))
	end
	local chunk, compileErr = loadstring(code) -- requires LoadStringEnabled
	if not chunk then
		return { ok = false, output = "", err = "compile error: " .. tostring(compileErr) }
	end
	local env = setmetatable({ print = capture, warn = capture }, { __index = getfenv() })
	setfenv(chunk, env)
	local packed = table.pack(pcall(chunk))
	local output = table.concat(buffer, "\n")
	if not packed[1] then
		return { ok = false, output = output, err = tostring(packed[2]) }
	end
	local result = nil
	if packed.n > 1 then
		result = serialize(packed[2])
	end
	return { ok = true, output = output, result = result }
end

-- Read-tool parity: these all work against the running server's DataModel so
-- playtest debugging mirrors the edit Executor. Edit-only tools (script editing,
-- selection, undo, asset insert) fall through to the unsupported message.
local function execute(cmd)
	local p = cmd.payload or {}
	if cmd.type == "run_luau" then
		return runLuau(p.code)
	elseif cmd.type == "get_instance_tree" then
		local root = resolve(p.path)
		if not root then
			return { ok = false, err = "path not found" }
		end
		local maxDepth = p.maxDepth or 4
		local function walk(inst, d)
			local node = { name = inst.Name, className = inst.ClassName, children = {} }
			if d < maxDepth then
				for _, c in ipairs(inst:GetChildren()) do
					table.insert(node.children, walk(c, d + 1))
				end
			end
			return node
		end
		return { ok = true, result = walk(root, 0) }
	elseif cmd.type == "read_console" then
		local count = p.count or 100
		local picked = {}
		for i = math.max(1, #consoleRing - count + 1), #consoleRing do
			table.insert(picked, consoleRing[i])
		end
		return { ok = true, result = { lines = picked, total = #consoleRing } }
	elseif cmd.type == "search_instances" then
		local root = resolve(p.root or "game") or game
		local query = p.query and string.lower(tostring(p.query)) or nil
		local out = {}
		local limit = p.limit or 100
		for _, inst in ipairs(root:GetDescendants()) do
			local ok = true
			if p.className then
				local okc, isa = pcall(function()
					return inst:IsA(p.className)
				end)
				if not okc or not isa then
					ok = false
				end
			end
			if ok and query and not string.find(string.lower(inst.Name), query, 1, true) then
				ok = false
			end
			if ok and p.tag and not CollectionService:HasTag(inst, p.tag) then
				ok = false
			end
			if ok then
				table.insert(out, pathInfo(inst))
				if #out >= limit then
					break
				end
			end
		end
		return { ok = true, result = out }
	elseif cmd.type == "list_scripts" then
		local root = resolve(p.root or "game") or game
		local out = {}
		for _, inst in ipairs(root:GetDescendants()) do
			if inst:IsA("LuaSourceContainer") then
				table.insert(out, pathInfo(inst))
			end
		end
		return { ok = true, result = out }
	elseif cmd.type == "get_place_info" then
		local counts = {}
		for _, child in ipairs(game:GetChildren()) do
			counts[child.Name] = #child:GetChildren()
		end
		return { ok = true, result = { placeId = game.PlaceId, gameId = game.GameId, topLevelCounts = counts, running = true } }
	elseif cmd.type == "get_tagged" then
		local out = {}
		for _, inst in ipairs(CollectionService:GetTagged(p.tag)) do
			table.insert(out, pathInfo(inst))
		end
		return { ok = true, result = out }
	elseif cmd.type == "get_tags" then
		local inst = resolve(p.path)
		if not inst then
			return { ok = false, err = "path not found" }
		end
		return { ok = true, result = { path = inst:GetFullName(), tags = CollectionService:GetTags(inst) } }
	elseif cmd.type == "get_properties" then
		local inst = resolve(p.path)
		if not inst then
			return { ok = false, err = "path not found" }
		end
		local names = p.propertyNames or CURATED
		local props = {}
		for _, name in ipairs(names) do
			local ok, val = pcall(function()
				return inst[name]
			end)
			if ok and val ~= nil then
				props[name] = serialize(val)
			end
		end
		return { ok = true, result = { path = inst:GetFullName(), className = inst.ClassName, properties = props } }
	elseif cmd.type == "get_attribute" then
		local inst = resolve(p.path)
		if not inst then
			return { ok = false, err = "path not found" }
		end
		return { ok = true, result = { path = inst:GetFullName(), name = p.name, value = serialize(inst:GetAttribute(p.name)) } }
	elseif cmd.type == "get_attributes" then
		local inst = resolve(p.path)
		if not inst then
			return { ok = false, err = "path not found" }
		end
		local out = {}
		for k, v in pairs(inst:GetAttributes()) do
			out[k] = serialize(v)
		end
		return { ok = true, result = { path = inst:GetFullName(), attributes = out } }
	elseif cmd.type == "get_descendants" then
		local root = resolve(p.path)
		if not root then
			return { ok = false, err = "path not found" }
		end
		local out = {}
		for _, d in ipairs(root:GetDescendants()) do
			table.insert(out, pathInfo(d))
			if #out >= 5000 then
				break
			end
		end
		return { ok = true, result = { descendants = out, truncated = #out >= 5000 } }
	elseif cmd.type == "get_services" then
		local out = {}
		for _, child in ipairs(game:GetChildren()) do
			table.insert(out, { name = child.Name, className = child.ClassName })
		end
		return { ok = true, result = out }
	elseif cmd.type == "search_by_property" then
		local root = resolve(p.root or "game") or game
		local out = {}
		local limit = p.limit or 100
		for _, inst in ipairs(root:GetDescendants()) do
			local ok, val = pcall(function()
				return inst[p.property]
			end)
			if ok and val == p.value then
				table.insert(out, pathInfo(inst))
				if #out >= limit then
					break
				end
			end
		end
		return { ok = true, result = out }
	elseif cmd.type == "character_navigation" then
		local Players = game:GetService("Players")
		local player = Players:GetPlayers()[1]
		if not player or not player.Character then
			return { ok = false, err = "no player character in the running game" }
		end
		local hum = player.Character:FindFirstChildOfClass("Humanoid")
		if not hum then
			return { ok = false, err = "player has no Humanoid" }
		end
		local pos = p.position
		local target = typeof(pos) == "Vector3" and pos
			or (type(pos) == "table" and pos.x and Vector3.new(pos.x, pos.y, pos.z))
		if not target then
			return { ok = false, err = "character_navigation needs a Vector3 'position'" }
		end
		hum:MoveTo(target)
		return { ok = true, output = "moving character toward target" }
	elseif cmd.type == "export_build" then
		local inst = resolve(p.path)
		if not inst then
			return { ok = false, err = "path not found" }
		end
		return { ok = true, result = buildOf(inst, 0, p.maxDepth or 8) }
	elseif cmd.type == "create_build" then
		local inst = resolve(p.path)
		if not inst then
			return { ok = false, err = "path not found" }
		end
		local b = buildOf(inst, 0, p.maxDepth or 8)
		return { ok = true, result = { kind = "build", name = p.name or b.name, build = b } }
	elseif cmd.type == "search_files" then
		local root = resolve(p.root or "game") or game
		local pat = p.pattern
		if not pat or pat == "" then
			return { ok = false, err = "search_files: 'pattern' is required" }
		end
		local useRegex = p.regex == true
		local needle = useRegex and pat or string.lower(pat)
		local limit = p.limit or 500
		local out = {}
		local function hit(s)
			if useRegex then
				return string.find(s, pat) ~= nil
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
	elseif cmd.type == "raycast" then
		local function v3(a)
			if type(a) ~= "table" then
				return nil
			end
			local x = a[1] or a.x
			local y = a[2] or a.y
			local z = a[3] or a.z
			if x and y and z then
				return Vector3.new(x, y, z)
			end
			return nil
		end
		local origin, dir = v3(p.origin), v3(p.direction)
		if not origin or not dir or dir.Magnitude == 0 then
			return { ok = false, err = "raycast needs origin and a non-zero direction [x,y,z]" }
		end
		local params = RaycastParams.new()
		params.FilterType = Enum.RaycastFilterType.Exclude
		local ignore = {}
		if type(p.ignorePaths) == "table" then
			for _, ip in ipairs(p.ignorePaths) do
				local i = resolve(ip)
				if i then
					table.insert(ignore, i)
				end
			end
		end
		params.FilterDescendantsInstances = ignore
		local r = workspace:Raycast(origin, dir.Unit * (p.maxDistance or 1000), params)
		if not r then
			return { ok = true, result = { hit = false } }
		end
		return {
			ok = true,
			result = {
				hit = true,
				hitPath = r.Instance and r.Instance:GetFullName() or nil,
				position = serialize(r.Position),
				normal = serialize(r.Normal),
				material = r.Material.Name,
				distance = r.Distance,
			},
		}
	elseif cmd.type == "get_bounding_box" then
		local inst = resolve(p.path)
		if not inst then
			return { ok = false, err = "path not found" }
		end
		local cf, size
		if inst:IsA("Model") then
			local ok = pcall(function()
				cf, size = inst:GetBoundingBox()
			end)
			if not ok then
				return { ok = false, err = "GetBoundingBox failed" }
			end
		elseif inst:IsA("BasePart") then
			cf, size = inst.CFrame, inst.Size
		else
			return { ok = false, err = "not a Model or BasePart" }
		end
		return { ok = true, result = { path = inst:GetFullName(), cframe = serialize(cf), size = serialize(size) } }
	elseif cmd.type == "measure_distance" then
		local ia, ib = resolve(p.pathA), resolve(p.pathB)
		if not ia or not ib then
			return { ok = false, err = "one or both paths not found" }
		end
		local function pp(inst)
			if inst:IsA("PVInstance") then
				local ok, piv = pcall(function()
					return inst:GetPivot()
				end)
				if ok then
					return piv.Position
				end
			end
			return nil
		end
		local pa, pb = pp(ia), pp(ib)
		if not pa or not pb then
			return { ok = false, err = "both instances must be PVInstances" }
		end
		return { ok = true, result = { distance = (pa - pb).Magnitude, a = ia:GetFullName(), b = ib:GetFullName() } }
	elseif cmd.type == "get_perf_stats" then
		local Stats = game:GetService("Stats")
		local mem = nil
		pcall(function()
			mem = Stats:GetTotalMemoryUsageMb()
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
			result = { totalMemoryMb = mem, instanceCount = instanceCount, partCount = partCount, scriptCount = scriptCount },
		}
	elseif cmd.type == "playtest_control" then
		-- Only stop is handled here: EndTest is legal ONLY from the run DataModel,
		-- which is exactly this agent's context. Start stays an edit-plugin op.
		if tostring(p.action) == "stop" then
			local StudioTestService = game:GetService("StudioTestService")
			local ok, err = pcall(function()
				StudioTestService:EndTest("stopped_by_mcp")
			end)
			if ok then
				return { ok = true, output = "ended playtest via StudioTestService:EndTest (run DataModel)" }
			end
			return { ok = false, err = "EndTest failed: " .. tostring(err) }
		end
		return { ok = false, err = "playtest_control start is an edit-only operation" }
	else
		return { ok = false, err = "agent does not support command: " .. tostring(cmd.type) }
	end
end

-- Heartbeat-driven poll scheduler. Hardened against the silent-stop deadlock:
-- the ENTIRE poll body runs inside a pcall and isPolling is reset UNCONDITIONALLY
-- after it, so a throw in a command handler or an HTTP read can never leave the
-- scheduler wedged (which silently killed the agent before). The connection lives
-- as long as the run DataModel; reprobe + backoff handle a not-yet-ready bridge.
local lastReported = nil
local backoff = BACKOFF_START
local lastPoll = 0
local isPolling = false
local pollCount = 0
local pollConn = nil

-- Preallocated header tables: no per-poll / per-frame allocation.
local pollHeaders = authHeaders() or {}
local responseHeaders = authHeaders() or {}
responseHeaders["Content-Type"] = "application/json"

-- Self-diagnostics: POST a tiny event to the bridge (/diag) so the agent's last
-- state + drop reason are readable via get_status WITHOUT Studio Output. Never
-- throws, never blocks (pcall); skipped until a bridge is resolved.
local function sendDiag(event, extra)
	if not base then
		return
	end
	pcall(function()
		local payload = { event = event, t = os.time(), context = CONTEXT, pollCount = pollCount }
		if extra then
			for k, v in pairs(extra) do
				payload[k] = v
			end
		end
		HttpService:RequestAsync({
			Url = base .. "/diag",
			Method = "POST",
			Headers = responseHeaders,
			Body = HttpService:JSONEncode(payload),
		})
	end)
end

local function reprobe()
	for _, port in ipairs(CANDIDATES) do
		if tryHeartbeat(port) then
			base = urlFor(port)
			return true
		end
	end
	return false
end

local function handleBody(body)
	if not body or body == "" then
		return
	end
	local decoded = HttpService:JSONDecode(body) -- throws on bad JSON -> caught by doPoll's pcall
	local cmd = decoded and decoded.command or nil
	if cmd and cmd.id then
		-- A bad command handler must NOT kill the loop.
		local okExec, result = pcall(execute, cmd)
		if not okExec then
			sendDiag("handler_error", { cmdType = tostring(cmd.type), err = tostring(result) })
			result = { ok = false, err = "handler error: " .. tostring(result) }
		end
		if result and result.ok == false then
			warn(("[MCP agent] command %q failed: %s"):format(tostring(cmd.type), tostring(result.err)))
		end
		result.id = cmd.id
		pcall(function()
			HttpService:RequestAsync({
				Url = base .. "/response",
				Method = "POST",
				Headers = responseHeaders,
				Body = HttpService:JSONEncode(result),
			})
		end)
	end
end

-- One poll iteration. ENTIRE body in pcall; isPolling reset UNCONDITIONALLY after,
-- so no error path (HTTP read, JSON decode, handler) can ever wedge the scheduler.
local function doPoll()
	local ok, err = pcall(function()
		if not base then
			if not reprobe() then
				if lastReported ~= "noBridge" then
					warn("[MCP agent] no reachable bridge; ensure 'Allow HTTP Requests' is on and the server is running")
					lastReported = "noBridge"
				end
				backoff = math.min(backoff * 2, BACKOFF_MAX)
				return
			end
			lastReported = "up"
			backoff = BACKOFF_START
			sendDiag("connect", { base = base })
		end
		local res = HttpService:RequestAsync({
			Url = base .. "/poll?context=" .. CONTEXT,
			Method = "GET",
			Headers = pollHeaders,
		})
		if not (res.Success or res.StatusCode == 503) then
			error("poll HTTP status " .. tostring(res.StatusCode))
		end
		if lastReported == "dropped" then
			print("[MCP agent] reconnected to " .. base)
			sendDiag("reconnect", { base = base })
		end
		lastReported = "up"
		backoff = BACKOFF_START
		pollCount += 1
		if pollCount == 1 or pollCount % 10 == 0 then
			sendDiag("poll", { count = pollCount })
		end
		handleBody(res.Body)
	end)
	if not ok then
		if lastReported ~= "dropped" then
			warn("[MCP agent] poll error on " .. tostring(base) .. ": " .. tostring(err))
			lastReported = "dropped"
		end
		sendDiag("poll_error", { err = tostring(err) }) -- base still set here, so this reaches the bridge
		base = nil
		backoff = math.min(backoff * 2, BACKOFF_MAX)
	end
	isPolling = false -- UNCONDITIONAL: an error must never leave the scheduler stuck
end

-- Per-frame handler allocates nothing: it compares timers and defers the yielding
-- poll to a spawned task. isPolling prevents overlap; backoff paces reconnects.
pollConn = RunService.Heartbeat:Connect(function()
	if isPolling then
		return
	end
	local interval = if base then POLL_INTERVAL else backoff
	if tick() - lastPoll < interval then
		return
	end
	lastPoll = tick()
	isPolling = true
	task.spawn(doPoll)
end)

-- Janitor: report shutdown and drop the connection when the run DataModel tears down.
game:BindToClose(function()
	sendDiag("shutdown", { pollCount = pollCount })
	if pollConn then
		pollConn:Disconnect()
		pollConn = nil
	end
end)

if base then
	print("[MCP agent] connected to " .. base)
else
	print("[MCP agent] scheduler armed; probing for bridge...")
end
]==]

return SOURCE
