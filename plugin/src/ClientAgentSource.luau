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
local StudioTestService = game:GetService("StudioTestService")
local GuiService = game:GetService("GuiService")
local UserInputService = game:GetService("UserInputService")
local LocalPlayer = Players.LocalPlayer

local relay = ReplicatedStorage:WaitForChild("NikMCP_ClientRelay", 30)
if not relay then
	-- Server agent never created the relay (bridge/plugin not active); nothing
	-- to do on the client side.
	return
end

pcall(function()
	relay:FireServer("ready")
	relay:FireServer("qaReady")
end)

-- Compact serializer (only the tagged shapes client_query needs); matches the
-- server agent's conventions so the bridge/tooling sees one consistent shape.
local function serialize(v)
	local t = typeof(v)
	if t == "Vector3" then
		return { __t = "Vector3", x = v.X, y = v.Y, z = v.Z }
	elseif t == "Vector2" then
		return { __t = "Vector2", x = v.X, y = v.Y }
	elseif t == "CFrame" then
		return { __t = "CFrame", comps = { v:GetComponents() } }
	elseif t == "Color3" then
		return { __t = "Color3", r = v.R, g = v.G, b = v.B }
	elseif t == "UDim2" then
		return {
			__t = "UDim2",
			xs = v.X.Scale,
			xo = v.X.Offset,
			ys = v.Y.Scale,
			yo = v.Y.Offset,
		}
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

local function guiSummary(inst, depth, maxDepth)
	local node = {
		name = inst.Name,
		className = inst.ClassName,
		visible = inst:IsA("GuiObject") and inst.Visible or nil,
		enabled = inst:IsA("ScreenGui") and inst.Enabled or nil,
		active = inst:IsA("GuiObject") and inst.Active or nil,
		absolutePosition = inst:IsA("GuiObject") and serialize(inst.AbsolutePosition) or nil,
		absoluteSize = inst:IsA("GuiObject") and serialize(inst.AbsoluteSize) or nil,
		position = inst:IsA("GuiObject") and serialize(inst.Position) or nil,
		size = inst:IsA("GuiObject") and serialize(inst.Size) or nil,
		anchorPoint = inst:IsA("GuiObject") and serialize(inst.AnchorPoint) or nil,
		zIndex = inst:IsA("GuiObject") and inst.ZIndex or nil,
		text = (inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox")) and inst.Text or nil,
		image = (inst:IsA("ImageLabel") or inst:IsA("ImageButton")) and inst.Image or nil,
	}
	if depth < maxDepth then
		local kids = {}
		for _, c in ipairs(inst:GetChildren()) do
			if c:IsA("GuiObject") or c:IsA("LayerCollector") then
				table.insert(kids, guiSummary(c, depth + 1, maxDepth))
			end
		end
		if #kids > 0 then
			node.children = kids
		end
	end
	return node
end

local function resolvePlayerGuiPath(path)
	local playerGui = LocalPlayer:FindFirstChild("PlayerGui")
	if not playerGui then
		return nil, "no PlayerGui"
	end
	local current = playerGui
	local raw = tostring(path or "")
	if string.find(string.lower(raw), "coregui", 1, true) then
		return nil, "CoreGui paths are not allowed"
	end
	raw = string.gsub(raw, "^PlayerGui%.", "")
	raw = string.gsub(raw, "^game%.Players%.LocalPlayer%.PlayerGui%.", "")
	if raw == "" or raw == "PlayerGui" then
		return playerGui
	end
	for segment in string.gmatch(raw, "[^%.]+") do
		local child = current:FindFirstChild(segment)
		if not child then
			return nil, "path not found: " .. tostring(path)
		end
		current = child
	end
	return current
end

local function queryGuiObject(args)
	if type(args) ~= "table" or type(args.path) ~= "string" then
		return { err = "gui_object requires args.path" }
	end
	local inst, err = resolvePlayerGuiPath(args.path)
	if not inst then
		return { err = err }
	end
	local maxDepth = type(args.maxDepth) == "number" and args.maxDepth or 1
	return guiSummary(inst, 0, maxDepth)
end

local function isEffectivelyVisible(inst, playerGui)
	local node = inst
	while node and node ~= playerGui do
		if node:IsA("GuiObject") and not node.Visible then
			return false
		elseif node:IsA("LayerCollector") and not node.Enabled then
			return false
		end
		node = node.Parent
	end
	return true
end

local function findScreenGui(inst)
	local node = inst
	while node do
		if node:IsA("ScreenGui") then
			return node
		end
		node = node.Parent
	end
	return nil
end

local function rectFor(inst)
	local pos = inst.AbsolutePosition
	local size = inst.AbsoluteSize
	return {
		x = pos.X,
		y = pos.Y,
		w = size.X,
		h = size.Y,
		right = pos.X + size.X,
		bottom = pos.Y + size.Y,
	}
end

local function rectIntersection(a, b)
	local width = math.min(a.right, b.right) - math.max(a.x, b.x)
	local height = math.min(a.bottom, b.bottom) - math.max(a.y, b.y)
	if width <= 0 or height <= 0 then
		return 0
	end
	return width * height
end

local function constraintState(inst)
	return {
		aspectRatio = inst:FindFirstChildWhichIsA("UIAspectRatioConstraint") ~= nil,
		size = inst:FindFirstChildWhichIsA("UISizeConstraint") ~= nil,
		textSize = inst:FindFirstChildWhichIsA("UITextSizeConstraint") ~= nil,
		scale = inst:FindFirstChildWhichIsA("UIScale") ~= nil,
	}
end

local function queryUiRegression(args)
	args = type(args) == "table" and args or {}
	local playerGui = LocalPlayer:FindFirstChild("PlayerGui")
	if not playerGui then
		return { err = "no PlayerGui" }
	end
	local camera = workspace.CurrentCamera
	if not camera then
		return { err = "no CurrentCamera" }
	end
	task.wait(math.clamp(tonumber(args.settleSeconds) or 0.5, 0, 3))
	local viewport = camera.ViewportSize
	local minTouch = math.clamp(tonumber(args.minTouchTarget) or 44, 24, 80)
	local maxObjects = math.clamp(math.floor(tonumber(args.maxObjects) or 1500), 1, 5000)
	local maxFindings = math.clamp(math.floor(tonumber(args.maxFindings) or 500), 1, 2000)
	local maxOverlapPairs = math.clamp(math.floor(tonumber(args.maxOverlapPairs) or 5000), 1, 50000)
	local findings = { critical = {}, warning = {}, info = {} }
	local screens = {}
	local objects = {}
	local interactive = {}
	local totalCandidates = 0
	local function add(severity, row)
		if #findings.critical + #findings.warning + #findings.info < maxFindings then
			table.insert(findings[severity], row)
		end
	end
	local insetTopLeft = Vector2.zero
	local insetBottomRight = Vector2.zero
	pcall(function()
		insetTopLeft, insetBottomRight = GuiService:GetGuiInset()
	end)
	for _, screen in ipairs(playerGui:GetChildren()) do
		if screen:IsA("ScreenGui") then
			local insetName = nil
			local okInset, insetValue = pcall(function()
				return screen.ScreenInsets
			end)
			if okInset and insetValue then
				insetName = insetValue.Name
			end
			table.insert(screens, {
				path = screen:GetFullName(),
				enabled = screen.Enabled,
				displayOrder = screen.DisplayOrder,
				screenInsets = insetName,
				ignoreGuiInset = screen.IgnoreGuiInset,
				zIndexBehavior = screen.ZIndexBehavior.Name,
			})
			if screen.Enabled and (insetName == "None" or screen.IgnoreGuiInset) then
				add("warning", {
					path = screen:GetFullName(),
					issueType = "safe_area_not_reserved",
					detail = "Enabled ScreenGui does not reserve Core UI/device safe area.",
					recommendation = "Use CoreUISafeInsets or TopbarSafeInsets unless edge-to-edge layout is intentional.",
				})
			end
		end
	end
	for _, inst in ipairs(playerGui:GetDescendants()) do
		if inst:IsA("GuiObject") then
			totalCandidates += 1
			if #objects < maxObjects and isEffectivelyVisible(inst, playerGui) then
				local rect = rectFor(inst)
				local screen = findScreenGui(inst)
				local constraints = constraintState(inst)
				local row = {
					instance = inst,
					path = inst:GetFullName(),
					className = inst.ClassName,
					rect = rect,
					screenPath = screen and screen:GetFullName() or nil,
					zIndex = inst.ZIndex,
					active = inst.Active,
					selectable = inst.Selectable,
					position = serialize(inst.Position),
					size = serialize(inst.Size),
					constraints = constraints,
				}
				table.insert(objects, row)
				if inst:IsA("GuiButton") or inst.Active or inst.Selectable then
					table.insert(interactive, row)
				end
				if rect.w <= 0 or rect.h <= 0 then
					add("critical", {
						path = row.path,
						issueType = "zero_size",
						detail = ("AbsoluteSize is %.1fx%.1f."):format(rect.w, rect.h),
						recommendation = "Fix parent sizing, constraints, or visibility state.",
					})
				elseif rect.right <= 0 or rect.bottom <= 0 or rect.x >= viewport.X or rect.y >= viewport.Y then
					add("critical", {
						path = row.path,
						issueType = "fully_offscreen",
						rect = rect,
						recommendation = "Move or scale the object inside the live viewport.",
					})
				elseif rect.x < 0 or rect.y < 0 or rect.right > viewport.X or rect.bottom > viewport.Y then
					add("warning", {
						path = row.path,
						issueType = "partially_offscreen",
						rect = rect,
						recommendation = "Inspect anchors, scale, and safe-area handling on this device.",
					})
				end
				local parent = inst.Parent
				while parent and parent ~= playerGui do
					if parent:IsA("GuiObject") and parent.ClipsDescendants then
						local parentRect = rectFor(parent)
						if rect.x < parentRect.x or rect.y < parentRect.y
							or rect.right > parentRect.right or rect.bottom > parentRect.bottom then
							add("warning", {
								path = row.path,
								relatedPath = parent:GetFullName(),
								issueType = "clipped_by_ancestor",
								recommendation = "Resize/reposition the child or adjust the intended clipping container.",
							})
							break
						end
					end
					parent = parent.Parent
				end
				if (inst:IsA("GuiButton") or inst.Active) and (rect.w < minTouch or rect.h < minTouch) then
					add("warning", {
						path = row.path,
						issueType = "tiny_touch_target",
						detail = ("Interactive target is %.1fx%.1f; minimum is %d."):format(rect.w, rect.h, minTouch),
						recommendation = "Increase the active hit area without inflating the visual unnecessarily.",
					})
				end
				local size = inst.Size
				local heavyX = size.X.Scale == 0 and math.abs(size.X.Offset) > math.max(24, viewport.X * 0.12)
				local heavyY = size.Y.Scale == 0 and math.abs(size.Y.Offset) > math.max(24, viewport.Y * 0.12)
				if (heavyX or heavyY) and not constraints.size and not constraints.scale then
					add("warning", {
						path = row.path,
						issueType = "heavy_offset_sizing",
						detail = "Large fixed Offset sizing has no UISizeConstraint or UIScale support.",
						recommendation = "Use scale-led sizing plus constraints for cross-device stability.",
					})
				elseif size.X.Offset ~= 0 or size.Y.Offset ~= 0 then
					add("info", {
						path = row.path,
						issueType = "offset_component_present",
						detail = "Size contains Offset components.",
						recommendation = "Confirm the fixed pixels are intentional on phone, tablet, and desktop.",
					})
				end
				if (inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox"))
					and inst.TextScaled and not constraints.textSize then
					add("warning", {
						path = row.path,
						issueType = "textscaled_without_constraint",
						recommendation = "Add UITextSizeConstraint to prevent unreadably small or oversized text.",
					})
				end
			end
		end
	end
	local overlapPairsChecked = 0
	local overlapTruncated = false
	for i = 1, #interactive do
		for j = i + 1, #interactive do
			overlapPairsChecked += 1
			if overlapPairsChecked > maxOverlapPairs then
				overlapTruncated = true
				break
			end
			local a = interactive[i]
			local b = interactive[j]
			if a.screenPath == b.screenPath
				and not a.instance:IsDescendantOf(b.instance)
				and not b.instance:IsDescendantOf(a.instance) then
				local intersection = rectIntersection(a.rect, b.rect)
				local smaller = math.min(a.rect.w * a.rect.h, b.rect.w * b.rect.h)
				if smaller > 0 and intersection / smaller >= 0.25 and a.zIndex == b.zIndex then
					add("warning", {
						paths = { a.path, b.path },
						issueType = "interactive_overlap",
						overlapRatio = intersection / smaller,
						recommendation = "Separate the hit targets or establish intentional z-order and input priority.",
					})
				end
			end
		end
		if overlapTruncated then break end
	end
	local totalFindings = #findings.critical + #findings.warning + #findings.info
	return {
		evidenceType = "live_state_and_layout",
		screenshot = {
			supported = false,
			reason = "NikMCP's fixed client protocol returns layout state only; it does not capture client pixels.",
		},
		viewport = { width = viewport.X, height = viewport.Y },
		guiInset = {
			topLeft = serialize(insetTopLeft),
			bottomRight = serialize(insetBottomRight),
		},
		screenGuis = screens,
		summary = {
			totalCandidates = totalCandidates,
			objectsInspected = #objects,
			objectsTruncated = totalCandidates > #objects,
			interactiveObjects = #interactive,
			overlapPairsChecked = overlapPairsChecked,
			overlapPairsTruncated = overlapTruncated,
			critical = #findings.critical,
			warning = #findings.warning,
			info = #findings.info,
			totalFindings = totalFindings,
			findingsTruncated = totalFindings >= maxFindings,
		},
		findings = findings,
	}
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
		context = "client",
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
		return game:GetService("HttpService"):JSONEncode(result)
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

local function captureSceneAnalysisBounded(args)
	if sceneAnalysisBusy then
		return { err = "a previous client scene analysis is still running" }
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
	local timeoutSec = math.clamp(tonumber(args and args.timeoutSec) or 20, 0.1, 60)
	local waited = 0
	while not slot.done and waited < timeoutSec do
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
		return {
			err = ("client scene analysis timed out after %.1fs; worker cancellation=%s%s")
				:format(
					timeoutSec,
					tostring(cancelOk),
					if cancelOk then "" else " (" .. tostring(cancelErr) .. ")"
				),
		}
	end
	if not slot.ok then
		return { err = tostring(slot.result) }
	end
	return slot.result
end

local function inputStepKind(step)
	return tostring(step.type or step.kind or step.action or "")
end

local function keyStepAction(step)
	local action = step.keyAction or step.mode
	if action == nil and (step.type == "key" or step.kind == "key") then
		action = step.action
	end
	return tostring(action or "tap")
end

local function finiteNumber(raw, label)
	local value = tonumber(raw)
	if not value or value ~= value or value == math.huge or value == -math.huge then
		error(label .. " must be a finite number", 0)
	end
	return value
end

local function inputScreenPoint(step)
	local camera = workspace.CurrentCamera
	if not camera then
		error("no CurrentCamera", 0)
	end
	local position
	local targetPath = nil
	local requestedPath = step.target or step.path
	if type(requestedPath) == "string" and requestedPath ~= "" then
		local target, targetErr = resolvePlayerGuiPath(requestedPath)
		if not target then
			error(targetErr, 0)
		end
		if not target:IsA("GuiObject") then
			error("input target must resolve to a GuiObject under PlayerGui", 0)
		end
		local playerGui = LocalPlayer:FindFirstChild("PlayerGui")
		if not playerGui or not isEffectivelyVisible(target, playerGui) then
			error("input target is not effectively visible", 0)
		end
		if target.AbsoluteSize.X <= 0 or target.AbsoluteSize.Y <= 0 then
			error("input target has zero AbsoluteSize", 0)
		end
		position = target.AbsolutePosition + (target.AbsoluteSize / 2)
		targetPath = target:GetFullName()
	else
		position = Vector2.new(
			finiteNumber(step.x, "x"),
			finiteNumber(step.y, "y")
		)
	end
	local viewport = camera.ViewportSize
	if position.X < 0 or position.Y < 0 or position.X >= viewport.X or position.Y >= viewport.Y then
		error(("input position %.1f, %.1f is outside viewport %.1f x %.1f"):format(
			position.X,
			position.Y,
			viewport.X,
			viewport.Y
		), 0)
	end
	return position, targetPath
end

local function mouseButton(raw)
	local name = tostring(raw or "MouseButton1")
	local button = Enum.UserInputType[name]
	if name ~= "MouseButton1" and name ~= "MouseButton2" and name ~= "MouseButton3" then
		error("button must be MouseButton1, MouseButton2, or MouseButton3", 0)
	end
	return button, name
end

local function assertGuiStep(step)
	if type(step.path) ~= "string" or step.path == "" then
		error("assert_gui requires path", 0)
	end
	local inst, pathErr = resolvePlayerGuiPath(step.path)
	if not inst then
		error(pathErr, 0)
	end
	local property = tostring(step.property or "")
	local actual
	if property == "visible" then
		if not inst:IsA("GuiObject") then error("visible requires a GuiObject", 0) end
		actual = inst.Visible
	elseif property == "effectiveVisible" then
		if not inst:IsA("GuiObject") then error("effectiveVisible requires a GuiObject", 0) end
		local playerGui = LocalPlayer:FindFirstChild("PlayerGui")
		actual = playerGui ~= nil and isEffectivelyVisible(inst, playerGui)
	elseif property == "enabled" then
		if not inst:IsA("LayerCollector") then error("enabled requires a LayerCollector", 0) end
		actual = inst.Enabled
	elseif property == "active" then
		if not inst:IsA("GuiObject") then error("active requires a GuiObject", 0) end
		actual = inst.Active
	elseif property == "selectable" then
		if not inst:IsA("GuiObject") then error("selectable requires a GuiObject", 0) end
		actual = inst.Selectable
	elseif property == "selected" then
		actual = GuiService.SelectedObject == inst
	elseif property == "text" then
		if not (inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox")) then
			error("text requires a text GuiObject", 0)
		end
		actual = inst.Text
	elseif property == "className" then
		actual = inst.ClassName
	else
		error("assert_gui property must be visible, effectiveVisible, enabled, active, selectable, selected, text, or className", 0)
	end
	local expected = step.equals
	if expected == nil and step.value ~= nil then
		expected = step.value
	end
	if actual ~= expected then
		error(("assert_gui failed for %s.%s: expected %s, got %s"):format(
			inst:GetFullName(),
			property,
			tostring(expected),
			tostring(actual)
		), 0)
	end
	return {
		path = inst:GetFullName(),
		property = property,
		expected = serialize(expected),
		actual = serialize(actual),
	}
end

local function queryInputSequence(args)
	args = type(args) == "table" and args or {}
	local steps = args.steps
	if type(steps) ~= "table" or #steps < 1 then
		return { ok = false, err = "input_sequence requires a non-empty steps array" }
	end
	if #steps > 40 then
		return { ok = false, err = "input_sequence supports at most 40 steps" }
	end
	local timeoutSec = math.clamp(tonumber(args.timeoutSec) or 30, 1, 30)
	local scheduledSeconds = 0
	for _, step in ipairs(steps) do
		if type(step) ~= "table" then
			return { ok = false, err = "each input step must be an object" }
		end
		local kind = inputStepKind(step)
		if kind == "wait" then
			scheduledSeconds += tonumber(step.seconds or step.durationSec) or 0
		elseif kind == "key" and keyStepAction(step) == "tap" then
			scheduledSeconds += tonumber(step.holdSeconds) or 0.05
		elseif kind == "click" then
			scheduledSeconds += tonumber(step.holdSeconds) or 0.05
		end
	end
	if scheduledSeconds > timeoutSec then
		return {
			ok = false,
			err = ("scheduled waits/holds total %.2fs, exceeding timeoutSec %.2fs"):format(scheduledSeconds, timeoutSec),
		}
	end
	local okVirtual, virtualOrErr = pcall(function()
		return UserInputService:CreateVirtualInput()
	end)
	if not okVirtual or not virtualOrErr then
		return {
			ok = false,
			err = "UserInputService:CreateVirtualInput() is unavailable: " .. tostring(virtualOrErr),
		}
	end
	local virtualInput = virtualOrErr
	local startedAt = os.clock()
	local deadline = startedAt + timeoutSec
	local evidence = {}
	local pressedKeys = {}
	local pressedButtons = {}
	local cleanup = { keysReleased = {}, buttonsReleased = {}, errors = {} }
	local function cleanupInputs()
		for keyCode, keyName in pairs(pressedKeys) do
			local okRelease, releaseErr = pcall(function()
				virtualInput:SendKey(false, keyCode, false)
			end)
			if okRelease then
				table.insert(cleanup.keysReleased, keyName)
			else
				table.insert(cleanup.errors, tostring(releaseErr))
			end
		end
		for buttonName, row in pairs(pressedButtons) do
			local okRelease, releaseErr = pcall(function()
				virtualInput:SendMouseButton(row.position, row.button, false, row.repeatCount or 0)
			end)
			if okRelease then
				table.insert(cleanup.buttonsReleased, buttonName)
			else
				table.insert(cleanup.errors, tostring(releaseErr))
			end
		end
	end
	local failedIndex = nil
	local failedError = nil
	for index, step in ipairs(steps) do
		if os.clock() >= deadline then
			failedIndex = index
			failedError = "input sequence timeout reached"
			break
		end
		local stepStarted = os.clock()
		local kind = inputStepKind(step)
		local okStep, detailOrErr = pcall(function()
			if kind == "wait" then
				local seconds = finiteNumber(step.seconds or step.durationSec, "wait seconds")
				if seconds < 0 or seconds > 5 then
					error("wait seconds must be between 0 and 5", 0)
				end
				if os.clock() + seconds > deadline then
					error("wait would exceed input sequence timeout", 0)
				end
				task.wait(seconds)
				return { seconds = seconds }
			elseif kind == "key" then
				local keyName = tostring(step.keyCode or step.key or "")
				if keyName == "" then error("key step requires keyCode", 0) end
				local keyCode = Enum.KeyCode[keyName]
				if not keyCode or keyCode == Enum.KeyCode.Unknown then
					error("invalid keyCode: " .. keyName, 0)
				end
				local action = keyStepAction(step)
				if action ~= "tap" and action ~= "down" and action ~= "up" then
					error("key action must be tap, down, or up", 0)
				end
				if action == "down" then
					virtualInput:SendKey(true, keyCode, false)
					pressedKeys[keyCode] = keyName
				elseif action == "up" then
					virtualInput:SendKey(false, keyCode, false)
					pressedKeys[keyCode] = nil
				else
					local holdSeconds = finiteNumber(step.holdSeconds or 0.05, "key holdSeconds")
					if holdSeconds < 0 or holdSeconds > 2 then
						error("key holdSeconds must be between 0 and 2", 0)
					end
					if os.clock() + holdSeconds > deadline then
						error("key tap would exceed input sequence timeout", 0)
					end
					virtualInput:SendKey(true, keyCode, false)
					pressedKeys[keyCode] = keyName
					task.wait(holdSeconds)
					virtualInput:SendKey(false, keyCode, false)
					pressedKeys[keyCode] = nil
				end
				return { keyCode = keyName, action = action }
			elseif kind == "move" then
				local position, targetPath = inputScreenPoint(step)
				virtualInput:SendMousePosition(position)
				return { position = serialize(position), targetPath = targetPath }
			elseif kind == "click" then
				local position, targetPath = inputScreenPoint(step)
				local button, buttonName = mouseButton(step.button)
				local holdSeconds = finiteNumber(step.holdSeconds or 0.05, "click holdSeconds")
				local repeatCount = finiteNumber(step.repeatCount or 0, "click repeatCount")
				if holdSeconds < 0 or holdSeconds > 2 then
					error("click holdSeconds must be between 0 and 2", 0)
				end
				if repeatCount < 0 or repeatCount > 3 or repeatCount ~= math.floor(repeatCount) then
					error("click repeatCount must be an integer between 0 and 3", 0)
				end
				if os.clock() + holdSeconds > deadline then
					error("click would exceed input sequence timeout", 0)
				end
				virtualInput:SendMousePosition(position)
				virtualInput:SendMouseButton(position, button, true, repeatCount)
				pressedButtons[buttonName] = {
					button = button,
					position = position,
					repeatCount = repeatCount,
				}
				task.wait(holdSeconds)
				virtualInput:SendMouseButton(position, button, false, repeatCount)
				pressedButtons[buttonName] = nil
				return {
					position = serialize(position),
					targetPath = targetPath,
					button = buttonName,
					repeatCount = repeatCount,
				}
			elseif kind == "text" then
				if type(step.text) ~= "string" then error("text step requires a string", 0) end
				if #step.text > 4000 then error("text input is capped at 4000 bytes", 0) end
				virtualInput:SendTextInput(step.text)
				return { bytes = #step.text }
			elseif kind == "pointer" then
				local position, targetPath = inputScreenPoint(step)
				local wheel = finiteNumber(step.wheel or 0, "pointer wheel")
				local pinch = finiteNumber(step.pinch or 0, "pointer pinch")
				local panX = 0
				local panY = 0
				if type(step.pan) == "table" then
					panX = finiteNumber(step.pan.x or step.pan[1] or 0, "pointer pan.x")
					panY = finiteNumber(step.pan.y or step.pan[2] or 0, "pointer pan.y")
				else
					panX = finiteNumber(step.panX or 0, "pointer panX")
					panY = finiteNumber(step.panY or 0, "pointer panY")
				end
				if math.abs(wheel) > 100 then error("pointer wheel must be between -100 and 100", 0) end
				if math.abs(pinch) > 100 then error("pointer pinch must be between -100 and 100", 0) end
				if math.abs(panX) > 2000 or math.abs(panY) > 2000 then
					error("pointer pan components must be between -2000 and 2000", 0)
				end
				if wheel == 0 and pinch == 0 and panX == 0 and panY == 0 then
					error("pointer requires a non-zero wheel, pan, or pinch value", 0)
				end
				local pointerAction = {
					Wheel = wheel,
					Pan = Vector2.new(panX, panY),
					Pinch = pinch,
				}
				virtualInput:SendPointerAction(position, pointerAction)
				return {
					position = serialize(position),
					targetPath = targetPath,
					wheel = wheel,
					pan = serialize(pointerAction.Pan),
					pinch = pinch,
				}
			elseif kind == "assert_gui" then
				return assertGuiStep(step)
			end
			error("unsupported input step type: " .. kind, 0)
		end)
		local row = {
			index = index,
			type = kind,
			ok = okStep,
			durationMs = math.floor((os.clock() - stepStarted) * 1000 + 0.5),
		}
		if okStep then
			row.detail = detailOrErr
		else
			row.err = "virtual input step failed (CoreGui focus/overlap and invalid input state are engine-rejected): "
				.. tostring(detailOrErr)
		end
		table.insert(evidence, row)
		if not okStep then
			failedIndex = index
			failedError = row.err
			break
		end
	end
	cleanupInputs()
	if failedIndex then
		return {
			ok = false,
			err = failedError,
			failedStep = failedIndex,
			completedSteps = failedIndex - 1,
			durationMs = math.floor((os.clock() - startedAt) * 1000 + 0.5),
			steps = evidence,
			cleanup = cleanup,
		}
	end
	return {
		ok = true,
		completedSteps = #steps,
		durationMs = math.floor((os.clock() - startedAt) * 1000 + 0.5),
		steps = evidence,
		cleanup = cleanup,
	}
end

-- v0.2.0: activate a named GuiButton without coordinates. Evidence-first: we
-- listen for the button's own Activated signal and report whether it fired.
-- click  = official VirtualInput mouse press/release at the live center
-- gamepad = GuiService.SelectedObject + virtual ButtonA tap (Activated fires on
--		   the selected GuiButton), SelectedObject restored afterwards
local function queryActivateGui(args)
	args = type(args) == "table" and args or {}
	local path = args.path
	if type(path) ~= "string" or path == "" then
		return { err = "activate_gui requires path" }
	end
	local inst, pathErr = resolvePlayerGuiPath(path)
	if not inst then
		return { err = pathErr }
	end
	if not inst:IsA("GuiButton") then
		return { err = ("activate_gui target must be a GuiButton (got %s at %s)"):format(inst.ClassName, inst:GetFullName()) }
	end
	local playerGui = LocalPlayer:FindFirstChild("PlayerGui")
	if not playerGui or not isEffectivelyVisible(inst, playerGui) then
		return { err = "target GuiButton is not effectively visible: " .. inst:GetFullName() }
	end
	local method = tostring(args.method or "auto")
	if method ~= "auto" and method ~= "click" and method ~= "gamepad" then
		return { err = "method must be auto, click, or gamepad" }
	end
	local holdSeconds = math.clamp(tonumber(args.holdSeconds) or 0.05, 0, 2)
	local waitSec = math.clamp(tonumber(args.waitForActivatedSec) or 0.75, 0.05, 5)
	local okVirtual, virtualOrErr = pcall(function()
		return UserInputService:CreateVirtualInput()
	end)
	if not okVirtual or not virtualOrErr then
		return { err = "UserInputService:CreateVirtualInput() is unavailable: " .. tostring(virtualOrErr) }
	end
	local virtualInput = virtualOrErr
	local function snapshot()
		local state = {
			visible = inst.Visible,
			active = inst.Active,
			selectable = inst.Selectable,
			absolutePosition = serialize(inst.AbsolutePosition),
			absoluteSize = serialize(inst.AbsoluteSize),
			selected = GuiService.SelectedObject == inst,
		}
		if inst:IsA("TextButton") then
			state.text = inst.Text
		end
		pcall(function()
			state.guiState = tostring((inst :: any).GuiState)
		end)
		return state
	end
	local activatedCount = 0
	local clickCount = 0
	local activatedConn = inst.Activated:Connect(function()
		activatedCount += 1
	end)
	local clickConn = inst.MouseButton1Click:Connect(function()
		clickCount += 1
	end)
	local function waitActivated()
		local t0 = os.clock()
		while activatedCount == 0 and os.clock() - t0 < waitSec do
			task.wait(0.05)
		end
		return activatedCount > 0
	end
	local function tryClick()
		local position = inst.AbsolutePosition + (inst.AbsoluteSize / 2)
		local camera = workspace.CurrentCamera
		if camera then
			local viewport = camera.ViewportSize
			if position.X < 0 or position.Y < 0 or position.X >= viewport.X or position.Y >= viewport.Y then
				return { method = "click", ok = false, err = "button center is outside the viewport", position = serialize(position) }
			end
		end
		local okSend, sendErr = pcall(function()
			virtualInput:SendMousePosition(position)
			virtualInput:SendMouseButton(position, Enum.UserInputType.MouseButton1, true, 0)
			task.wait(holdSeconds)
			virtualInput:SendMouseButton(position, Enum.UserInputType.MouseButton1, false, 0)
		end)
		if not okSend then
			pcall(function()
				virtualInput:SendMouseButton(position, Enum.UserInputType.MouseButton1, false, 0)
			end)
			return { method = "click", ok = false, err = tostring(sendErr), position = serialize(position) }
		end
		return { method = "click", ok = waitActivated(), position = serialize(position) }
	end
	local function tryGamepad()
		local previous = GuiService.SelectedObject
		local okSend, sendErr = pcall(function()
			GuiService.SelectedObject = inst
			task.wait(0.05)
			virtualInput:SendKey(true, Enum.KeyCode.ButtonA, false)
			task.wait(holdSeconds)
			virtualInput:SendKey(false, Enum.KeyCode.ButtonA, false)
		end)
		local fired = okSend and waitActivated() or false
		pcall(function()
			virtualInput:SendKey(false, Enum.KeyCode.ButtonA, false)
			GuiService.SelectedObject = previous
		end)
		if not okSend then
			return { method = "gamepad", ok = false, err = tostring(sendErr) }
		end
		return { method = "gamepad", ok = fired }
	end
	local before = snapshot()
	local attempts = {}
	if method == "click" or method == "auto" then
		table.insert(attempts, tryClick())
	end
	if activatedCount == 0 and (method == "gamepad" or method == "auto") then
		table.insert(attempts, tryGamepad())
	end
	local after = snapshot()
	activatedConn:Disconnect()
	clickConn:Disconnect()
	local expectation = nil
	if type(args.expect) == "table" then
		local afterSec = math.clamp(tonumber(args.expect.afterSec) or 0.25, 0, 5)
		if afterSec > 0 then
			task.wait(afterSec)
		end
		local okAssert, detailOrErr = pcall(assertGuiStep, args.expect)
		expectation = if okAssert then { ok = true, detail = detailOrErr } else { ok = false, err = tostring(detailOrErr) }
	end
	local fired = activatedCount > 0
	local result = {
		path = inst:GetFullName(),
		className = inst.ClassName,
		method = method,
		activatedFired = fired,
		activatedCount = activatedCount,
		mouseButton1ClickCount = clickCount,
		attempts = attempts,
		before = before,
		after = after,
		expectation = expectation,
	}
	if not fired then
		result.err = "GuiButton.Activated did not fire for " .. inst:GetFullName()
			.. " (tried " .. tostring(#attempts) .. " method(s); is the button covered, inactive, or outside the viewport?)"
	elseif expectation and not expectation.ok then
		result.err = "activated, but expectation failed: " .. tostring(expectation.err)
	end
	return result
end

relay.OnClientEvent:Connect(function(kind, id, name, args)
	if kind == "qaLeave" then
		local canLeave = false
		local okCan, canResult = pcall(function()
			return StudioTestService:CanLeaveTest()
		end)
		local canError = nil
		if okCan then
			canLeave = canResult == true
		else
			canError = tostring(canResult)
		end
		pcall(function()
			relay:FireServer("qaLeaveAck", id, {
				accepted = canLeave,
				error = canError,
			})
		end)
		if canLeave then
			task.defer(function()
				pcall(function()
					StudioTestService:LeaveTest()
				end)
			end)
		end
		return
	end
	if kind ~= "query" then
		return
	end
	local ok, result = pcall(function()
		if name == "activate_gui" then
			return queryActivateGui(args)
		elseif name == "fps" then
			return queryFps()
		elseif name == "camera" then
			return queryCamera()
		elseif name == "gui_tree" then
			return queryGuiTree(args)
		elseif name == "gui_object" then
			return queryGuiObject(args)
		elseif name == "ui_regression" then
			return queryUiRegression(args)
		elseif name == "local_player" then
			return queryLocalPlayer()
		elseif name == "ping" then
			return queryPing()
		elseif name == "input_sequence" then
			return queryInputSequence(args)
		elseif name == "scene_analysis_snapshot" then
			return captureSceneAnalysisBounded(args)
		else
			return {
				err = "unknown query '" .. tostring(name)
					.. "'; valid: fps, camera, gui_tree, gui_object, ui_regression, local_player, ping, input_sequence, activate_gui, scene_analysis_snapshot",
			}
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
