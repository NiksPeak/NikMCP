-- Returns the client-agent source as a string. Written into a LocalScript
-- named NikMCP_ClientAgent, injected by the edit plugin (Executor.luau
-- playtestControl) into StarterPlayer.StarterPlayerScripts BEFORE
-- ExecutePlayModeAsync -- play mode ONLY, never run mode (run has no client).
-- HttpService is server-only, so this agent never touches the bridge directly:
-- it talks to the server agent (RuntimeAgentSource) over one RemoteEvent,
-- NikMCP_ClientRelay, which the server agent creates in ReplicatedStorage.
-- No {{PORT}} token needed here -- there is no HTTP on this side.
local SOURCE = [==[
--!nonstrict
-- Roblox Studio MCP - client agent. Auto-injected by the Studio MCP plugin,
-- play mode only. Does nothing unless a client is actually running.
if not game:GetService("RunService"):IsRunning() then
	return
end

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local LogService = game:GetService("LogService")
local Players = game:GetService("Players")
local LocalPlayer = Players.LocalPlayer

local relay = ReplicatedStorage:WaitForChild("NikMCP_ClientRelay", 30)
if not relay then
	-- Server agent never created the relay (bridge/plugin not active); nothing
	-- to do on the client side.
	return
end

-- Compact serializer (only the tagged shapes client_query needs); matches the
-- server agent's conventions so the bridge/tooling sees one consistent shape.
local function serialize(v)
	local t = typeof(v)
	if t == "Vector3" then
		return { __t = "Vector3", x = v.X, y = v.Y, z = v.Z }
	elseif t == "CFrame" then
		return { __t = "CFrame", comps = { v:GetComponents() } }
	elseif t == "Color3" then
		return { __t = "Color3", r = v.R, g = v.G, b = v.B }
	end
	return v
end

-- Ring buffer of console lines, batch-flushed to the server agent at most
-- every 0.5s (task-19 lesson: no chatty per-frame fires). Capped so a burst
-- between flushes can't grow unbounded.
local PENDING_CAP = 500
local pending = {}
LogService.MessageOut:Connect(function(msg, mt)
	table.insert(pending, { text = tostring(msg), level = mt.Name, t = os.time() })
	if #pending > PENDING_CAP then
		table.remove(pending, 1)
	end
end)

task.spawn(function()
	while true do
		task.wait(0.5)
		if #pending > 0 then
			local batch = pending
			pending = {}
			pcall(function()
				relay:FireServer("logs", batch)
			end)
		end
	end
end)

-- == Fixed named queries (loadstring is server-only; arbitrary client eval is
-- NOT supported -- these are the only introspection points the client offers).

local function queryFps()
	local samples = {}
	local conn
	conn = RunService.RenderStepped:Connect(function(dt)
		if dt > 0 then
			table.insert(samples, 1 / dt)
		end
	end)
	local waited = 0
	while #samples < 30 and waited < 3 do
		task.wait(0.05)
		waited += 0.05
	end
	conn:Disconnect()
	local sum = 0
	for _, v in ipairs(samples) do
		sum += v
	end
	return { fps = (#samples > 0) and (sum / #samples) or 0 }
end

local function queryCamera()
	local cam = workspace.CurrentCamera
	if not cam then
		return { err = "no CurrentCamera" }
	end
	return { cframe = serialize(cam.CFrame), fieldOfView = cam.FieldOfView }
end

local function guiWalk(inst, depth, maxDepth)
	local node = { name = inst.Name, className = inst.ClassName }
	if depth < maxDepth then
		local kids = {}
		for _, c in ipairs(inst:GetChildren()) do
			table.insert(kids, guiWalk(c, depth + 1, maxDepth))
		end
		if #kids > 0 then
			node.children = kids
		end
	end
	return node
end

local function queryGuiTree(args)
	local playerGui = LocalPlayer:FindFirstChild("PlayerGui")
	if not playerGui then
		return { err = "no PlayerGui" }
	end
	local maxDepth = (type(args) == "table" and type(args.maxDepth) == "number") and args.maxDepth or 4
	return guiWalk(playerGui, 0, maxDepth)
end

local function queryLocalPlayer()
	local char = LocalPlayer.Character
	local position, humanoidState, health = nil, nil, nil
	if char then
		local hrp = char:FindFirstChild("HumanoidRootPart")
		if hrp then
			position = serialize(hrp.Position)
		end
		local hum = char:FindFirstChildOfClass("Humanoid")
		if hum then
			humanoidState = tostring(hum:GetState())
			health = hum.Health
		end
	end
	return { hasCharacter = char ~= nil, position = position, humanoidState = humanoidState, health = health }
end

local function queryPing()
	return { ping = LocalPlayer:GetNetworkPing() }
end

relay.OnClientEvent:Connect(function(kind, id, name, args)
	if kind ~= "query" then
		return
	end
	local ok, result = pcall(function()
		if name == "fps" then
			return queryFps()
		elseif name == "camera" then
			return queryCamera()
		elseif name == "gui_tree" then
			return queryGuiTree(args)
		elseif name == "local_player" then
			return queryLocalPlayer()
		elseif name == "ping" then
			return queryPing()
		else
			return { err = "unknown query '" .. tostring(name) .. "'; valid: fps, camera, gui_tree, local_player, ping" }
		end
	end)
	if not ok then
		result = { err = tostring(result) }
	end
	pcall(function()
		relay:FireServer("queryResult", id, result)
	end)
end)
]==]

return SOURCE
