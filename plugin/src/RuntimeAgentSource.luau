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
local PORT_CANDIDATES = script:GetAttribute("McpPortCandidates")
local TOKEN = script:GetAttribute("McpToken") or ""
local TARGET_ID = script:GetAttribute("McpTargetId") or ""
local RUNTIME_SESSION_ID = script:GetAttribute("McpRuntimeSessionId")
local PIN_PATTERN = script:GetAttribute("McpPinPattern")
local POLL_INTERVAL = 0.5
local BACKOFF_START = 1
local BACKOFF_MAX = 8
local REJECT_COOLDOWN = 30 -- seconds a bridge that answered 401/409/400 is skipped before re-probing
local CONTEXT = "server"
local base = nil
local basePort = nil
-- v0.2.0: bridges that refused this window (leased to another Studio, bad token)
-- are parked here so the agent stops busy-looping 409s against them.
local rejectedUntil = {}

local function buildCandidates()
	local seen = {}
	local out = {}
	local function add(raw)
		local port = tonumber(raw)
		if port and port > 0 and port < 65536 and not seen[port] then
			seen[port] = true
			table.insert(out, port)
		end
	end
	add(PORT)
	if type(PORT_CANDIDATES) == "string" then
		for raw in string.gmatch(PORT_CANDIDATES, "[^,%s]+") do
			add(raw)
		end
	end
	for port = 58741, 58760 do
		add(port)
	end
	return out
end

local CANDIDATES = buildCandidates()

local function urlFor(port)
	return ("http://127.0.0.1:%d"):format(port)
end

-- Optional auth header (matches the edit plugin's TOFU token); nil when off.
local function authHeaders()
	local headers = { ["x-mcp-target-id"] = TARGET_ID }
	if TOKEN ~= "" then
		headers["x-mcp-token"] = TOKEN
	end
	return headers
end

-- v0.2.0 lease-aware probe: /heartbeat?targetId= tells us whether THAT bridge
-- would accept this Studio window (exact = it already holds our lease, i.e. the
-- edit plugin of this very window is polling it) and whether our token is valid.
-- Returns nil when unreachable. A pre-0.2.0 bridge (no lease fields) is treated
-- as accepting so mixed versions still connect.
local function probeBridge(port)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = urlFor(port) .. "/heartbeat?context=" .. CONTEXT .. "&targetId=" .. HttpService:UrlEncode(TARGET_ID),
			Method = "GET",
			Headers = authHeaders(),
		})
	end)
	if not ok or type(res) ~= "table" or not res.Success then
		return nil
	end
	local decoded = nil
	pcall(function()
		decoded = HttpService:JSONDecode(res.Body)
	end)
	if type(decoded) ~= "table" then
		return { accepts = true, exact = false, tokenOk = true }
	end
	return {
		accepts = decoded.accepts ~= false,
		exact = decoded.exact == true,
		tokenOk = decoded.tokenOk ~= false,
	}
end

-- Pick the bridge that already owns this window's lease; else the first bridge
-- that would accept it; never one that is leased to another live Studio window
-- or rejects our token. Recently-rejecting ports are skipped for REJECT_COOLDOWN.
local function resolveBridge()
	local now = os.clock()
	local fallback = nil
	for _, port in ipairs(CANDIDATES) do
		local parkedUntil = rejectedUntil[port]
		if not parkedUntil or parkedUntil <= now then
			local info = probeBridge(port)
			if info and info.tokenOk then
				if info.exact then
					return port, "exact"
				end
				if info.accepts and not fallback then
					fallback = port
				end
			end
		end
	end
	if fallback then
		return fallback, "accepting"
	end
	return nil, nil
end

-- Try to resolve a bridge port now (fast path). If the run DM's networking isn't
-- ready yet at t=0 (heavy boot), that's fine -- do NOT early-exit: the Heartbeat
-- scheduler below reprobes with backoff until the bridge answers.
do
	local port, how = resolveBridge()
	if port then
		base = urlFor(port)
		basePort = port
		print(("[MCP agent] resolved bridge :%d (%s)"):format(port, tostring(how)))
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

-- v0.2.0: bigger ring (2000) plus a separate PINNED ring for lines matching the
-- McpPinPattern attribute (plain substring, stamped by playtest_control/run_harness).
-- Pinned lines survive any amount of unrelated log noise, so a harness's own
-- verdict/summary lines are never evicted before they are read.
local CONSOLE_RING_CAP = 2000
local PINNED_RING_CAP = 500
local consoleRing = {}
local pinnedRing = {}
LogService.MessageOut:Connect(function(msg, mt)
	local text = tostring(msg)
	local entry = { text = text, level = mt.Name, t = os.time() }
	table.insert(consoleRing, entry)
	if #consoleRing > CONSOLE_RING_CAP then
		table.remove(consoleRing, 1)
	end
	if type(PIN_PATTERN) == "string" and PIN_PATTERN ~= "" and string.find(text, PIN_PATTERN, 1, true) then
		table.insert(pinnedRing, entry)
		if #pinnedRing > PINNED_RING_CAP then
			table.remove(pinnedRing, 1)
		end
	end
end)

-- Client relay: HttpService is server-only, so the client agent (injected only
-- in play mode by the edit plugin) talks to us over this RemoteEvent instead.
-- Created once in the run DataModel; no edit-tree cleanup needed since it only
-- ever exists there.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local relay = ReplicatedStorage:FindFirstChild("NikMCP_ClientRelay")
if not relay then
	relay = Instance.new("RemoteEvent")
	relay.Name = "NikMCP_ClientRelay"
	relay.Parent = ReplicatedStorage
end

-- Bind the relay to whichever player the client agent belongs to (single-player
-- Studio testing only -- client_query/read_console already assume Players[1]).
-- Without this, ANY client LocalScript could forge kind="queryResult" (poisoning
-- an in-flight client_query with a guessed id) or kind="logs" (injecting fake
-- client console lines) by firing the relay directly.
local boundPlayer = Players:GetPlayers()[1]
if not boundPlayer then
	local bindConn
	bindConn = Players.PlayerAdded:Connect(function(plr)
		if not boundPlayer then
			boundPlayer = plr
		end
		bindConn:Disconnect()
	end)
end

-- Separate ring for client-side console lines (fed by the client agent's
-- batched "logs" fires); same cap/shape as consoleRing.
local CLIENT_RING_CAP = 1500
local clientRing = {}

-- Flood protection: cap accepted client log entries per second; beyond that
-- drop and warn ONCE per flood episode (not once per dropped entry).
local FLOOD_PER_SEC = 100
local floodSecond = 0
local floodCount = 0
local floodWarned = false

-- Client request correlation table: id -> { done, result, expectedPlayer },
-- filled by the
-- "queryResult" branch below and polled (task.wait) by the client_query command.
local pendingQueries = {}
local nextQueryId = 0
local clientReadyAt = nil
local qaReadyPlayers = {}
local qaLeaveAcks = {}
local qaLeaveSequence = 0

Players.PlayerRemoving:Connect(function(player)
	qaReadyPlayers[player] = nil
end)

relay.OnServerEvent:Connect(function(_player, kind, a, b)
	-- These QA messages accept any real Player sender, but cannot satisfy the
	-- single-client query correlation table or inject client log entries.
	if kind == "qaReady" then
		qaReadyPlayers[_player] = os.clock()
		return
	elseif kind == "qaLeaveAck" then
		if type(a) == "number" and type(qaLeaveAcks[a]) == "table" then
			qaLeaveAcks[a].done = true
			qaLeaveAcks[a].player = _player
			qaLeaveAcks[a].result = b
		end
		return
	end
	if not boundPlayer then
		boundPlayer = _player
	end
	if _player ~= boundPlayer then
		return -- forged event from a non-bound client -- ignore
	end
	if kind == "ready" then
		clientReadyAt = os.clock()
	elseif kind == "logs" then
		if type(a) ~= "table" then
			return
		end
		local nowSec = os.time()
		if nowSec ~= floodSecond then
			floodSecond = nowSec
			floodCount = 0
			floodWarned = false
		end
		for _, e in ipairs(a) do
			if floodCount >= FLOOD_PER_SEC then
				if not floodWarned then
					warn("[MCP agent] client log flood: dropping entries beyond " .. FLOOD_PER_SEC .. "/sec")
					floodWarned = true
				end
				break
			end
			if type(e) == "table" then
				floodCount += 1
				table.insert(clientRing, e)
				if #clientRing > CLIENT_RING_CAP then
					table.remove(clientRing, 1)
				end
			end
		end
	elseif kind == "queryResult" then
		if type(a) ~= "number" then
			return
		end
		local slot = pendingQueries[a]
		if slot and slot.expectedPlayer == _player then
			slot.result = b
			slot.done = true
		end
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

local function qaState()
	local playerRows = {}
	local readyCount = 0
	for index, player in ipairs(Players:GetPlayers()) do
		local ready = qaReadyPlayers[player] ~= nil
		if ready then
			readyCount += 1
		end
		table.insert(playerRows, {
			index = index,
			name = player.Name,
			userId = player.UserId,
			clientAgentReady = ready,
		})
	end
	local okArgs, testArgs = pcall(function()
		return game:GetService("StudioTestService"):GetTestArgs()
	end)
	local serializedArgs = nil
	local testArgsError = nil
	if okArgs then
		serializedArgs = serialize(testArgs)
	else
		testArgsError = tostring(testArgs)
	end
	return {
		playerCount = #playerRows,
		readyClientCount = readyCount,
		players = playerRows,
		testArgs = serializedArgs,
		testArgsError = testArgsError,
		runServiceIsRunning = RunService:IsRunning(),
		runtimeSessionId = RUNTIME_SESSION_ID,
	}
end

local function relayClientQuery(name, args, timeoutSec)
	local player = boundPlayer
	if not player or player.Parent ~= Players or not relay then
		return false, "client agent not connected"
	end
	nextQueryId += 1
	local id = nextQueryId
	local slot = {
		done = false,
		result = nil,
		expectedPlayer = player,
		name = name,
	}
	pendingQueries[id] = slot
	local sent, sendErr = pcall(function()
		relay:FireClient(player, "query", id, name, args)
	end)
	if not sent or not relay.Parent then
		pendingQueries[id] = nil
		return false, "client agent not connected: " .. tostring(sendErr)
	end
	local boundedTimeout = math.clamp(tonumber(timeoutSec) or 5, 0.1, 60)
	local waited = 0
	while not slot.done and waited < boundedTimeout do
		task.wait(0.05)
		waited += 0.05
	end
	pendingQueries[id] = nil
	if not slot.done then
		return false, ("client agent query timed out after %.1fs"):format(boundedTimeout)
	end
	return true, slot.result
end

local SCENE_ANALYSIS_METHODS = {
	instanceComposition = "GetInstanceCompositionAsync",
	scriptMemory = "GetScriptMemoryAsync",
	unparentedInstances = "GetUnparentedInstancesAsync",
	triangleComposition = "GetTriangleCompositionAsync",
	animationMemory = "GetAnimationMemoryAsync",
	audioMemory = "GetAudioMemoryAsync",
}

local DEFAULT_SCENE_ANALYSIS_MODES = {
	"instanceComposition",
	"scriptMemory",
	"unparentedInstances",
	"triangleComposition",
	"animationMemory",
	"audioMemory",
}

local function analysisText(value, state, limit)
	local text = tostring(value)
	local allowed = math.min(limit or #text, math.max(0, state.maxChars - state.chars))
	if #text > allowed then
		text = string.sub(text, 1, allowed)
		state.truncated = true
	end
	state.chars += #text
	return text
end

local function sanitizeAnalysisValue(value, state, depth)
	if state.nodes >= state.maxNodes then
		state.truncated = true
		return { __truncated = "node_limit" }
	end
	if depth > state.maxDepth then
		state.truncated = true
		return { __truncated = "depth_limit" }
	end
	if state.chars >= state.maxChars then
		state.truncated = true
		return { __truncated = "character_budget" }
	end
	state.nodes += 1
	local valueType = typeof(value)
	if valueType == "nil" or valueType == "boolean" then
		return value
	elseif valueType == "number" then
		state.chars += 24
		if value ~= value or value == math.huge or value == -math.huge then
			return tostring(value)
		end
		return value
	elseif valueType == "string" then
		return analysisText(value, state, 4096)
	elseif valueType == "Instance" then
		local okPath, fullPath = pcall(function()
			return value:GetFullName()
		end)
		return {
			__t = "Instance",
			className = analysisText(value.ClassName, state, 128),
			name = analysisText(value.Name, state, 256),
			path = analysisText(okPath and fullPath or value.Name, state, 2048),
			parented = value.Parent ~= nil,
		}
	elseif valueType == "EnumItem" then
		return {
			__t = "EnumItem",
			enum = analysisText(tostring(value.EnumType), state, 128),
			name = analysisText(value.Name, state, 128),
		}
	elseif valueType == "table" then
		if state.seen[value] then
			state.truncated = true
			return { __truncated = "cycle_or_shared_table" }
		end
		state.seen[value] = true
		local out = {}
		for key, child in pairs(value) do
			if state.nodes >= state.maxNodes or state.chars >= state.maxChars then
				state.truncated = true
				out.__truncated = "analysis_budget"
				break
			end
			local safeKey = analysisText(key, state, 256)
			out[safeKey] = sanitizeAnalysisValue(child, state, depth + 1)
		end
		return out
	end
	local scalar = serialize(value)
	if type(scalar) == "table" then
		return sanitizeAnalysisValue(scalar, state, depth + 1)
	end
	return analysisText(scalar, state, 2048)
end

local function captureSceneAnalysis(args)
	args = type(args) == "table" and args or {}
	local okService, serviceOrErr = pcall(function()
		return game:GetService("SceneAnalysisService")
	end)
	if not okService or not serviceOrErr then
		return {
			err = "SceneAnalysisService is unavailable in this Studio build: " .. tostring(serviceOrErr),
		}
	end
	local requested = args.include or args.modes or DEFAULT_SCENE_ANALYSIS_MODES
	if type(requested) ~= "table" or #requested < 1 then
		return { err = "scene analysis include must contain at least one supported mode" }
	end
	local selected = {}
	local seenModes = {}
	for _, rawMode in ipairs(requested) do
		local mode = tostring(rawMode)
		if not SCENE_ANALYSIS_METHODS[mode] then
			return { err = "unsupported scene analysis mode: " .. mode }
		end
		if not seenModes[mode] then
			seenModes[mode] = true
			table.insert(selected, mode)
		end
	end
	local maxOutputBytes = math.clamp(math.floor(tonumber(args.maxOutputBytes) or 250000), 10000, 1000000)
	local state = {
		nodes = 0,
		chars = 0,
		maxNodes = math.clamp(math.floor(tonumber(args.maxNodes) or 5000), 100, 20000),
		maxDepth = math.clamp(math.floor(tonumber(args.maxDepth) or 10), 2, 16),
		maxChars = math.floor(maxOutputBytes * 0.65),
		truncated = false,
		seen = {},
	}
	local result = {
		context = "server",
		requestedModes = selected,
		results = {},
	}
	local modeStatuses = {}
	for _, mode in ipairs(selected) do
		local beforeNodes = state.nodes
		local beforeChars = state.chars
		local methodName = SCENE_ANALYSIS_METHODS[mode]
		local okMode, rawOrErr = pcall(function()
			return serviceOrErr[methodName](serviceOrErr)
		end)
		local row
		if okMode then
			row = {
				ok = true,
				data = sanitizeAnalysisValue(rawOrErr, state, 0),
			}
		else
			row = {
				ok = false,
				err = analysisText(rawOrErr, state, 2048),
			}
		end
		row.nodesUsed = state.nodes - beforeNodes
		row.charactersUsed = state.chars - beforeChars
		result.results[mode] = row
		modeStatuses[mode] = {
			ok = row.ok,
			nodesUsed = row.nodesUsed,
			charactersUsed = row.charactersUsed,
			err = row.err,
		}
	end
	result.summary = {
		nodesVisited = state.nodes,
		charactersKept = state.chars,
		truncated = state.truncated,
		maxNodes = state.maxNodes,
		maxDepth = state.maxDepth,
		maxOutputBytes = maxOutputBytes,
	}
	local okEncode, encoded = pcall(function()
		return HttpService:JSONEncode(result)
	end)
	if okEncode and #encoded <= maxOutputBytes then
		result.summary.encodedBytes = #encoded
		return result
	end
	result.results = modeStatuses
	result.summary.truncated = true
	result.summary.dataOmitted = true
	result.summary.reason = okEncode and "encoded output exceeded maxOutputBytes" or ("JSON encoding failed: " .. tostring(encoded))
	return result
end

local sceneAnalysisBusy = false

local function captureSceneAnalysisBounded(args, timeoutSec)
	if sceneAnalysisBusy then
		return false, "a previous server scene analysis is still running"
	end
	sceneAnalysisBusy = true
	local slot = { done = false, ok = false, result = nil }
	local worker = task.spawn(function()
		local okCapture, resultOrErr = pcall(captureSceneAnalysis, args)
		slot.ok = okCapture
		slot.result = resultOrErr
		slot.done = true
		sceneAnalysisBusy = false
	end)
	local boundedTimeout = math.clamp(tonumber(timeoutSec) or 20, 0.1, 60)
	local waited = 0
	while not slot.done and waited < boundedTimeout do
		task.wait(0.05)
		waited += 0.05
	end
	if not slot.done then
		local cancelOk, cancelErr = pcall(function()
			task.cancel(worker)
		end)
		if cancelOk then
			sceneAnalysisBusy = false
		end
		return false,
			("scene analysis timed out after %.1fs; worker cancellation=%s%s")
				:format(
					boundedTimeout,
					tostring(cancelOk),
					if cancelOk then "" else " (" .. tostring(cancelErr) .. ")"
				)
	end
	if not slot.ok then
		return false, tostring(slot.result)
	end
	return true, slot.result
end

-- Keep played tracks referenced so they are not GC'd mid-play (play_animation).
local playingTracks = {}

-- Read-tool parity: these all work against the running server's DataModel so
-- playtest debugging mirrors the edit Executor. Edit-only tools (script editing,
-- selection, undo, asset insert) fall through to the unsupported message.
local function execute(cmd)
	local p = cmd.payload or {}
	if cmd.type == "get_runtime_status" then
		local players = Players:GetPlayers()
		local ageMs = nil
		if clientReadyAt ~= nil then
			ageMs = math.floor((os.clock() - clientReadyAt) * 1000 + 0.5)
		end
		return {
			ok = true,
			result = {
				placeName = game.Name,
				placeId = game.PlaceId,
				universeId = game.GameId,
				jobId = game.JobId,
				targetId = TARGET_ID,
				runServiceIsRunning = RunService:IsRunning(),
				dataModelState = "runtime",
					runtimeSessionId = RUNTIME_SESSION_ID,
					playerCount = #players,
					qaClientAgentCount = qaState().readyClientCount,
					clientAgentConnected = clientReadyAt ~= nil and boundPlayer ~= nil,
					clientAgentAgeMs = ageMs,
				},
			}
		elseif cmd.type == "qa_runtime_control" then
			local StudioTestService = game:GetService("StudioTestService")
			local action = tostring(p.action or "state")
			if action == "state" or action == "checkpoint" then
				local state = qaState()
				state.checkpoint = p.name
				return { ok = true, result = state }
			elseif action == "add_players" then
				local count = math.clamp(math.floor(tonumber(p.count) or 0), 1, 8)
				local before = #Players:GetPlayers()
				if before + count > 8 then
					return { ok = false, err = "AddPlayers would exceed Studio's 8-client limit" }
				end
				local okAdd, addErr = pcall(function()
					StudioTestService:AddPlayers(count)
				end)
				if not okAdd then
					return { ok = false, err = "StudioTestService:AddPlayers failed: " .. tostring(addErr) }
				end
				return { ok = true, result = { requested = count, before = before, state = qaState() } }
			elseif action == "disconnect_player" then
				local target = nil
				for index, player in ipairs(Players:GetPlayers()) do
					if (p.playerName and player.Name == p.playerName)
						or (p.userId and player.UserId == tonumber(p.userId))
						or (p.playerIndex and index == tonumber(p.playerIndex)) then
						target = player
						break
					end
				end
				if not target then
					return { ok = false, err = "disconnect target player not found" }
				end
				qaLeaveSequence += 1
				local leaveId = qaLeaveSequence
				local slot = { done = false, player = nil, result = nil }
				qaLeaveAcks[leaveId] = slot
				local sent = pcall(function()
					relay:FireClient(target, "qaLeave", leaveId)
				end)
				if not sent then
					qaLeaveAcks[leaveId] = nil
					return { ok = false, err = "could not send LeaveTest request to target client" }
				end
				local timeoutSec = math.clamp(tonumber(p.timeoutSec) or 8, 1, 30)
				local waited = 0
				while target.Parent == Players and waited < timeoutSec do
					task.wait(0.1)
					waited += 0.1
				end
				qaLeaveAcks[leaveId] = nil
				if target.Parent == Players then
					return {
						ok = false,
						err = "client did not leave before timeout",
						result = { acknowledgement = slot.result, state = qaState() },
					}
				end
				return {
					ok = true,
					result = {
						disconnected = { name = target.Name, userId = target.UserId },
						acknowledgement = slot.result,
						state = qaState(),
					},
				}
			end
			return {
				ok = false,
				err = "qa_runtime_control action must be state, checkpoint, add_players, or disconnect_player",
			}
		elseif cmd.type == "run_luau" then
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
		local ring = (p.context == "client") and clientRing or consoleRing
		local count = p.count or 100
		local levelMatch = {
			error = "MessageError",
			warning = "MessageWarning",
			output = "MessageOutput",
		}
		local want = p.levelFilter and levelMatch[p.levelFilter] or nil
		local picked = {}
		for i = #ring, 1, -1 do
			local entry = ring[i]
			if not want or entry.level == want then
				table.insert(picked, 1, entry)
				if #picked >= count then
					break
				end
			end
		end
		return { ok = true, result = { lines = picked, total = #ring } }
	elseif cmd.type == "get_playtest_output" then
		-- Drain (default) or peek both rings; feeds F5 read parity for get_playtest_output.
		local drain = p.drain ~= false
		local lines = consoleRing
		local clientLines = clientRing
		local pinnedLines = pinnedRing
		if drain then
			consoleRing = {}
			clientRing = {}
			pinnedRing = {}
		end
		local out = {
			lines = lines,
			client = clientLines,
			pinned = pinnedLines,
			pinPattern = PIN_PATTERN,
			count = #lines,
			capturing = true,
			capacity = { server = CONSOLE_RING_CAP, client = CLIENT_RING_CAP, pinned = PINNED_RING_CAP },
		}
		if #game:GetService("Players"):GetPlayers() == 0 then
			out.note = "run mode has no client"
		end
		return { ok = true, result = out }
	elseif cmd.type == "client_query" then
		local okQuery, resultOrErr = relayClientQuery(p.name, p.args, 5)
		if not okQuery then
			return { ok = false, err = resultOrErr }
		end
		return { ok = true, result = resultOrErr }
	elseif cmd.type == "client_activate" then
		local okQuery, resultOrErr = relayClientQuery("activate_gui", p, 12)
		if not okQuery then
			return { ok = false, err = resultOrErr }
		end
		if type(resultOrErr) == "table" and resultOrErr.err ~= nil then
			return { ok = false, err = tostring(resultOrErr.err), result = resultOrErr }
		end
		return { ok = true, result = resultOrErr }
	elseif cmd.type == "client_input_sequence" then
		local clientTimeout = math.clamp(tonumber(p.timeoutSec) or 30, 1, 30)
		local okQuery, resultOrErr = relayClientQuery("input_sequence", p, clientTimeout + 2)
		if not okQuery then
			return { ok = false, err = resultOrErr }
		end
		if type(resultOrErr) == "table" and resultOrErr.ok == false then
			return {
				ok = false,
				err = tostring(resultOrErr.err or "client input sequence failed"),
				result = resultOrErr,
			}
		end
		return { ok = true, result = resultOrErr }
	elseif cmd.type == "scene_analysis_snapshot" then
		local side = tostring(p.side or "both")
		if side ~= "server" and side ~= "client" and side ~= "both" then
			return { ok = false, err = "scene_analysis_snapshot side must be server, client, or both" }
		end
		local totalTimeout = math.clamp(tonumber(p.timeoutSec) or 20, 1, 60)
		local startedAt = os.clock()
		local deadline = startedAt + totalTimeout
		local snapshot = {
			side = side,
			server = nil,
			client = nil,
		}
		if side == "server" or side == "both" then
			local remaining = deadline - os.clock()
			if remaining <= 0 then
				return { ok = false, err = "scene analysis timed out before server capture" }
			end
			local okServer, serverOrErr = captureSceneAnalysisBounded(p, remaining)
			if not okServer then
				return { ok = false, err = "server scene analysis failed: " .. tostring(serverOrErr) }
			end
			if type(serverOrErr) == "table" and serverOrErr.err then
				return { ok = false, err = tostring(serverOrErr.err), result = snapshot }
			end
			snapshot.server = serverOrErr
		end
		if side == "client" or side == "both" then
			local remaining = deadline - os.clock()
			if remaining <= 0 then
				return {
					ok = false,
					err = "scene analysis timed out before client capture",
					result = snapshot,
				}
			end
			local clientArgs = {}
			for key, value in pairs(p) do
				clientArgs[key] = value
			end
			clientArgs.timeoutSec = math.max(0.1, remaining - 0.5)
			local okClient, clientOrErr =
				relayClientQuery("scene_analysis_snapshot", clientArgs, remaining)
			if not okClient then
				return {
					ok = false,
					err = "client scene analysis failed: " .. tostring(clientOrErr),
					result = snapshot,
				}
			end
			if type(clientOrErr) == "table" and clientOrErr.err then
				return {
					ok = false,
					err = tostring(clientOrErr.err),
					result = snapshot,
				}
			end
			snapshot.client = clientOrErr
		end
		snapshot.durationMs = math.floor((os.clock() - startedAt) * 1000 + 0.5)
		return { ok = true, result = snapshot }
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
	elseif cmd.type == "play_animation" then
		-- First server-context write tool: play a track on a live rig's Animator.
		local Players = game:GetService("Players")
		local targetInst
		if p.target == "player" or p.target == nil then
			local player = Players:GetPlayers()[1]
			targetInst = player and player.Character
			if not targetInst then
				return { ok = false, err = "play_animation: no player character yet" }
			end
		else
			targetInst = resolve(p.target)
			if not targetInst then
				return { ok = false, err = "play_animation: target not found: " .. tostring(p.target) }
			end
		end
		local controller = targetInst:FindFirstChildOfClass("Humanoid")
			or targetInst:FindFirstChildOfClass("AnimationController")
		if not controller then
			return { ok = false, err = "play_animation: " .. tostring(p.target) .. " has no Humanoid/AnimationController" }
		end
		local animator = controller:FindFirstChildOfClass("Animator")
		if not animator then
			animator = Instance.new("Animator")
			animator.Parent = controller
		end
		local idStr
		local rawId = p.animationId
		if type(rawId) == "number" then
			idStr = "rbxassetid://" .. tostring(math.floor(rawId))
		elseif type(rawId) == "string" and rawId ~= "" then
			if string.match(rawId, "^%d+$") then
				idStr = "rbxassetid://" .. rawId
			else
				idStr = rawId
			end
		else
			return { ok = false, err = "play_animation: invalid animationId" }
		end
		local anim = Instance.new("Animation")
		anim.AnimationId = idStr
		local okLoad, trackOrErr = pcall(function()
			return animator:LoadAnimation(anim)
		end)
		if not okLoad then
			return { ok = false, err = "play_animation: LoadAnimation failed: " .. tostring(trackOrErr) }
		end
		local track = trackOrErr
		if p.priority then
			pcall(function()
				track.Priority = Enum.AnimationPriority[p.priority]
			end)
		end
		if type(p.looped) == "boolean" then
			track.Looped = p.looped
		end
		local fadeTime = type(p.fadeTime) == "number" and p.fadeTime or 0.1
		local weight = type(p.weight) == "number" and p.weight or 1
		local speed = type(p.speed) == "number" and p.speed or 1
		local okPlay, playErr = pcall(function()
			track:Play(fadeTime, weight, speed)
		end)
		if not okPlay then
			return { ok = false, err = "play_animation: Play failed: " .. tostring(playErr) }
		end
		table.insert(playingTracks, track)
		return { ok = true, result = { length = track.Length, isPlaying = true, targetPath = targetInst:GetFullName() } }
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
-- v0.2.0: a command executes in its own task; polls continue with busy=1 so the
-- bridge keeps seeing this context alive during long server-side yields.
local busyCommand = false
local lastPollStatus = nil

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
	local port, how = resolveBridge()
	if port then
		base = urlFor(port)
		basePort = port
		sendDiag("resolve", { port = port, how = how })
		return true
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
		local result
		local nowMs = DateTime.now().UnixTimestampMillis
		if type(cmd.expectedTargetId) == "string" and cmd.expectedTargetId ~= TARGET_ID then
			result = {
				ok = false,
				err = ("command target mismatch: expected %s, current %s")
					:format(cmd.expectedTargetId, TARGET_ID),
			}
		elseif type(cmd.expiresAtMs) == "number" and cmd.expiresAtMs <= nowMs then
			result = {
				ok = false,
				err = ("command expired before execution at %d (now %d)")
					:format(cmd.expiresAtMs, nowMs),
			}
		end
		local function finish(finalResult)
			if type(finalResult) ~= "table" then
				finalResult = { ok = false, err = "handler returned no result table" }
			end
			if finalResult.ok == false then
				warn(("[MCP agent] command %q failed: %s"):format(tostring(cmd.type), tostring(finalResult.err)))
			end
			finalResult.id = cmd.id
			local postBase = base
			pcall(function()
				HttpService:RequestAsync({
					Url = (postBase or "") .. "/response",
					Method = "POST",
					Headers = responseHeaders,
					Body = HttpService:JSONEncode(finalResult),
				})
			end)
		end
		if result then
			finish(result)
			return
		end
		-- Execute in a separate task: the poll scheduler keeps running (busy=1)
		-- so a long-yielding server command cannot make the bridge drop us.
		busyCommand = true
		task.spawn(function()
			local okExec, resultOrErr = pcall(execute, cmd)
			local finalResult
			if okExec then
				finalResult = resultOrErr
			else
				sendDiag("handler_error", { cmdType = tostring(cmd.type), err = tostring(resultOrErr) })
				finalResult = { ok = false, err = "handler error: " .. tostring(resultOrErr) }
			end
			finish(finalResult)
			busyCommand = false
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
			Url = base .. "/poll?context=" .. CONTEXT .. "&targetId=" .. HttpService:UrlEncode(TARGET_ID)
				.. (if busyCommand then "&busy=1" else ""),
			Method = "GET",
			Headers = pollHeaders,
		})
		lastPollStatus = res.StatusCode
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
		sendDiag("poll_error", { err = tostring(err), status = lastPollStatus }) -- base still set here, so this reaches the bridge
		-- v0.2.0 graceful handoff: 409 (leased to another live Studio window), 401
		-- (token mismatch) and 400 (protocol mismatch) are NOT transient. Park that
		-- port and let resolveBridge() find the bridge that actually owns this
		-- window instead of hammering the wrong one every backoff tick.
		if basePort and (lastPollStatus == 409 or lastPollStatus == 401 or lastPollStatus == 400) then
			rejectedUntil[basePort] = os.clock() + REJECT_COOLDOWN
			warn(("[MCP agent] bridge :%d refused this Studio window (HTTP %d); parked for %ds, re-resolving")
				:format(basePort, lastPollStatus, REJECT_COOLDOWN))
			sendDiag("bridge_rejected", { port = basePort, status = lastPollStatus })
		end
		lastPollStatus = nil
		base = nil
		basePort = nil
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
