-- AnalysisTools: read-only project/style analysis helpers for the edit
-- plugin, split out of Executor.luau.
--
-- WHY THIS MODULE EXISTS: Luau's bytecode compiler caps a single lexical
-- scope at 200 local-variable registers. Executor.luau's top-level scope has
-- one `local function` per command handler; Bucket 2 (project understanding:
-- remote_inventory / datastore_inventory / require_graph / monetization_scan /
-- digest_extras) and Bucket 3 (style / art direction: ui_style_fingerprint /
-- world_style_probe / lighting_profile / ui_layout_probe) pushed Executor's
-- top-level local count to 210, past the 200 limit -- a real compile error
-- ("Out of local registers... exceeded limit 200") that luau-lsp's static
-- analysis does NOT catch, since it is a bytecode-compiler limit, not a type
-- error. Moving these two buckets into their own ModuleScript gives them a
-- fresh 200-local budget.
--
-- Executor.luau calls AnalysisTools.init(deps) once at load (after its own
-- resolvePath / readEditorSource / CollectionService locals are defined),
-- then dispatches the same 9 command types straight through to the functions
-- exported at the bottom of this file. Command names and payload/result
-- contracts are unchanged; the moved function bodies below are verbatim.

local AnalysisTools = {}

-- Populated by init() below; module-scope upvalues so the moved function
-- bodies can reference them completely unchanged (identical names to their
-- Executor.luau originals).
local resolvePath: ((path: string) -> Instance?)
local readEditorSource: ((inst: Instance) -> (boolean, string))
local CollectionService: any

function AnalysisTools.init(deps: any)
	resolvePath = deps.resolvePath
	readEditorSource = deps.readEditorSource
	CollectionService = deps.CollectionService
end

-- == Bucket 2: project understanding =========================================
-- remote_inventory / datastore_inventory / require_graph / monetization_scan /
-- digest_extras. All read-only: one script-source walk per command (single
-- pcall'd readEditorSource per script, reusing grepScripts' walk shape), yield
-- every 200 scripts so a big place never stalls Studio edit mode.

-- Extract the balanced-paren argument text of the FIRST `keyword(...)` call on a
-- line. Returns (argsText, keywordStartIndex) or nil. Unbalanced (multi-line)
-- calls fall back to "rest of line" -- best effort, matches grep_scripts' scope
-- (single-line scanning only).
local function findCallArgs(line: string, keyword: string): (string?, number?)
	local startIdx = string.find(line, keyword .. "(", 1, true)
	if not startIdx then
		return nil, nil
	end
	local openParen = startIdx + #keyword
	local depth = 0
	local i = openParen
	local n = #line
	while i <= n do
		local c = string.sub(line, i, i)
		if c == "(" then
			depth += 1
		elseif c == ")" then
			depth -= 1
			if depth == 0 then
				return string.sub(line, openParen + 1, i - 1), startIdx
			end
		end
		i += 1
	end
	return string.sub(line, openParen + 1), startIdx
end

-- Split a call's argument text on top-level commas (depth-aware so nested
-- (), {}, [] don't split). Best effort -- not a full Luau parser.
local function splitTopLevelArgs(s: string): { string }
	local parts: { string } = {}
	local depth = 0
	local cur = {}
	for i = 1, #s do
		local c = string.sub(s, i, i)
		if c == "(" or c == "{" or c == "[" then
			depth += 1
			table.insert(cur, c)
		elseif c == ")" or c == "}" or c == "]" then
			depth -= 1
			table.insert(cur, c)
		elseif c == "," and depth == 0 then
			table.insert(parts, table.concat(cur))
			cur = {}
		else
			table.insert(cur, c)
		end
	end
	table.insert(parts, table.concat(cur))
	return parts
end

local function trimStr(s: string): string
	return (string.gsub(s, "^%s*(.-)%s*$", "%1"))
end

-- A quoted string literal -> its inner text, else nil (variable/expression arg).
local function asLiteral(argStr: string): string?
	local t = trimStr(argStr)
	return string.match(t, "^[\"'](.*)[\"']$")
end

-- Best-effort "local X = " / "X = " assignment target ending right before a
-- call's start position on the same line (e.g. `local ds = Service:GetDataStore(`).
local function captureAssignTarget(line: string, pos: number): string?
	if not pos or pos <= 1 then
		return nil
	end
	local before = string.sub(line, 1, pos - 1)
	return string.match(before, "([%w_%.]+)%s*=%s*[%w_%.:]*$")
end

-- ---- remote_inventory -------------------------------------------------------
local REMOTE_CLASSES = {
	RemoteEvent = true,
	RemoteFunction = true,
	UnreliableRemoteEvent = true,
	BindableEvent = true,
	BindableFunction = true,
}

local function remoteInventory(p: any): any
	local root = resolvePath((p and p.root) or "game") or game
	local descendants = root:GetDescendants()

	local remotes: { any } = {}
	local nameIndex: { [string]: { number } } = {}
	local REMOTE_CAP = 400
	local remotesTruncated = false
	for _, inst in ipairs(descendants) do
		if REMOTE_CLASSES[inst.ClassName] then
			if #remotes >= REMOTE_CAP then
				remotesTruncated = true
			else
				table.insert(remotes, {
					path = inst:GetFullName(),
					className = inst.ClassName,
					name = inst.Name,
					usages = {},
					usageCount = 0,
					usagesTruncated = false,
				})
				nameIndex[inst.Name] = nameIndex[inst.Name] or {}
				table.insert(nameIndex[inst.Name], #remotes)
			end
		end
	end

	local USAGE_CAP = 40
	local function recordUsage(name: string, scriptPath: string, lineNo: number, kind: string)
		local idxs = nameIndex[name]
		if not idxs then
			return
		end
		local ambiguous = #idxs > 1
		for _, idx in ipairs(idxs) do
			local entry = remotes[idx]
			if entry.usageCount < USAGE_CAP then
				table.insert(entry.usages, { script = scriptPath, line = lineNo, kind = kind, ambiguous = ambiguous })
				entry.usageCount += 1
			else
				entry.usagesTruncated = true
			end
		end
	end

	local scriptCount = 0
	for _, inst in ipairs(descendants) do
		if inst:IsA("LuaSourceContainer") then
			scriptCount += 1
			pcall(function()
				local rok, src = readEditorSource(inst)
				if not rok then
					return
				end
				local scriptPath = inst:GetFullName()
				local lineNo = 0
				for line in (src .. "\n"):gmatch("(.-)\n") do
					lineNo += 1
					local kind: string? = nil
					if string.find(line, "FireServer", 1, true) then
						kind = "FireServer"
					elseif string.find(line, "InvokeServer", 1, true) then
						kind = "InvokeServer"
					elseif string.find(line, "OnServerEvent", 1, true) then
						kind = "OnServerEvent"
					elseif string.find(line, "OnServerInvoke", 1, true) then
						kind = "OnServerInvoke"
					elseif string.find(line, "FireAllClients", 1, true) then
						kind = "FireAllClients"
					elseif string.find(line, "FireClient", 1, true) then
						kind = "FireClient"
					elseif string.find(line, "OnClientEvent", 1, true) then
						kind = "OnClientEvent"
					elseif string.find(line, "OnClientInvoke", 1, true) then
						kind = "OnClientInvoke"
					elseif string.find(line, "Event:Connect", 1, true) then
						kind = "Event:Connect"
					elseif string.find(line, ":Invoke(", 1, true) then
						kind = "Invoke"
					elseif string.find(line, ":Fire(", 1, true) then
						kind = "Fire"
					end
					if kind then
						local k: string = kind
						for name in pairs(nameIndex) do
							if string.find(line, name, 1, true) then
								recordUsage(name, scriptPath, lineNo, k)
							end
						end
					end
					if string.find(line, "WaitForChild", 1, true) then
						local wname = string.match(line, "WaitForChild%(%s*[\"']([^\"']+)[\"']")
						if wname and nameIndex[wname] then
							recordUsage(wname, scriptPath, lineNo, "WaitForChild")
						end
					end
					if string.find(line, "FindFirstChild", 1, true) then
						local fname = string.match(line, "FindFirstChild%(%s*[\"']([^\"']+)[\"']")
						if fname and nameIndex[fname] then
							recordUsage(fname, scriptPath, lineNo, "FindFirstChild")
						end
					end
				end
			end)
			if scriptCount % 200 == 0 then
				task.wait()
			end
		end
	end

	local remoteEvents, remoteFunctions, bindables, unused = 0, 0, 0, 0
	for _, entry in ipairs(remotes) do
		if entry.className == "RemoteEvent" or entry.className == "UnreliableRemoteEvent" then
			remoteEvents += 1
		elseif entry.className == "RemoteFunction" then
			remoteFunctions += 1
		else
			bindables += 1
		end
		if entry.usageCount == 0 then
			unused += 1
		end
	end

	return {
		ok = true,
		result = {
			remotes = remotes,
			truncated = remotesTruncated,
			summary = {
				remoteEvents = remoteEvents,
				remoteFunctions = remoteFunctions,
				bindables = bindables,
				unusedRemotes = unused,
			},
		},
	}
end

-- ---- datastore_inventory -----------------------------------------------------
local DS_DECL_PATTERNS = {
	{ keyword = "GetOrderedDataStore", className = "OrderedDataStore" },
	{ keyword = "GetDataStore", className = "DataStore" },
	{ keyword = "GetGlobalDataStore", className = "DataStore" },
	{ keyword = "GetSortedMap", className = "MemoryStoreSortedMap" },
	{ keyword = "GetQueue", className = "MemoryStoreQueue" },
}
local DS_OP_NAMES = { "GetAsync", "SetAsync", "UpdateAsync", "IncrementAsync", "RemoveAsync", "GetSortedAsync" }

local function datastoreInventory(p: any): any
	local root = resolvePath((p and p.root) or "game") or game
	local descendants = root:GetDescendants()

	local DS_CAP = 500
	local DECL_CAP = 50
	local OP_CAP = 200
	local UNATTR_CAP = 200

	local stores: { any } = {}
	local storeKeyToIndex: { [string]: number } = {}
	local scriptsTouching: { [string]: boolean } = {}
	local unattributedOps: { any } = {}
	local unattributedTruncated = false
	local dsTruncated = false

	local function getOrCreateStore(className: string, name: string, scope: string?, dynamic: boolean, dynamicExpr: string?): number?
		if dynamic then
			if #stores >= DS_CAP then
				dsTruncated = true
				return nil
			end
			table.insert(stores, {
				name = "<dynamic>",
				scope = scope,
				className = className,
				dynamic = true,
				dynamicExpr = dynamicExpr,
				declaredIn = {},
				declaredInTruncated = false,
				operations = {},
				operationsTruncated = false,
			})
			return #stores
		end
		local key = className .. "|" .. (scope or "") .. "|" .. name
		local idx = storeKeyToIndex[key]
		if idx then
			return idx
		end
		if #stores >= DS_CAP then
			dsTruncated = true
			return nil
		end
		table.insert(stores, {
			name = name,
			scope = scope,
			className = className,
			dynamic = false,
			declaredIn = {},
			declaredInTruncated = false,
			operations = {},
			operationsTruncated = false,
		})
		idx = #stores
		storeKeyToIndex[key] = idx
		return idx
	end

	local scriptCount = 0
	for _, inst in ipairs(descendants) do
		if inst:IsA("LuaSourceContainer") then
			scriptCount += 1
			pcall(function()
				local rok, src = readEditorSource(inst)
				if not rok then
					return
				end
				local scriptPath = inst:GetFullName()
				local varToStore: { [string]: number } = {}
				local lastStoreIdx: number? = nil
				local lineNo = 0
				for line in (src .. "\n"):gmatch("(.-)\n") do
					lineNo += 1
					for _, decl in ipairs(DS_DECL_PATTERNS) do
						local argsStr, pos = findCallArgs(line, decl.keyword)
						if argsStr and pos then
							scriptsTouching[scriptPath] = true
							local args = splitTopLevelArgs(argsStr)
							local nameArg = args[1] and trimStr(args[1]) or ""
							local nameLit = nameArg ~= "" and asLiteral(nameArg) or nil
							local scopeLit = nil
							if args[2] then
								scopeLit = asLiteral(trimStr(args[2]))
							end
							local dynamic = nameArg ~= "" and nameLit == nil
							local resolvedName = nameLit
							if decl.keyword == "GetGlobalDataStore" then
								resolvedName = "<global>"
								dynamic = false
							elseif not resolvedName and not dynamic then
								resolvedName = "<unknown>"
							end
							local idx = getOrCreateStore(decl.className, resolvedName or "<dynamic>", scopeLit, dynamic, dynamic and nameArg or nil)
							if idx then
								local store = stores[idx]
								if #store.declaredIn < DECL_CAP then
									table.insert(store.declaredIn, { script = scriptPath, line = lineNo })
								else
									store.declaredInTruncated = true
								end
								local varName = captureAssignTarget(line, pos)
								if varName then
									varToStore[varName] = idx
								end
								lastStoreIdx = idx
							end
							break
						end
					end

					for _, op in ipairs(DS_OP_NAMES) do
						local opPos = string.find(line, op, 1, true)
						if opPos and opPos > 1 and string.sub(line, opPos - 1, opPos - 1) == ":" then
							local before = string.sub(line, 1, opPos - 2)
							local varName = string.match(before, "([%w_%.]+)$")
							local argsStr = findCallArgs(line, op)
							local keyArg = nil
							if argsStr then
								local firstArg = splitTopLevelArgs(argsStr)[1]
								if firstArg then
									keyArg = asLiteral(trimStr(firstArg))
								end
							end
							local targetIdx = varName and varToStore[varName] or nil
							local inferred = false
							if not targetIdx then
								targetIdx = lastStoreIdx
								inferred = targetIdx ~= nil
							end
							scriptsTouching[scriptPath] = true
							if targetIdx then
								local store = stores[targetIdx]
								if #store.operations < OP_CAP then
									table.insert(store.operations, {
										script = scriptPath,
										line = lineNo,
										op = op,
										keyLiteral = keyArg,
										inferred = inferred,
									})
								else
									store.operationsTruncated = true
								end
							elseif #unattributedOps < UNATTR_CAP then
								table.insert(unattributedOps, { script = scriptPath, line = lineNo, op = op, keyLiteral = keyArg })
							else
								unattributedTruncated = true
							end
							break
						end
					end
				end
			end)
			if scriptCount % 200 == 0 then
				task.wait()
			end
		end
	end

	local dynamicNames = 0
	for _, s in ipairs(stores) do
		if s.dynamic then
			dynamicNames += 1
		end
	end
	local touching = 0
	for _ in pairs(scriptsTouching) do
		touching += 1
	end

	return {
		ok = true,
		result = {
			stores = stores,
			truncated = dsTruncated,
			unattributedOperations = unattributedOps,
			unattributedOperationsTruncated = unattributedTruncated,
			summary = {
				storeCount = #stores,
				scriptsTouchingData = touching,
				dynamicNames = dynamicNames,
			},
		},
	}
end

-- ---- require_graph -----------------------------------------------------------
-- Best-effort static resolution of a require() argument expression against the
-- live DataModel. Handles game.X.Y, game:GetService("X").Y, script.Parent.X,
-- script.X, and :WaitForChild("X") / :FindFirstChild("X") chains. Anything else
-- (computed paths, ternaries, function calls other than the ones above) is left
-- unresolved and reported as raw expression text.
local function resolveRequireChain(expr: string, currentScript: Instance): string?
	local s = trimStr(expr)
	local base: Instance? = nil
	local rest: string
	if string.sub(s, 1, 4) == "game" and (string.sub(s, 5, 5) == "" or string.sub(s, 5, 5) == "." or string.sub(s, 5, 5) == ":") then
		local afterGame = string.sub(s, 5)
		local svc, tail = string.match(afterGame, "^:GetService%(%s*[\"']([^\"']+)[\"']%s*%)(.*)$")
		if svc then
			local ok, inst = pcall(function()
				return game:GetService(svc)
			end)
			if not ok or not inst then
				return nil
			end
			base = inst
			rest = tail
		else
			base = game
			rest = afterGame
		end
	elseif string.sub(s, 1, 6) == "script" and (string.sub(s, 7, 7) == "" or string.sub(s, 7, 7) == "." or string.sub(s, 7, 7) == ":") then
		base = currentScript
		rest = string.sub(s, 7)
	else
		return nil
	end
	if not base then
		return nil
	end
	local node: Instance? = base
	while #rest > 0 do
		local name, tail = string.match(rest, "^%.([%w_]+)(.*)$")
		if name then
			if not node then
				return nil
			end
			node = if name == "Parent" then node.Parent else node:FindFirstChild(name)
			rest = tail
		else
			local wname, wtail = string.match(rest, "^:WaitForChild%(%s*[\"']([^\"']+)[\"']%s*%)(.*)$")
			if wname then
				if not node then
					return nil
				end
				node = node:FindFirstChild(wname)
				rest = wtail
			else
				local fname, ftail = string.match(rest, "^:FindFirstChild%(%s*[\"']([^\"']+)[\"']%s*%)(.*)$")
				if fname then
					if not node then
						return nil
					end
					node = node:FindFirstChild(fname)
					rest = ftail
				else
					return nil
				end
			end
		end
	end
	if node then
		local ok, full = pcall(function()
			return (node :: Instance):GetFullName()
		end)
		if ok then
			return full
		end
	end
	return nil
end

local function requireGraph(p: any): any
	local root = resolvePath((p and p.root) or "game") or game
	local includeUnresolved = true
	if p and p.includeUnresolved == false then
		includeUnresolved = false
	end
	local descendants = root:GetDescendants()

	local edges: { any } = {}
	local EDGE_CAP = 3000
	local edgesTruncated = false
	local moduleCount = 0
	local inDegree: { [string]: number } = {}

	for _, inst in ipairs(descendants) do
		if inst:IsA("ModuleScript") then
			moduleCount += 1
		end
	end

	local scriptCount = 0
	for _, inst in ipairs(descendants) do
		if edgesTruncated then
			break
		end
		if inst:IsA("LuaSourceContainer") then
			scriptCount += 1
			pcall(function()
				local rok, src = readEditorSource(inst)
				if not rok then
					return
				end
				local scriptPath = inst:GetFullName()
				local lineNo = 0
				for line in (src .. "\n"):gmatch("(.-)\n") do
					lineNo += 1
					if #edges >= EDGE_CAP then
						edgesTruncated = true
						return
					end
					local argsStr = findCallArgs(line, "require")
					if argsStr then
						local expr = trimStr(argsStr)
						if expr ~= "" then
							local numLit = string.match(expr, "^(%d+)$")
							if numLit then
								table.insert(edges, { from = scriptPath, to = { assetId = tonumber(numLit) }, kind = "assetId", line = lineNo })
							else
								local resolved = resolveRequireChain(expr, inst)
								if resolved then
									table.insert(edges, { from = scriptPath, to = resolved, kind = "resolved", line = lineNo })
									inDegree[resolved] = (inDegree[resolved] or 0) + 1
								elseif includeUnresolved then
									table.insert(edges, { from = scriptPath, to = expr, kind = "unresolved", line = lineNo })
								end
							end
						end
					end
				end
			end)
			if scriptCount % 200 == 0 then
				task.wait()
			end
		end
	end

	-- Cycle detection: DFS over resolved edges only, cap 10 reported cycles.
	local adjacency: { [string]: { string } } = {}
	for _, e in ipairs(edges) do
		if e.kind == "resolved" then
			adjacency[e.from] = adjacency[e.from] or {}
			table.insert(adjacency[e.from], e.to :: string)
		end
	end
	local cycles: { any } = {}
	local GRAY, BLACK = 1, 2
	local color: { [string]: number } = {}
	local stack: { string } = {}
	local function dfs(node: string)
		if #cycles >= 10 then
			return
		end
		color[node] = GRAY
		table.insert(stack, node)
		for _, nxt in ipairs(adjacency[node] or {}) do
			if #cycles >= 10 then
				break
			end
			if color[nxt] == GRAY then
				local startAt = nil
				for i, v in ipairs(stack) do
					if v == nxt then
						startAt = i
						break
					end
				end
				if startAt then
					local cyc = {}
					for i = startAt, #stack do
						table.insert(cyc, stack[i])
					end
					table.insert(cyc, nxt)
					table.insert(cycles, cyc)
				end
			elseif color[nxt] ~= BLACK then
				dfs(nxt)
			end
		end
		table.remove(stack)
		color[node] = BLACK
	end
	for node in pairs(adjacency) do
		if #cycles >= 10 then
			break
		end
		if color[node] ~= BLACK then
			dfs(node)
		end
	end

	local topList: { any } = {}
	for path, count in pairs(inDegree) do
		table.insert(topList, { path = path, count = count })
	end
	table.sort(topList, function(a, b)
		return a.count > b.count
	end)
	local top10: { any } = {}
	for i = 1, math.min(10, #topList) do
		table.insert(top10, topList[i])
	end

	local unresolvedCount = 0
	for _, e in ipairs(edges) do
		if e.kind == "unresolved" then
			unresolvedCount += 1
		end
	end

	return {
		ok = true,
		result = {
			edges = edges,
			truncated = edgesTruncated,
			summary = {
				moduleCount = moduleCount,
				edgeCount = #edges,
				unresolvedCount = unresolvedCount,
				topRequired = top10,
				cycles = cycles,
			},
		},
	}
end

-- ---- monetization_scan (used by Node's monetization_map + place_digest) -----
local MON_PROMPT_KEYWORDS = {
	"PromptProductPurchase",
	"PromptGamePassPurchase",
	"PromptPurchase",
	"UserOwnsGamePassAsync",
	"GetProductInfo",
}

local function monetizationScan(p: any): any
	local root = resolvePath((p and p.root) or "game") or game
	local descendants = root:GetDescendants()

	local PROMPT_CAP, BIND_CAP, PR_CAP = 500, 500, 200
	local promptSites: { any } = {}
	local idBindings: { any } = {}
	local processReceipt: { any } = {}
	local promptTruncated, bindTruncated, prTruncated = false, false, false

	local scriptCount = 0
	for _, inst in ipairs(descendants) do
		if inst:IsA("LuaSourceContainer") then
			scriptCount += 1
			pcall(function()
				local rok, src = readEditorSource(inst)
				if not rok then
					return
				end
				local scriptPath = inst:GetFullName()
				local lineNo = 0
				for line in (src .. "\n"):gmatch("(.-)\n") do
					lineNo += 1
					for _, kw in ipairs(MON_PROMPT_KEYWORDS) do
						if string.find(line, kw, 1, true) then
							local idLit = string.match(line, "(%d+)")
							if #promptSites < PROMPT_CAP then
								table.insert(promptSites, {
									script = scriptPath,
									line = lineNo,
									kind = kw,
									idLiteral = idLit and tonumber(idLit) or nil,
								})
							else
								promptTruncated = true
							end
							break
						end
					end
					local varName, idLit2 = string.match(line, "([%w_]+)%s*=%s*(%d+)")
					if varName and idLit2 then
						local lowered = string.lower(varName)
						if
							string.find(lowered, "product", 1, true)
							or string.find(lowered, "gamepass", 1, true)
							or string.find(lowered, "game_pass", 1, true)
						then
							if #idBindings < BIND_CAP then
								table.insert(idBindings, { script = scriptPath, line = lineNo, name = varName, id = tonumber(idLit2) })
							else
								bindTruncated = true
							end
						end
					end
					if string.find(string.lower(line), "processreceipt", 1, true) then
						if #processReceipt < PR_CAP then
							table.insert(processReceipt, { script = scriptPath, line = lineNo })
						else
							prTruncated = true
						end
					end
				end
			end)
			if scriptCount % 200 == 0 then
				task.wait()
			end
		end
	end

	return {
		ok = true,
		result = {
			promptSites = promptSites,
			idBindings = idBindings,
			processReceipt = processReceipt,
			truncated = { promptSites = promptTruncated, idBindings = bindTruncated, processReceipt = prTruncated },
		},
	}
end

-- ---- digest_extras (used by Node's place_digest) -----------------------------
local function digestExtras(): any
	local scriptCounts = { Script = 0, LocalScript = 0, ModuleScript = 0, byRunContext = {} :: { [string]: number } }
	local soundCount, animationCount = 0, 0

	local allDesc: { Instance } = {}
	local descOk = pcall(function()
		allDesc = game:GetDescendants()
	end)
	local totalInstances = descOk and #allDesc or 0

	if descOk then
		for i, inst in ipairs(allDesc) do
			pcall(function()
				if inst:IsA("Script") then
					scriptCounts.Script += 1
					local rc = (inst :: any).RunContext
					if rc then
						local key = tostring(rc)
						scriptCounts.byRunContext[key] = (scriptCounts.byRunContext[key] or 0) + 1
					end
				elseif inst:IsA("LocalScript") then
					scriptCounts.LocalScript += 1
				elseif inst:IsA("ModuleScript") then
					scriptCounts.ModuleScript += 1
				elseif inst:IsA("Sound") then
					soundCount += 1
				elseif inst:IsA("Animation") then
					animationCount += 1
				end
			end)
			if i % 5000 == 0 then
				task.wait()
			end
		end
	end

	local tagCounts: { [string]: number } = {}
	local tagsOk, allTags = pcall(function()
		return CollectionService:GetAllTags()
	end)
	if tagsOk and type(allTags) == "table" then
		for i, tag in ipairs(allTags) do
			if i > 100 then
				break
			end
			local cok, tagged = pcall(function()
				return CollectionService:GetTagged(tag)
			end)
			tagCounts[tag] = (cok and tagged) and #tagged or 0
		end
	end

	local partCount, meshPartCount, modelCount = 0, 0, 0
	local wsTruncated = false
	pcall(function()
		local wsDesc = workspace:GetDescendants()
		for i, inst in ipairs(wsDesc) do
			if i > 50000 then
				wsTruncated = true
				break
			end
			if inst:IsA("MeshPart") then
				meshPartCount += 1
			elseif inst:IsA("BasePart") then
				partCount += 1
			end
			if inst:IsA("Model") then
				modelCount += 1
			end
		end
	end)

	local screenGuiCount, guiObjectCount = 0, 0
	pcall(function()
		for _, inst in ipairs(game:GetService("StarterGui"):GetDescendants()) do
			if inst:IsA("ScreenGui") then
				screenGuiCount += 1
			end
			if inst:IsA("GuiObject") then
				guiObjectCount += 1
			end
		end
	end)

	return {
		ok = true,
		result = {
			scriptCounts = scriptCounts,
			totalInstances = totalInstances,
			tags = tagCounts,
			workspaceStats = { partCount = partCount, meshPartCount = meshPartCount, modelCount = modelCount, truncated = wsTruncated },
			starterGui = { screenGuiCount = screenGuiCount, guiObjectCount = guiObjectCount },
			soundCount = soundCount,
			animationCount = animationCount,
		},
	}
end

-- == Bucket 3: style / art direction =========================================
-- ui_style_fingerprint / world_style_probe / lighting_profile / ui_layout_probe.
-- All read-only, pure inspection -- no ChangeHistory recording, no mutation.
-- Color histograms quantize each 0..1 channel to 32 steps (then re-expand back to
-- 0..255) so near-identical shades collapse into one swatch bucket. Big walks
-- (GuiObjects, workspace descendants) yield every ~200 processed nodes so a large
-- place never stalls Studio edit mode, matching Bucket 2's discipline.

local function clamp01(x: number): number
	if x < 0 then
		return 0
	elseif x > 1 then
		return 1
	end
	return x
end

-- 0..1 -> nearest of 32 steps -> back to a 0..255 channel value.
local function quantizeChannel(c: number): number
	local step = math.floor(clamp01(c) * 31 + 0.5)
	return math.floor(step * 255 / 31 + 0.5)
end

local function quantizedHex(color: Color3): string
	return string.format("#%02X%02X%02X", quantizeChannel(color.R), quantizeChannel(color.G), quantizeChannel(color.B))
end

local function exactHex(color: Color3): string
	local r = math.floor(clamp01(color.R) * 255 + 0.5)
	local g = math.floor(clamp01(color.G) * 255 + 0.5)
	local b = math.floor(clamp01(color.B) * 255 + 0.5)
	return string.format("#%02X%02X%02X", r, g, b)
end

-- Top-N by count over a { [key]: number } histogram, ties broken by key so output
-- is deterministic across runs.
local function topNCounts(counts: { [string]: number }, n: number): { { key: string, count: number } }
	local arr = {}
	for k, c in pairs(counts) do
		table.insert(arr, { key = k, count = c })
	end
	table.sort(arr, function(a, b)
		if a.count == b.count then
			return a.key < b.key
		end
		return a.count > b.count
	end)
	local out = {}
	for i = 1, math.min(n, #arr) do
		table.insert(out, arr[i])
	end
	return out
end

-- ---- ui_style_fingerprint ---------------------------------------------------
local function uiStyleFingerprint(p: any): any
	local StarterGui = game:GetService("StarterGui")
	local root: Instance = StarterGui
	if p and p.root and p.root ~= "" then
		local resolved = resolvePath(p.root)
		if not resolved then
			return { ok = false, err = "ui_style_fingerprint: root not found: " .. tostring(p.root) }
		end
		root = resolved
	end

	local CAP = 5000
	local truncated = false
	local objCount = 0

	local fontCounts: { [string]: number } = {}
	local textScaledCount, textFixedCount = 0, 0
	local textSizeCounts: { [string]: number } = {}

	local cornerCount = 0
	local cornerBuckets = { sharp = 0, rounded = 0, pill = 0 }

	local strokeCount = 0
	local strokeThicknessCounts: { [string]: number } = {}
	local strokeColorCounts: { [string]: number } = {}
	local strokeApplyModeCounts: { [string]: number } = {}

	local gradientCount = 0
	local gradientPairCounts: { [string]: number } = {}

	local colorCounts: { [string]: number } = {}
	local colorSources: { [string]: { background: number, text: number, image: number } } = {}

	local shadowCount = 0

	local sizeScaleOnly, sizeOffsetOnly, sizeMixed = 0, 0, 0
	local posScaleOnly, posOffsetOnly, posMixed = 0, 0, 0
	local paddingCount = 0
	local listLayoutCount, gridLayoutCount = 0, 0
	local aspectRatioCount = 0
	local anchorCenterCount, anchorTotalCount = 0, 0

	local imageObjCount = 0
	local imageIdSeen: { [string]: boolean } = {}
	local imageIdList: { string } = {}

	local function recordColor(hex: string, source: string)
		colorCounts[hex] = (colorCounts[hex] or 0) + 1
		local s = colorSources[hex]
		if not s then
			s = { background = 0, text = 0, image = 0 }
			colorSources[hex] = s
		end
		s[source] = s[source] + 1
	end

	-- "scale" / "offset" / "mixed" usage of a Size or Position UDim2.
	local function classifyUDim2(u: UDim2): string
		local hasScale = u.X.Scale ~= 0 or u.Y.Scale ~= 0
		local hasOffset = u.X.Offset ~= 0 or u.Y.Offset ~= 0
		if hasScale and hasOffset then
			return "mixed"
		elseif hasOffset then
			return "offset"
		end
		return "scale"
	end

	local descendants = root:GetDescendants()
	for i, inst in ipairs(descendants) do
		if objCount >= CAP then
			truncated = true
			break
		end

		if inst:IsA("GuiObject") then
			objCount += 1
			pcall(function()
				local go = inst :: any

				local sizeClass = classifyUDim2(go.Size)
				if sizeClass == "scale" then
					sizeScaleOnly += 1
				elseif sizeClass == "offset" then
					sizeOffsetOnly += 1
				else
					sizeMixed += 1
				end
				local posClass = classifyUDim2(go.Position)
				if posClass == "scale" then
					posScaleOnly += 1
				elseif posClass == "offset" then
					posOffsetOnly += 1
				else
					posMixed += 1
				end

				anchorTotalCount += 1
				local ap = go.AnchorPoint
				if math.abs(ap.X - 0.5) < 0.001 and math.abs(ap.Y - 0.5) < 0.001 then
					anchorCenterCount += 1
				end

				if go.BackgroundTransparency < 0.9 then
					recordColor(quantizedHex(go.BackgroundColor3), "background")
				end

				local nm = string.lower(inst.Name)
				if string.find(nm, "shadow", 1, true) or string.find(nm, "drop", 1, true) then
					shadowCount += 1
				end
			end)

			if inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox") then
				pcall(function()
					local tl = inst :: any
					local family = "Unknown"
					local okFam, fam = pcall(function()
						return tl.FontFace.Family
					end)
					if okFam and type(fam) == "string" and fam ~= "" then
						local nameOnly = string.match(fam, "([^/]+)%.json$")
						family = nameOnly or fam
					else
						local okLegacy, legacyFont = pcall(function()
							return tl.Font
						end)
						if okLegacy and legacyFont then
							family = legacyFont.Name
						end
					end
					fontCounts[family] = (fontCounts[family] or 0) + 1

					if tl.TextScaled then
						textScaledCount += 1
					else
						textFixedCount += 1
						local sizeKey = tostring(math.floor(tl.TextSize + 0.5))
						textSizeCounts[sizeKey] = (textSizeCounts[sizeKey] or 0) + 1
					end

					if tl.TextTransparency < 0.9 then
						recordColor(quantizedHex(tl.TextColor3), "text")
					end
				end)
			end

			if inst:IsA("ImageLabel") or inst:IsA("ImageButton") then
				pcall(function()
					local im = inst :: any
					imageObjCount += 1
					local id = im.Image
					if type(id) == "string" and id ~= "" and not imageIdSeen[id] then
						imageIdSeen[id] = true
						if #imageIdList < 40 then
							table.insert(imageIdList, id)
						end
					end
					local ic = im.ImageColor3
					local isWhite = math.abs(ic.R - 1) < 0.01 and math.abs(ic.G - 1) < 0.01 and math.abs(ic.B - 1) < 0.01
					if not isWhite then
						recordColor(quantizedHex(ic), "image")
					end
				end)
			end
		elseif inst:IsA("UICorner") then
			pcall(function()
				cornerCount += 1
				local cr = (inst :: any).CornerRadius
				local scale, offset = cr.Scale, cr.Offset
				if scale >= 0.3 or offset > 16 then
					cornerBuckets.pill += 1
				elseif offset <= 2 and scale < 0.05 then
					cornerBuckets.sharp += 1
				else
					cornerBuckets.rounded += 1
				end
			end)
		elseif inst:IsA("UIStroke") then
			pcall(function()
				strokeCount += 1
				local st = inst :: any
				local thickKey = tostring(math.floor(st.Thickness * 2 + 0.5) / 2)
				strokeThicknessCounts[thickKey] = (strokeThicknessCounts[thickKey] or 0) + 1
				local hex = exactHex(st.Color)
				strokeColorCounts[hex] = (strokeColorCounts[hex] or 0) + 1
				local modeName = st.ApplyStrokeMode.Name
				strokeApplyModeCounts[modeName] = (strokeApplyModeCounts[modeName] or 0) + 1
			end)
		elseif inst:IsA("UIGradient") then
			pcall(function()
				gradientCount += 1
				local seq: ColorSequence = (inst :: any).Color
				local keypoints = seq.Keypoints
				if keypoints and #keypoints >= 2 then
					local startHex = exactHex(keypoints[1].Value)
					local endHex = exactHex(keypoints[#keypoints].Value)
					local pairKey = startHex .. "->" .. endHex
					gradientPairCounts[pairKey] = (gradientPairCounts[pairKey] or 0) + 1
				end
			end)
		elseif inst:IsA("UIPadding") then
			paddingCount += 1
		elseif inst:IsA("UIListLayout") then
			listLayoutCount += 1
		elseif inst:IsA("UIGridLayout") then
			gridLayoutCount += 1
		elseif inst:IsA("UIAspectRatioConstraint") then
			aspectRatioCount += 1
		end

		if i % 200 == 0 then
			task.wait()
		end
	end

	local topColors = {}
	for _, entry in ipairs(topNCounts(colorCounts, 12)) do
		local s = colorSources[entry.key] or { background = 0, text = 0, image = 0 }
		table.insert(topColors, { hex = entry.key, count = entry.count, sources = s })
	end

	local fontList = {}
	for _, entry in ipairs(topNCounts(fontCounts, 20)) do
		table.insert(fontList, { family = entry.key, count = entry.count })
	end

	local strokeColorList = {}
	for _, entry in ipairs(topNCounts(strokeColorCounts, 10)) do
		table.insert(strokeColorList, { hex = entry.key, count = entry.count })
	end

	local gradientPairList = {}
	for _, entry in ipairs(topNCounts(gradientPairCounts, 10)) do
		table.insert(gradientPairList, { pair = entry.key, count = entry.count })
	end

	return {
		ok = true,
		result = {
			root = root:GetFullName(),
			objectCount = objCount,
			truncated = truncated,
			fonts = {
				families = fontList,
				textScaledCount = textScaledCount,
				textFixedCount = textFixedCount,
				textSizeDistribution = textSizeCounts,
			},
			corners = { count = cornerCount, buckets = cornerBuckets },
			strokes = {
				count = strokeCount,
				thicknessDistribution = strokeThicknessCounts,
				colors = strokeColorList,
				applyStrokeModeCounts = strokeApplyModeCounts,
			},
			gradients = { count = gradientCount, topColorPairs = gradientPairList },
			colors = topColors,
			shadows = { heuristicCount = shadowCount },
			layoutHygiene = {
				size = { scaleOnly = sizeScaleOnly, offsetOnly = sizeOffsetOnly, mixed = sizeMixed },
				position = { scaleOnly = posScaleOnly, offsetOnly = posOffsetOnly, mixed = posMixed },
				paddingCount = paddingCount,
				listLayoutCount = listLayoutCount,
				gridLayoutCount = gridLayoutCount,
				aspectRatioConstraintCount = aspectRatioCount,
				centeredAnchorFraction = anchorTotalCount > 0 and (anchorCenterCount / anchorTotalCount) or 0,
			},
			images = {
				count = imageObjCount,
				distinctImageIds = imageIdList,
				distinctImageIdCount = #imageIdList,
			},
		},
	}
end

-- ---- world_style_probe ------------------------------------------------------
local function worldStyleProbe(p: any): any
	local root: Instance = workspace
	if p and p.root and p.root ~= "" then
		local resolved = resolvePath(p.root)
		if not resolved then
			return { ok = false, err = "world_style_probe: root not found: " .. tostring(p.root) }
		end
		root = resolved
	end
	local sampleCap = 50000
	if p and type(p.sampleCap) == "number" and p.sampleCap >= 1 then
		-- clamp: an oversized caller value would force stride=1 and unbounded sort work
		sampleCap = math.min(math.floor(p.sampleCap), 50000)
	end

	local descendants = root:GetDescendants()
	local total = #descendants
	local stride = 1
	local sampled = false
	if total > sampleCap then
		stride = math.ceil(total / sampleCap)
		sampled = true
	end

	local colorCounts: { [string]: number } = {}
	local materialCounts: { [string]: number } = {}
	local variantCounts: { [string]: number } = {}
	local partsWithVariant = 0
	local neonCount, plasticCount, studLikeCount = 0, 0, 0
	local partCount = 0
	local sizeMagSum = 0
	local sizeMagList: { number } = {}
	local transparentCount = 0
	local meshPartCount, unionCount, regularPartCount = 0, 0, 0
	local textureCount, decalCount = 0, 0
	local surfaceAppearanceCount = 0
	local particleEmitterCount, beamCount, trailCount = 0, 0, 0
	local pointLightCount, spotLightCount, surfaceLightCount = 0, 0, 0

	local sampledCount = 0
	local processed = 0
	local i = 1
	while i <= total do
		local inst = descendants[i]
		pcall(function()
			if inst:IsA("BasePart") then
				partCount += 1
				sampledCount += 1
				local bp = inst :: any
				local hex = quantizedHex(bp.Color)
				colorCounts[hex] = (colorCounts[hex] or 0) + 1
				local matName = bp.Material.Name
				materialCounts[matName] = (materialCounts[matName] or 0) + 1
				if matName == "Neon" then
					neonCount += 1
				elseif matName == "Plastic" or matName == "SmoothPlastic" then
					plasticCount += 1
				end
				local variant = bp.MaterialVariant
				if type(variant) == "string" and variant ~= "" then
					partsWithVariant += 1
					variantCounts[variant] = (variantCounts[variant] or 0) + 1
					if string.find(string.lower(variant), "stud", 1, true) then
						studLikeCount += 1
					end
				end
				local mag = bp.Size.Magnitude
				table.insert(sizeMagList, mag)
				sizeMagSum += mag
				if bp.Transparency > 0 then
					transparentCount += 1
				end
				if inst:IsA("MeshPart") then
					meshPartCount += 1
				elseif inst:IsA("UnionOperation") then
					unionCount += 1
				else
					regularPartCount += 1
				end
			elseif inst:IsA("Decal") then
				decalCount += 1
			elseif inst:IsA("Texture") then
				textureCount += 1
			elseif inst:IsA("SurfaceAppearance") then
				surfaceAppearanceCount += 1
			elseif inst:IsA("ParticleEmitter") then
				particleEmitterCount += 1
			elseif inst:IsA("Beam") then
				beamCount += 1
			elseif inst:IsA("Trail") then
				trailCount += 1
			elseif inst:IsA("PointLight") then
				pointLightCount += 1
			elseif inst:IsA("SpotLight") then
				spotLightCount += 1
			elseif inst:IsA("SurfaceLight") then
				surfaceLightCount += 1
			end
		end)
		processed += 1
		if processed % 200 == 0 then
			task.wait()
		end
		i += stride
	end

	table.sort(sizeMagList, function(a, b)
		return a < b
	end)
	local avgSize = partCount > 0 and (sizeMagSum / partCount) or 0
	local medianSize = 0
	if #sizeMagList > 0 then
		local mid = math.ceil(#sizeMagList / 2)
		medianSize = sizeMagList[mid]
	end

	local topColors = {}
	for _, entry in ipairs(topNCounts(colorCounts, 16)) do
		table.insert(topColors, { hex = entry.key, count = entry.count })
	end
	local topMaterials = {}
	for _, entry in ipairs(topNCounts(materialCounts, 12)) do
		table.insert(topMaterials, { material = entry.key, count = entry.count })
	end
	local topVariants = {}
	for _, entry in ipairs(topNCounts(variantCounts, 8)) do
		table.insert(topVariants, { variant = entry.key, count = entry.count })
	end

	-- Terrain: cheap property reads only, never a voxel scan.
	local terrainInfo
	do
		local ok, info = pcall(function()
			local t = workspace:FindFirstChildOfClass("Terrain")
			if not t then
				return { present = false }
			end
			local decOk, dec = pcall(function()
				return (t :: any).Decoration
			end)
			local extOk, ext = pcall(function()
				return (t :: any).MaxExtents
			end)
			local hasVoxels: boolean? = nil
			if extOk and ext then
				hasVoxels = ext.Min ~= ext.Max
			end
			return {
				present = true,
				decoration = decOk and dec or nil,
				decorationChecked = decOk,
				hasVoxels = hasVoxels,
				extentsChecked = extOk,
			}
		end)
		if ok then
			terrainInfo = info
		else
			terrainInfo = { checked = false, note = "terrain read failed" }
		end
	end

	return {
		ok = true,
		result = {
			root = root:GetFullName(),
			sampled = sampled,
			stride = stride,
			totalDescendants = total,
			sampledCount = sampledCount,
			partCount = partCount,
			colors = topColors,
			materials = {
				top = topMaterials,
				neonFraction = partCount > 0 and (neonCount / partCount) or 0,
				plasticFraction = partCount > 0 and (plasticCount / partCount) or 0,
				studLikeFraction = partCount > 0 and (studLikeCount / partCount) or 0,
				variantTop = topVariants,
				partsWithVariantCount = partsWithVariant,
			},
			size = { avgMagnitude = avgSize, medianMagnitude = medianSize },
			transparentFraction = partCount > 0 and (transparentCount / partCount) or 0,
			meshCharacter = {
				meshPartCount = meshPartCount,
				unionCount = unionCount,
				regularPartCount = regularPartCount,
			},
			textureCount = textureCount,
			decalCount = decalCount,
			surfaceAppearanceCount = surfaceAppearanceCount,
			juiceSignals = {
				particleEmitterCount = particleEmitterCount,
				beamCount = beamCount,
				trailCount = trailCount,
			},
			lights = {
				pointLightCount = pointLightCount,
				spotLightCount = spotLightCount,
				surfaceLightCount = surfaceLightCount,
			},
			terrain = terrainInfo,
		},
	}
end

-- ---- lighting_profile --------------------------------------------------------
local function lightingProfile(): any
	local LightingSvc = game:GetService("Lighting")

	local function safeRead(fn: () -> any): any
		local ok, v = pcall(fn)
		if ok then
			return v
		end
		return nil
	end

	local function luminance(c: Color3?): number?
		if not c then
			return nil
		end
		return 0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B
	end

	-- Technology is RobloxScriptSecurity -- plugin (PluginSecurity) reads can be
	-- rejected; safeRead degrades to nil instead of erroring the whole command.
	local technology = safeRead(function()
		return (LightingSvc :: any).Technology.Name
	end)
	local clockTime = safeRead(function()
		return LightingSvc.ClockTime
	end)
	local timeOfDay = safeRead(function()
		return LightingSvc.TimeOfDay
	end)
	local brightness = safeRead(function()
		return LightingSvc.Brightness
	end)
	local ambient = safeRead(function()
		return LightingSvc.Ambient
	end) :: Color3?
	local outdoorAmbient = safeRead(function()
		return LightingSvc.OutdoorAmbient
	end) :: Color3?
	local colorShiftTop = safeRead(function()
		return LightingSvc.ColorShift_Top
	end) :: Color3?
	local colorShiftBottom = safeRead(function()
		return LightingSvc.ColorShift_Bottom
	end) :: Color3?
	local envDiffuse = safeRead(function()
		return LightingSvc.EnvironmentDiffuseScale
	end)
	local envSpecular = safeRead(function()
		return LightingSvc.EnvironmentSpecularScale
	end)
	local globalShadows = safeRead(function()
		return LightingSvc.GlobalShadows
	end)
	local shadowSoftness = safeRead(function()
		return LightingSvc.ShadowSoftness
	end)
	local exposureComp = safeRead(function()
		return LightingSvc.ExposureCompensation
	end)
	local fogEnd = safeRead(function()
		return LightingSvc.FogEnd
	end)
	local fogStart = safeRead(function()
		return LightingSvc.FogStart
	end)
	local fogColor = safeRead(function()
		return LightingSvc.FogColor
	end) :: Color3?

	local effects: { [string]: any } = {}

	local atmo = LightingSvc:FindFirstChildOfClass("Atmosphere")
	if atmo then
		effects.atmosphere = safeRead(function()
			local a = atmo :: any
			return {
				density = a.Density,
				offset = a.Offset,
				color = exactHex(a.Color),
				decay = exactHex(a.Decay),
				glare = a.Glare,
				haze = a.Haze,
			}
		end)
	end

	local sky = LightingSvc:FindFirstChildOfClass("Sky")
	if sky then
		effects.sky = safeRead(function()
			local s = sky :: any
			return {
				skyboxSet = type(s.SkyboxBk) == "string" and s.SkyboxBk ~= "",
				sunTextureSet = type(s.SunTextureId) == "string" and s.SunTextureId ~= "",
				starCount = s.StarCount,
			}
		end)
	end

	local bloom = LightingSvc:FindFirstChildOfClass("BloomEffect")
	if bloom then
		effects.bloom = safeRead(function()
			local b = bloom :: any
			return { intensity = b.Intensity, size = b.Size, threshold = b.Threshold }
		end)
	end

	local cc = LightingSvc:FindFirstChildOfClass("ColorCorrectionEffect")
	if cc then
		effects.colorCorrection = safeRead(function()
			local c = cc :: any
			return { brightness = c.Brightness, contrast = c.Contrast, saturation = c.Saturation, tintColor = exactHex(c.TintColor) }
		end)
	end

	local dof = LightingSvc:FindFirstChildOfClass("DepthOfFieldEffect")
	if dof then
		effects.depthOfField = safeRead(function()
			local d = dof :: any
			return { focusDistance = d.FocusDistance, inFocusRadius = d.InFocusRadius }
		end)
	end

	local sunRays = LightingSvc:FindFirstChildOfClass("SunRaysEffect")
	if sunRays then
		effects.sunRays = safeRead(function()
			local sr = sunRays :: any
			return { intensity = sr.Intensity, spread = sr.Spread }
		end)
	end

	local blur = LightingSvc:FindFirstChildOfClass("BlurEffect")
	if blur then
		effects.blur = safeRead(function()
			return { size = (blur :: any).Size }
		end)
	end

	return {
		ok = true,
		result = {
			technology = technology,
			clockTime = clockTime,
			timeOfDay = timeOfDay,
			brightness = brightness,
			ambient = ambient and exactHex(ambient) or nil,
			ambientLuminance = luminance(ambient),
			outdoorAmbient = outdoorAmbient and exactHex(outdoorAmbient) or nil,
			outdoorAmbientLuminance = luminance(outdoorAmbient),
			colorShiftTop = colorShiftTop and exactHex(colorShiftTop) or nil,
			colorShiftBottom = colorShiftBottom and exactHex(colorShiftBottom) or nil,
			environmentDiffuseScale = envDiffuse,
			environmentSpecularScale = envSpecular,
			globalShadows = globalShadows,
			shadowSoftness = shadowSoftness,
			exposureCompensation = exposureComp,
			fog = { fogStart = fogStart, fogEnd = fogEnd, fogColor = fogColor and exactHex(fogColor) or nil },
			effects = effects,
		},
	}
end

-- ---- ui_layout_probe (pure-math layout solver, no rendering) ----------------
local LAYOUT_CAP = 3000
local GUI_INSET_TOP = 58 -- approximation: fixed topbar inset when IgnoreGuiInset is false
local DEFAULT_LAYOUT_RESOLUTIONS = {
	{ width = 390, height = 844, name = "phone" },
	{ width = 1024, height = 768, name = "tablet" },
	{ width = 1920, height = 1080, name = "desktop" },
}
local LAYOUT_APPROXIMATIONS = {
	"UIFlexItem/UIFlexAlignment not modeled (flex sizing/growing ignored)",
	"AutomaticSize is not measured (subtrees using it keep their UDim2-computed size and are marked approximate=true)",
	"No text measurement (RichText/glyph metrics); textLikelyClipped and tinyText compare TextSize against the rect only",
	"UIListLayout.Wraps is not modeled (single row/column only)",
	"UIGridLayout.StartCorner assumed TopLeft; CellSize overrides child Size and UISizeConstraint/UIAspectRatioConstraint on grid children are ignored",
	"ScreenGui IgnoreGuiInset=false subtracts a fixed 58px top inset (the real topbar inset varies by device/version)",
	"UIAspectRatioConstraint is approximated via DominantAxis only; AspectType (FitWithinMaxSize vs ScaleWithParentSize) is not distinguished",
	"No rotation (GuiObject.Rotation) is applied -- all solved rects are axis-aligned boxes",
	"SizeConstraint (RelativeXX/RelativeYY) is applied to Size only; Position Scale always resolves against the parent's matching axis",
}

local function resolveUDimAxis(u: UDim, parentDim: number): number
	return u.Scale * parentDim + u.Offset
end

-- Own Size in absolute pixels given the parent's *inner* (post-padding) rect,
-- honoring SizeConstraint, UISizeConstraint clamp, and an approximate
-- UIAspectRatioConstraint (DominantAxis only -- see LAYOUT_APPROXIMATIONS).
local function computeSize(inst: Instance, parentW: number, parentH: number): (number, number, boolean)
	local go = inst :: any
	local sizeUDim2: UDim2 = go.Size
	local constraint = go.SizeConstraint
	local scaleRefW, scaleRefH = parentW, parentH
	if constraint == Enum.SizeConstraint.RelativeXX then
		scaleRefH = parentW
	elseif constraint == Enum.SizeConstraint.RelativeYY then
		scaleRefW = parentH
	end
	local w = sizeUDim2.X.Scale * scaleRefW + sizeUDim2.X.Offset
	local h = sizeUDim2.Y.Scale * scaleRefH + sizeUDim2.Y.Offset
	local approximate = false

	for _, child in ipairs(inst:GetChildren()) do
		if child:IsA("UISizeConstraint") then
			pcall(function()
				local sc = child :: any
				local minS, maxS = sc.MinSize, sc.MaxSize
				if maxS.X >= minS.X then
					w = math.clamp(w, minS.X, maxS.X)
				end
				if maxS.Y >= minS.Y then
					h = math.clamp(h, minS.Y, maxS.Y)
				end
			end)
		elseif child:IsA("UIAspectRatioConstraint") then
			approximate = true
			pcall(function()
				local arc = child :: any
				local ratio = arc.AspectRatio
				if ratio and ratio > 0 then
					if arc.DominantAxis == Enum.DominantAxis.Height then
						w = h * ratio
					else
						h = w / ratio
					end
				end
			end)
		end
	end

	local autoOk, autoSize = pcall(function()
		return go.AutomaticSize
	end)
	if autoOk and autoSize ~= Enum.AutomaticSize.None then
		approximate = true
	end

	return w, h, approximate
end

-- Own Position in absolute pixels given the parent's *inner* rect + own size.
local function computePosition(inst: Instance, parentRect: any, w: number, h: number): (number, number)
	local go = inst :: any
	local pos: UDim2 = go.Position
	local anchor: Vector2 = go.AnchorPoint
	local x = parentRect.x + pos.X.Scale * parentRect.w + pos.X.Offset - anchor.X * w
	local y = parentRect.y + pos.Y.Scale * parentRect.h + pos.Y.Offset - anchor.Y * h
	return x, y
end

-- UIPadding on `inst` insets the coordinate space its children are solved in.
local function innerRect(rect: any, inst: Instance): any
	local padLeft, padRight, padTop, padBottom = 0, 0, 0, 0
	local found = false
	for _, child in ipairs(inst:GetChildren()) do
		if child:IsA("UIPadding") then
			found = true
			pcall(function()
				local up = child :: any
				padLeft = resolveUDimAxis(up.PaddingLeft, rect.w)
				padRight = resolveUDimAxis(up.PaddingRight, rect.w)
				padTop = resolveUDimAxis(up.PaddingTop, rect.h)
				padBottom = resolveUDimAxis(up.PaddingBottom, rect.h)
			end)
		end
	end
	if not found then
		return rect
	end
	return {
		x = rect.x + padLeft,
		y = rect.y + padTop,
		w = math.max(0, rect.w - padLeft - padRight),
		h = math.max(0, rect.h - padTop - padBottom),
	}
end

local function findLayout(inst: Instance): Instance?
	for _, child in ipairs(inst:GetChildren()) do
		if child:IsA("UIListLayout") or child:IsA("UIGridLayout") then
			return child
		end
	end
	return nil
end

local function sortedByLayoutOrder(children: { Instance }, sortOrder: string): { Instance }
	local arr = {}
	for _, c in ipairs(children) do
		table.insert(arr, c)
	end
	table.sort(arr, function(a, b)
		if sortOrder == "Name" then
			return a.Name < b.Name
		end
		local aOrder, bOrder = 0, 0
		pcall(function()
			aOrder = (a :: any).LayoutOrder
		end)
		pcall(function()
			bOrder = (b :: any).LayoutOrder
		end)
		if aOrder == bOrder then
			return a.Name < b.Name
		end
		return aOrder < bOrder
	end)
	return arr
end

-- Stack `sized` children along FillDirection with Padding, honoring
-- HorizontalAlignment/VerticalAlignment for cross-axis + group placement.
local function solveListLayout(layout: Instance, innerR: any, sized: { any }): { [Instance]: any }
	local ll = layout :: any
	local fillDir = ll.FillDirection
	local horizAlign = ll.HorizontalAlignment
	local vertAlign = ll.VerticalAlignment
	local paddingUDim: UDim = ll.Padding

	local positions: { [Instance]: any } = {}
	if fillDir == Enum.FillDirection.Horizontal then
		local paddingPx = resolveUDimAxis(paddingUDim, innerR.w)
		local totalW = 0
		for i, e in ipairs(sized) do
			totalW += e.w
			if i > 1 then
				totalW += paddingPx
			end
		end
		local startX = innerR.x
		if horizAlign == Enum.HorizontalAlignment.Center then
			startX = innerR.x + (innerR.w - totalW) / 2
		elseif horizAlign == Enum.HorizontalAlignment.Right then
			startX = innerR.x + innerR.w - totalW
		end
		local cursor = startX
		for _, e in ipairs(sized) do
			local y = innerR.y
			if vertAlign == Enum.VerticalAlignment.Center then
				y = innerR.y + (innerR.h - e.h) / 2
			elseif vertAlign == Enum.VerticalAlignment.Bottom then
				y = innerR.y + innerR.h - e.h
			end
			positions[e.inst] = { x = cursor, y = y }
			cursor += e.w + paddingPx
		end
	else
		local paddingPx = resolveUDimAxis(paddingUDim, innerR.h)
		local totalH = 0
		for i, e in ipairs(sized) do
			totalH += e.h
			if i > 1 then
				totalH += paddingPx
			end
		end
		local startY = innerR.y
		if vertAlign == Enum.VerticalAlignment.Center then
			startY = innerR.y + (innerR.h - totalH) / 2
		elseif vertAlign == Enum.VerticalAlignment.Bottom then
			startY = innerR.y + innerR.h - totalH
		end
		local cursor = startY
		for _, e in ipairs(sized) do
			local x = innerR.x
			if horizAlign == Enum.HorizontalAlignment.Center then
				x = innerR.x + (innerR.w - e.w) / 2
			elseif horizAlign == Enum.HorizontalAlignment.Right then
				x = innerR.x + innerR.w - e.w
			end
			positions[e.inst] = { x = x, y = cursor }
			cursor += e.h + paddingPx
		end
	end
	return positions
end

-- CellSize/CellPadding/FillDirectionMaxCells approximation (StartCorner assumed
-- TopLeft; see LAYOUT_APPROXIMATIONS).
local function solveGridLayout(layout: Instance, innerR: any): (number, number, number, number, number, any)
	local gl = layout :: any
	local cellSize: UDim2 = gl.CellSize
	local cellPadding: UDim2 = gl.CellPadding
	local fillDir = gl.FillDirection
	local maxCells = gl.FillDirectionMaxCells

	local cellW = cellSize.X.Scale * innerR.w + cellSize.X.Offset
	local cellH = cellSize.Y.Scale * innerR.h + cellSize.Y.Offset
	local padX = cellPadding.X.Scale * innerR.w + cellPadding.X.Offset
	local padY = cellPadding.Y.Scale * innerR.h + cellPadding.Y.Offset

	if maxCells <= 0 then
		if fillDir == Enum.FillDirection.Horizontal then
			maxCells = math.max(1, math.floor((innerR.w + padX) / math.max(cellW + padX, 1)))
		else
			maxCells = math.max(1, math.floor((innerR.h + padY) / math.max(cellH + padY, 1)))
		end
	end
	return cellW, cellH, padX, padY, maxCells, fillDir
end

local function rnd(n: number): number
	return math.floor(n + 0.5)
end

local function roundRect(r: any): any
	return { x = rnd(r.x), y = rnd(r.y), w = rnd(r.w), h = rnd(r.h) }
end

local function checkOffscreen(state: any, path: string, r: any, screenRect: any)
	local overLeft = screenRect.x - r.x
	local overTop = screenRect.y - r.y
	local overRight = (r.x + r.w) - (screenRect.x + screenRect.w)
	local overBottom = (r.y + r.h) - (screenRect.y + screenRect.h)
	local maxOver = math.max(overLeft, overTop, overRight, overBottom)
	local fullyOff = (r.x + r.w <= screenRect.x)
		or (r.x >= screenRect.x + screenRect.w)
		or (r.y + r.h <= screenRect.y)
		or (r.y >= screenRect.y + screenRect.h)
	if fullyOff or maxOver > 8 then
		if #state.offscreen < 200 then
			table.insert(state.offscreen, { path = path, rect = roundRect(r), kind = fullyOff and "fully" or "partial" })
		else
			state.offscreenTruncated = true
		end
	end
end

local function checkTouchTarget(state: any, child: Instance, path: string, r: any, resName: string)
	if resName ~= "phone" then
		return
	end
	if not (child:IsA("ImageButton") or child:IsA("TextButton")) then
		return
	end
	if math.min(r.w, r.h) < 36 then
		if #state.touchTargetTooSmall < 200 then
			table.insert(state.touchTargetTooSmall, { path = path, rect = roundRect(r) })
		else
			state.touchTargetTooSmallTruncated = true
		end
	end
end

local function checkTextIssues(state: any, child: Instance, path: string, r: any, resName: string)
	if not (child:IsA("TextLabel") or child:IsA("TextButton") or child:IsA("TextBox")) then
		return
	end
	local tl = child :: any
	local scaled = true
	pcall(function()
		scaled = tl.TextScaled
	end)
	if scaled then
		return
	end
	local wrapped = true
	pcall(function()
		wrapped = tl.TextWrapped
	end)
	local textSize = 0
	pcall(function()
		textSize = tl.TextSize
	end)

	if not wrapped and textSize > r.h then
		if #state.textLikelyClipped < 200 then
			table.insert(state.textLikelyClipped, { path = path, rect = roundRect(r), textSize = textSize })
		else
			state.textLikelyClippedTruncated = true
		end
	end
	if resName == "phone" and textSize > 0 and textSize < 12 then
		if #state.tinyText < 200 then
			table.insert(state.tinyText, { path = path, rect = roundRect(r), textSize = textSize })
		else
			state.tinyTextTruncated = true
		end
	end
end

local function checkOverlaps(state: any, siblingList: { any }, hasLayout: boolean)
	if hasLayout then
		return
	end
	local n = #siblingList
	for i = 1, n do
		for j = i + 1, n do
			if state.overlapCount >= 30 then
				state.overlapsTruncated = true
				return
			end
			local a, b = siblingList[i].rect, siblingList[j].rect
			local ix = math.max(a.x, b.x)
			local iy = math.max(a.y, b.y)
			local iw = math.min(a.x + a.w, b.x + b.w) - ix
			local ih = math.min(a.y + a.h, b.y + b.h) - iy
			if iw > 0 and ih > 0 then
				state.overlapCount += 1
				table.insert(state.overlaps, {
					a = siblingList[i].path,
					b = siblingList[j].path,
					overlapRect = roundRect({ x = ix, y = iy, w = iw, h = ih }),
				})
			end
		end
	end
end

-- Solve one ScreenGui's whole subtree for one resolution, mutating `state` with
-- issues found and `rootRectsOut` with the ScreenGui's direct-child rects.
local function solveScreen(screen: Instance, res: any, state: any, rootRectsOut: { any })
	local ignoreInset = false
	pcall(function()
		ignoreInset = (screen :: any).IgnoreGuiInset
	end)
	local topInset = ignoreInset and 0 or GUI_INSET_TOP
	local screenRect = { x = 0, y = topInset, w = res.width, h = res.height - topInset }

	local solve
	solve = function(inst: Instance, parentRect: any, isRoot: boolean)
		local rawChildren = {}
		for _, c in ipairs(inst:GetChildren()) do
			if c:IsA("GuiObject") then
				table.insert(rawChildren, c)
			end
		end
		if #rawChildren == 0 then
			return
		end

		local layout = findLayout(inst)
		local innerR = innerRect(parentRect, inst)
		local placedRects: { [Instance]: any } = {}

		if layout and layout:IsA("UIGridLayout") then
			local sortOrder = "LayoutOrder"
			pcall(function()
				sortOrder = (layout :: any).SortOrder.Name
			end)
			local ordered = sortedByLayoutOrder(rawChildren, sortOrder)
			local cellW, cellH, padX, padY, maxCells, fillDir = solveGridLayout(layout, innerR)
			for idx, child in ipairs(ordered) do
				local i0 = idx - 1
				local col, row
				if fillDir == Enum.FillDirection.Horizontal then
					col = i0 % maxCells
					row = math.floor(i0 / maxCells)
				else
					row = i0 % maxCells
					col = math.floor(i0 / maxCells)
				end
				placedRects[child] = {
					x = innerR.x + col * (cellW + padX),
					y = innerR.y + row * (cellH + padY),
					w = cellW,
					h = cellH,
					approximate = true,
				}
			end
		elseif layout and layout:IsA("UIListLayout") then
			local sortOrder = "LayoutOrder"
			pcall(function()
				sortOrder = (layout :: any).SortOrder.Name
			end)
			local ordered = sortedByLayoutOrder(rawChildren, sortOrder)
			local sized = {}
			for _, child in ipairs(ordered) do
				local w, h, approx = computeSize(child, innerR.w, innerR.h)
				table.insert(sized, { inst = child, w = w, h = h, approximate = approx })
			end
			local positions = solveListLayout(layout, innerR, sized)
			for _, e in ipairs(sized) do
				local pos = positions[e.inst]
				placedRects[e.inst] = { x = pos.x, y = pos.y, w = e.w, h = e.h, approximate = e.approximate }
			end
		else
			for _, child in ipairs(rawChildren) do
				local w, h, approx = computeSize(child, innerR.w, innerR.h)
				local x, y = computePosition(child, innerR, w, h)
				placedRects[child] = { x = x, y = y, w = w, h = h, approximate = approx }
			end
		end

		local siblingList = {}
		for _, child in ipairs(rawChildren) do
			if state.elementCount >= LAYOUT_CAP then
				state.truncated = true
				return
			end
			local r = placedRects[child]
			if r then
				state.elementCount += 1
				if state.elementCount % 200 == 0 then
					task.wait()
				end
				local path = child:GetFullName()

				checkOffscreen(state, path, r, screenRect)
				checkTouchTarget(state, child, path, r, res.name)
				checkTextIssues(state, child, path, r, res.name)

				local visible = true
				pcall(function()
					visible = child.Visible
				end)
				if visible then
					table.insert(siblingList, { path = path, rect = r })
				end

				if isRoot then
					table.insert(rootRectsOut, { path = path, rect = roundRect(r) })
				end

				solve(child, r, false)
			end
		end
		checkOverlaps(state, siblingList, layout ~= nil)
	end

	solve(screen, screenRect, true)
end

local function uiLayoutProbe(p: any): any
	local StarterGui = game:GetService("StarterGui")
	local rootInst: Instance = StarterGui
	if p and p.root and p.root ~= "" then
		local resolved = resolvePath(p.root)
		if not resolved then
			return { ok = false, err = "ui_layout_probe: root not found: " .. tostring(p.root) }
		end
		rootInst = resolved
	end

	local screens: { Instance } = {}
	if rootInst:IsA("ScreenGui") then
		table.insert(screens, rootInst)
	else
		for _, d in ipairs(rootInst:GetDescendants()) do
			if d:IsA("ScreenGui") then
				table.insert(screens, d)
			end
		end
	end

	local resolutions = {}
	if p and type(p.resolutions) == "table" and #p.resolutions > 0 then
		for _, r in ipairs(p.resolutions) do
			table.insert(resolutions, {
				width = tonumber(r.width) or 390,
				height = tonumber(r.height) or 844,
				name = tostring(r.name or ("res_" .. tostring(#resolutions + 1))),
			})
		end
	else
		resolutions = DEFAULT_LAYOUT_RESOLUTIONS
	end

	local reports = {}
	for _, res in ipairs(resolutions) do
		local state = {
			elementCount = 0,
			truncated = false,
			offscreen = {},
			offscreenTruncated = false,
			overlaps = {},
			overlapCount = 0,
			overlapsTruncated = false,
			touchTargetTooSmall = {},
			touchTargetTooSmallTruncated = false,
			textLikelyClipped = {},
			textLikelyClippedTruncated = false,
			tinyText = {},
			tinyTextTruncated = false,
		}
		local rootRects = {}

		for _, screen in ipairs(screens) do
			if state.elementCount >= LAYOUT_CAP then
				state.truncated = true
				break
			end
			solveScreen(screen, res, state, rootRects)
		end

		table.insert(reports, {
			resolution = res,
			elementCount = state.elementCount,
			truncated = state.truncated,
			rootRects = rootRects,
			issues = {
				offscreen = state.offscreen,
				offscreenTruncated = state.offscreenTruncated,
				overlaps = state.overlaps,
				overlapsTruncated = state.overlapsTruncated,
				touchTargetTooSmall = state.touchTargetTooSmall,
				touchTargetTooSmallTruncated = state.touchTargetTooSmallTruncated,
				textLikelyClipped = state.textLikelyClipped,
				textLikelyClippedTruncated = state.textLikelyClippedTruncated,
				tinyText = state.tinyText,
				tinyTextTruncated = state.tinyTextTruncated,
			},
		})
	end

	return {
		ok = true,
		result = {
			root = rootInst:GetFullName(),
			screenCount = #screens,
			resolutions = reports,
			approximations = LAYOUT_APPROXIMATIONS,
		},
	}
end

-- == Dispatch entry points (called from Executor.execute) ====================
AnalysisTools.remoteInventory = remoteInventory
AnalysisTools.datastoreInventory = datastoreInventory
AnalysisTools.requireGraph = requireGraph
AnalysisTools.monetizationScan = monetizationScan
AnalysisTools.digestExtras = digestExtras
AnalysisTools.uiStyleFingerprint = uiStyleFingerprint
AnalysisTools.worldStyleProbe = worldStyleProbe
AnalysisTools.lightingProfile = lightingProfile
AnalysisTools.uiLayoutProbe = uiLayoutProbe

return AnalysisTools
