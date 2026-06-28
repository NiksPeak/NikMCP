-- Roblox Studio MCP plugin entry point (edit context).
-- Server (Node bridge) is the source of truth; this plugin only probes, polls,
-- executes commands, and reports status. Dual-context: the F5 runtime agent
-- lives in RuntimeAgentSource.luau and is kept present in ServerScriptService
-- while armed, so any F5 (including Claude Code's auto-F5) is covered.
local HttpService = game:GetService("HttpService")
local ServerScriptService = game:GetService("ServerScriptService")
local ScriptEditorService = game:GetService("ScriptEditorService")

local Config = require(script.Config)
local Settings = require(script.Settings)
local Executor = require(script.Executor)
local StatusWidget = require(script.StatusWidget)
local RuntimeAgentSource = require(script.RuntimeAgentSource)

local CONTEXT = "edit"
local AGENT_NAME = "MCP_RuntimeAgent"
local SETTING_PORTS = "NikMCP_CandidatePorts_v2"
local SETTING_ARMED = "NikMCP_PlaytestArmed"
local SETTING_PORT_DIR = "NikMCP_PortDir"
local SETTING_SETTINGS = "NikMCP_Settings"
local SETTING_SELECTED = "NikMCP_SelectedPort"

-- == Candidate ports (persisted per-user; seeded with the auto-bind range) ====
local function loadPorts(): { number }
	local stored = plugin:GetSetting(SETTING_PORTS)
	if type(stored) == "table" then
		local out: { number } = {}
		for _, p in ipairs(stored) do
			if type(p) == "number" then
				table.insert(out, p)
			end
		end
		-- One-time rebase migration: a saved list whose base (first) port isn't the
		-- current DEFAULT_PORT predates the 49200->58741 rebase. Discard it so the
		-- dock defaults to 58741 like a fresh/published install. The reseed below is
		-- persisted, so once the base matches DEFAULT_PORT this never fires again and
		-- user-added chips survive normally.
		if #out > 0 and out[1] == Config.DEFAULT_PORT then
			return out
		end
	end
	-- fresh install (or post-rebase reset): seed the whole auto-bind range so each
	-- terminal's bridge has a chip, and persist it so the migration runs once.
	local seed: { number } = {}
	for _, p in ipairs(Config.CANDIDATE_PORTS) do
		table.insert(seed, p)
	end
	plugin:SetSetting(SETTING_PORTS, seed)
	return seed
end

local candidatePorts = loadPorts()
local function savePorts()
	plugin:SetSetting(SETTING_PORTS, candidatePorts)
end

local function loadArmed(): boolean
	local v = plugin:GetSetting(SETTING_ARMED)
	if type(v) == "boolean" then
		return v
	end
	return true -- default ON: F5 is covered out of the box
end

local function loadPortDir(): string
	local v = plugin:GetSetting(SETTING_PORT_DIR)
	return (v == "down") and "down" or "up" -- default "up"
end

-- Restore the last-selected port (must still be in the list), else the first.
local function loadSelectedPort(): number?
	local v = plugin:GetSetting(SETTING_SELECTED)
	if type(v) == "number" then
		for _, p in ipairs(candidatePorts) do
			if p == v then
				return v
			end
		end
	end
	return candidatePorts[1]
end

-- == Settings (tool gating + flags; plugin is source of truth) ===============
local function loadSettings(): { [string]: any }
	local raw = plugin:GetSetting(SETTING_SETTINGS)
	if type(raw) == "string" then
		local ok, decoded = pcall(function()
			return HttpService:JSONDecode(raw)
		end)
		if ok then
			return Settings.normalize(decoded)
		end
	end
	return Settings.normalize(raw) -- handles tables and nil
end

local settings = loadSettings()
local function saveSettings()
	local ok, json = pcall(function()
		return HttpService:JSONEncode(settings)
	end)
	if ok then
		plugin:SetSetting(SETTING_SETTINGS, json)
	end
end

-- Auth header (only when enabled + token set); nil otherwise.
local function authHeaders(): { [string]: string }?
	if settings.auth.enabled and settings.auth.token ~= "" then
		return { ["x-mcp-token"] = settings.auth.token }
	end
	return nil
end

-- == Connection state ========================================================
-- Each port is an INDEPENDENT, persistent connection with its own poll loop.
-- `connections[port]` exists while that port is connecting/connected; selection
-- is display-only (which connection the Status tab shows). Many can be live.
type Conn = {
	port: number,
	state: string, -- "connecting" | "connected"
	running: boolean, -- false = its loop should exit (Disconnect / unload)
	backoff: number,
	warned: string?, -- rate-limit: emit each state's diagnostic once
	serverAlive: boolean, -- this port's `server` flag from the poll/heartbeat (playtest live)
	commandsProven: boolean,
}
local connections: { [number]: Conn } = {}
local selectedPort: number? = loadSelectedPort()
local armed = loadArmed()
local lastEnsureOk = true -- did the most recent agent ensure/inject succeed?
local pluginRunning = true -- false on Unloading -> every connection loop exits

-- == Networking ============================================================
local function urlFor(port: number): string
	return ("http://127.0.0.1:%d"):format(port) -- always IPv4; localhost -> ::1 is refused on Windows
end

-- POST the current settings to ONE bridge (its own /settings). tokenOverride
-- forces a specific token header (used when disabling auth: the server still
-- requires the OLD token for that one request before it clears it).
local function pushSettingsTo(port: number, tokenOverride: string?)
	local ok, json = pcall(function()
		return HttpService:JSONEncode(settings)
	end)
	if not ok then
		return
	end
	local headers = authHeaders()
	if tokenOverride and tokenOverride ~= "" then
		headers = { ["x-mcp-token"] = tokenOverride }
	end
	pcall(function()
		HttpService:PostAsync(
			urlFor(port) .. "/settings",
			json,
			Enum.HttpContentType.ApplicationJson,
			false,
			headers
		)
	end)
end

-- Push current settings to every connected bridge (on any settings change).
local function pushSettingsAll(tokenOverride: string?)
	for port in pairs(connections) do
		pushSettingsTo(port, tokenOverride)
	end
end

local function backoffIntervalFor(conn: Conn): number
	local steps = Config.BACKOFF_STEPS
	local idx = math.min(conn.backoff, #steps)
	if idx < 1 then
		return Config.POLL_INTERVAL
	end
	return math.min(steps[idx], Config.BACKOFF_CAP)
end

-- == Playtest agent ========================================================
-- Full create-or-rewrite. Archivable so Play Solo (F5) clones it into the play
-- server DataModel; the agent is inert in edit (`if not RunService:IsRunning()`).
local function enablePlaytestAgent(port: number): (boolean, string?)
	local existing = ServerScriptService:FindFirstChild(AGENT_NAME)
	local agent = existing or Instance.new("Script")
	agent.Name = AGENT_NAME
	agent.Archivable = true
	agent.Parent = ServerScriptService -- parent before writing source (UpdateSourceAsync needs DataModel)
	agent:SetAttribute("McpPort", port)
	agent:SetAttribute("McpToken", (settings.auth.enabled and settings.auth.token) or "")

	local source = (RuntimeAgentSource:gsub("{{PORT}}", tostring(port)))
	local ok = pcall(function()
		ScriptEditorService:UpdateSourceAsync(agent, function()
			return source
		end)
	end)
	if ok then
		return true
	end
	-- fallback to .Source (edit context only); bind a local first (never lead with `(`)
	local target = agent :: any
	local fbOk, fbErr = pcall(function()
		target.Source = source
	end)
	if not fbOk then
		return false, tostring(fbErr)
	end
	return true
end

-- Idempotent: inject only when missing, so the poll loop never re-writes source
-- every tick. Present already => no-op (just keep Archivable true).
local function ensureAgent(port: number): boolean
	local existing = ServerScriptService:FindFirstChild(AGENT_NAME)
	if existing then
		existing.Archivable = true
		lastEnsureOk = true
		return true
	end
	local ok, err = enablePlaytestAgent(port)
	lastEnsureOk = ok
	if not ok then
		warn(("[NikMCP] playtest agent injection failed: %s"):format(tostring(err)))
	end
	return ok
end

local function removeAgent()
	local existing = ServerScriptService:FindFirstChild(AGENT_NAME)
	if existing then
		existing:Destroy()
	end
end

-- == UI / status widget ====================================================
local toolbar = plugin:CreateToolbar("Studio MCP")
local toggleButton = toolbar:CreateButton("MCP Status", "Show/hide the MCP status panel", "")
local agentButton = toolbar:CreateButton(
	"Playtest Agent",
	"Arm/disarm the F5 playtest agent. Armed: any F5 (incl. auto-F5) is covered. "
		.. "Note: while armed the agent Script saves with the place - disarm before publishing if you don't want it shipped.",
	""
)

local status = StatusWidget.new(plugin)
status.defaultPort = Config.DEFAULT_PORT -- used to suggest the first port when the list is empty
status:setDirection(loadPortDir()) -- persisted "+" suggestion direction (default "up")
toggleButton.Click:Connect(function()
	status:toggle()
end)

-- internal state is lowercase; the widget wants display-cased labels
local DISPLAY = { connected = "Connected", connecting = "Connecting", disconnected = "Disconnected" }

-- Compact target string for the Activity log (truncated).
local function activityTarget(cmd: any): string
	local p = cmd.payload or {}
	if type(p.path) == "string" then
		return p.path
	elseif type(p.parentPath) == "string" then
		return p.parentPath
	elseif type(p.paths) == "table" and #p.paths > 0 then
		local extra = #p.paths > 1 and (" +" .. tostring(#p.paths - 1)) or ""
		return tostring(p.paths[1]) .. extra
	elseif type(p.tag) == "string" then
		return "#" .. p.tag
	elseif type(p.query) == "string" then
		return "?" .. p.query
	elseif type(p.assetId) == "number" then
		return "asset " .. tostring(p.assetId)
	elseif type(p.code) == "string" then
		return (string.gsub(string.sub(p.code, 1, 40), "%s+", " "))
	end
	return ""
end

-- display state ("Connected"/"Connecting"/"Disconnected") for a port
local function stateDisplayOf(port: number?): string
	local c = port and connections[port]
	return (c and DISPLAY[c.state]) or "Disconnected"
end

-- Playtest agent row reflects the SELECTED port's heartbeat `server` flag.
local function refreshAgentRow()
	local sel = selectedPort and connections[selectedPort]
	if not armed then
		status:setAgentState("off") -- gray
	elseif not lastEnsureOk then
		status:setAgentState("error") -- red: armed but inject failed
	elseif sel and sel.serverAlive then
		status:setAgentState("active") -- green: playtest live on the selected port
	else
		status:setAgentState("armed") -- amber: armed, waiting for F5
	end
end

-- Push the whole UI from current state. Each chip shows its OWN connection
-- state; the address + four rows reflect the SELECTED port's connection.
local function render()
	local sel = selectedPort and connections[selectedPort]
	status:setConnectionState(stateDisplayOf(selectedPort))
	status:refreshPorts(candidatePorts)
	status:setSelectedPort(selectedPort)
	local states: { [number]: string } = {}
	for _, p in ipairs(candidatePorts) do
		states[p] = stateDisplayOf(p)
	end
	status:setPortStates(states)
	if sel and sel.state == "connected" then
		status:setHttp(true)
		status:setMcp(true)
		status:setCommands(sel.commandsProven and true or nil)
	else
		status:setHttp(nil) -- idle/gray when the selected port is not connected+live
		status:setMcp(nil)
		status:setCommands(nil)
	end
	refreshAgentRow()
end

local function firstConnectedPort(): number?
	return (next(connections))
end

local function countConnections(): number
	local n = 0
	for _ in pairs(connections) do
		n += 1
	end
	return n
end

local function setArmed(value: boolean)
	armed = value
	plugin:SetSetting(SETTING_ARMED, armed)
	agentButton:SetActive(armed)
	status:setArmed(armed)
	if armed then
		local port = selectedPort or firstConnectedPort() or Config.DEFAULT_PORT
		lastEnsureOk = enablePlaytestAgent(port)
		if not lastEnsureOk then
			warn("[NikMCP] could not arm playtest agent (source write failed)")
		end
	else
		removeAgent()
		lastEnsureOk = true
	end
	refreshAgentRow()
end

status.onArm = function()
	setArmed(not armed)
end

-- A connection answered -> Connected.
local function markConnected(conn: Conn)
	conn.state = "connected"
	conn.backoff = 0
	if armed then
		local agent = ServerScriptService:FindFirstChild(AGENT_NAME)
		if agent then
			agent:SetAttribute("McpPort", conn.port) -- point the agent at a live port
		end
	end
	if conn.warned ~= "connected" then
		conn.warned = "connected"
		print(("[NikMCP] connected on :%d"):format(conn.port))
	end
	pushSettingsTo(conn.port) -- this bridge enforces tool gating; refresh it on (re)connect
	render()
end

-- A connection stopped answering -> keep it, retry with backoff (Connecting).
-- Only THIS connection is affected; the others keep running.
local function markReconnecting(conn: Conn)
	conn.state = "connecting"
	conn.serverAlive = false
	conn.backoff += 1
	if conn.warned ~= "connecting" then
		conn.warned = "connecting"
		warn(("[NikMCP] :%d not answering; retrying with backoff. Start the Node server "
			.. "(npm start) and enable Allow HTTP Requests."):format(conn.port))
	end
	render()
end

-- Start an INDEPENDENT poll loop for `port` (no-op if already up).
local function startConnection(port: number)
	if connections[port] then
		return
	end
	local conn: Conn = {
		port = port,
		state = "connecting",
		running = true,
		backoff = 0,
		warned = nil,
		serverAlive = false,
		commandsProven = false,
	}
	connections[port] = conn
	render()

	-- Apply the merged liveness from a /poll response (server flag drives the
	-- Playtest-agent row); no separate per-tick heartbeat is needed.
	local function applyServerFlag(serverFlag: boolean)
		if serverFlag ~= conn.serverAlive then
			conn.serverAlive = serverFlag
			if port == selectedPort then
				refreshAgentRow()
			end
		end
	end

	task.spawn(function()
		local activeUntil = 0 -- os.clock() deadline for the faster POLL_ACTIVE cadence
		while conn.running and pluginRunning do
			-- Merged short-poll: one immediate GET carrying status + any command.
			local base = urlFor(port)
			local ok, body = pcall(function()
				return HttpService:GetAsync(base .. "/poll?context=" .. CONTEXT, true, authHeaders())
			end)
			if not conn.running then
				break
			end
			if not ok then
				markReconnecting(conn)
				task.wait(backoffIntervalFor(conn))
				continue
			end
			if conn.state ~= "connected" then
				markConnected(conn) -- answered: Connecting -> Connected
			end

			local decoded: any = nil
			if body and body ~= "" then
				local good, d = pcall(function()
					return HttpService:JSONDecode(body)
				end)
				if good then
					decoded = d
				end
			end
			applyServerFlag(decoded ~= nil and decoded.server == true)

			local cmd = decoded and decoded.command or nil
			if cmd and cmd.id then
				activeUntil = os.clock() + Config.ACTIVE_WINDOW -- snappier right after activity
				local result
				local startClock = os.clock()
				if cmd.type == "enable_playtest_agent" then
					setArmed(true) -- arming makes the agent persistent + F5-covered
					result = { ok = lastEnsureOk, output = lastEnsureOk and "playtest agent armed" or "arm failed" }
				else
					result = Executor.execute(cmd)
				end
				if result and result.ok == false then
					warn(("[NikMCP] command %q failed: %s")
						:format(tostring(cmd.type), tostring(result.err)))
				end
				if settings.activityLog then
					local ms = math.floor((os.clock() - startClock) * 1000 + 0.5)
					status:addActivity({
						tool = (":%d %s"):format(port, tostring(cmd.type)),
						target = activityTarget(cmd),
						ok = result.ok ~= false,
						ms = ms,
						time = os.time(),
					})
				end
				result.id = cmd.id
				pcall(function()
					HttpService:PostAsync(
						base .. "/response",
						HttpService:JSONEncode(result),
						Enum.HttpContentType.ApplicationJson,
						false,
						authHeaders()
					)
				end)
				conn.commandsProven = true
				if port == selectedPort then
					status:setCommands(true)
				end
			end

			-- adaptive cadence: fast for ~2s after a command, else idle scaled by
			-- the number of connected ports (keeps total req-rate under the limit)
			local interval
			if os.clock() < activeUntil then
				interval = Config.POLL_ACTIVE
			else
				interval = math.max(Config.POLL_IDLE, 0.15 * countConnections())
			end
			task.wait(interval)
		end
		-- loop ended (Disconnect / removed / unload): clear iff still ours
		if connections[port] == conn then
			connections[port] = nil
		end
		render()
	end)
end

-- Stop a port's loop (Disconnect / remove). Removes it immediately so the UI
-- updates now; the loop sees running=false and exits on its next check.
local function stopConnection(port: number)
	local conn = connections[port]
	if conn then
		conn.running = false
		connections[port] = nil
	end
end

-- == Port chips: select (display-only) / add / remove ======================
-- Selection NEVER touches any connection's running state.
status.onSelectPort = function(port: number)
	if port == selectedPort then
		return
	end
	selectedPort = port
	plugin:SetSetting(SETTING_SELECTED, port)
	render()
end

status.onAddPort = function(port: number)
	local exists = false
	for _, p in ipairs(candidatePorts) do
		if p == port then
			exists = true
			break
		end
	end
	if not exists then
		table.insert(candidatePorts, port)
		savePorts()
	end
	selectedPort = port -- newly added (or existing) port becomes selected (still its own state)
	plugin:SetSetting(SETTING_SELECTED, port)
	render()
end

status.onRemovePort = function(port: number)
	local idx
	for i, p in ipairs(candidatePorts) do
		if p == port then
			idx = i
			break
		end
	end
	if not idx then
		return
	end
	stopConnection(port) -- if it was connected, stop just that loop first
	table.remove(candidatePorts, idx)
	if #candidatePorts == 0 then
		table.insert(candidatePorts, Config.DEFAULT_PORT) -- never leave the list empty
	end
	savePorts()
	if selectedPort == port then
		selectedPort = candidatePorts[math.min(idx, #candidatePorts)] or candidatePorts[1]
		if selectedPort then
			plugin:SetSetting(SETTING_SELECTED, selectedPort)
		end
	end
	render()
end

-- == Settings callbacks from the dock (persist + re-push to ALL bridges) ======
status.onToggleTool = function(name: string, value: boolean)
	settings.tools[name] = value
	saveSettings()
	pushSettingsAll()
end

status.onSetFlag = function(key: string, value: boolean)
	settings[key] = value
	saveSettings()
	pushSettingsAll()
	if key == "soundEnabled" then
		status:setSoundEnabled(value)
	end
end

-- Numeric settings (playtest auto-stop thresholds).
status.onSetNumber = function(key: string, value: number)
	settings[key] = value
	saveSettings()
	pushSettingsAll()
end

status.onSetAuth = function(enabled: boolean, token: string)
	local wasEnabled = settings.auth.enabled
	local oldToken = settings.auth.token
	settings.auth.enabled = enabled
	settings.auth.token = token
	saveSettings()
	if (not enabled) and wasEnabled and oldToken ~= "" then
		pushSettingsAll(oldToken) -- disabling: bridges still require the old token for this push
	else
		pushSettingsAll() -- enabling adopts via TOFU; token edits re-push with the live header
	end
end

-- == Connect / Disconnect primary button (acts on the SELECTED port only) =====
status.onPrimary = function()
	if not selectedPort then
		return
	end
	if connections[selectedPort] then
		stopConnection(selectedPort)
		print(("[NikMCP] disconnected :%d"):format(selectedPort))
		render()
	else
		startConnection(selectedPort)
	end
end

-- == Toolbar: arm/disarm playtest agent ====================================
agentButton.Click:Connect(function()
	setArmed(not armed)
end)

-- == Startup: restore selection, sync armed + settings; stay DISCONNECTED ====
status:setSettings(settings)
status:setSoundEnabled(settings.soundEnabled)
setArmed(armed)
render() -- shows the restored selected port, all Disconnected (no auto-connect)

-- == Global maintenance loop: keep the armed agent present + agent row fresh ==
-- (Runs even with zero connections; each connection runs its own poll loop.)
task.spawn(function()
	while pluginRunning do
		if armed then
			ensureAgent(selectedPort or firstConnectedPort() or Config.DEFAULT_PORT)
		end
		-- A live server context (F5 agent polling) counts as playtest activity,
		-- so a watched run isn't auto-stopped for idleness.
		for _, conn in pairs(connections) do
			if conn.serverAlive then
				Executor.notePlaytestActivity()
				break
			end
		end
		-- Auto-stop safety net: an abandoned Run-mode playtest started via
		-- playtest_control never leaves Studio stuck in Run.
		local stoppedReason = Executor.maybeAutoStopPlaytest({
			enabled = settings.playtestAutoStop,
			maxSeconds = settings.playtestMaxSeconds,
			idleSeconds = settings.playtestIdleSeconds,
		})
		if stoppedReason then
			warn("[NikMCP] auto-stopped idle playtest (" .. stoppedReason .. ")")
		end
		refreshAgentRow()
		task.wait(1)
	end
end)

plugin.Unloading:Connect(function()
	pluginRunning = false
	for _, conn in pairs(connections) do
		conn.running = false
	end
end)
