--!nonstrict
-- Creator Store model inspection and guarded insertion. Assets are loaded into
-- an unparented quarantine container first. No inspected asset enters the place.
local AssetGuardTools = {}

local RunService = game:GetService("RunService")
local AssetService = game:GetService("AssetService")
local ServerStorage = game:GetService("ServerStorage")

local resolvePath
local recorded
local readEditorSource

function AssetGuardTools.init(deps)
	resolvePath = deps.resolvePath
	recorded = deps.recorded
	readEditorSource = deps.readEditorSource
end

local BLOCKED_SEGMENTS = {
	serverscriptservice = true,
	starterplayer = true,
	starterplayerscripts = true,
	startercharacterscripts = true,
	startergui = true,
	starterpack = true,
	replicatedfirst = true,
	remotes = true,
	remoteevents = true,
	remotefunctions = true,
	networking = true,
}

local SAFE_DIRECT_ROOTS = {
	["game.Workspace"] = true,
	["game.ServerStorage"] = true,
	["game.Lighting"] = true,
	["game.SoundService"] = true,
}

local SAFE_REPLICATED_FOLDERS = {
	assets = true,
	content = true,
	models = true,
	packages = true,
}

local function validateTarget(path)
	path = tostring(path or "")
	if string.sub(path, 1, 5) ~= "game." then
		return false, "targetPath must be an explicit game.<Service> path"
	end
	local segments = {}
	for segment in string.gmatch(path, "[^%.]+") do
		table.insert(segments, segment)
	end
	for i = 2, #segments do
		if BLOCKED_SEGMENTS[string.lower(segments[i])] then
			return false, "targetPath enters blocked executable/network surface '" .. segments[i] .. "'"
		end
	end
	for root in pairs(SAFE_DIRECT_ROOTS) do
		if path == root or string.sub(path, 1, #root + 1) == root .. "." then
			return true
		end
	end
	if segments[2] == "ReplicatedStorage" and SAFE_REPLICATED_FOLDERS[string.lower(segments[3] or "")] then
		return true
	end
	return false, "targetPath is outside the guarded asset allowlist"
end

local function sourceHash(text)
	local normalized = string.gsub(text, "\r\n", "\n")
	local buf = buffer.fromstring(normalized)
	local hash = 2166136261
	for i = 0, buffer.len(buf) - 1 do
		hash = bit32.bxor(hash, buffer.readu8(buf, i))
		hash = (bit32.lshift(hash, 24) + bit32.lshift(hash, 8) + hash * 0x93) % 4294967296
	end
	return string.format("%08x", hash)
end

local function relativePath(inst, root)
	local names = {}
	local node = inst
	while node and node ~= root do
		table.insert(names, 1, node.Name)
		node = node.Parent
	end
	return table.concat(names, ".")
end

local function isRemote(inst)
	return inst:IsA("RemoteEvent") or inst:IsA("RemoteFunction") or inst:IsA("UnreliableRemoteEvent")
end

local function addFinding(findings, severity, row)
	table.insert(findings[severity], row)
end

local SOURCE_PATTERNS = {
	{ pattern = "require%s*%(%s*%d+", kind = "numeric_external_require", severity = "critical" },
	{ pattern = "loadstring%s*%(", kind = "dynamic_code_execution", severity = "critical" },
	{ pattern = "getfenv%s*%(", kind = "environment_introspection", severity = "critical" },
	{ pattern = "setfenv%s*%(", kind = "environment_mutation", severity = "critical" },
	{ pattern = "httpservice", kind = "http_service_access", severity = "critical" },
	{ pattern = "requestasync%s*%(", kind = "network_request", severity = "critical" },
	{ pattern = "getasync%s*%(", kind = "network_request", severity = "critical" },
	{ pattern = "postasync%s*%(", kind = "network_request", severity = "critical" },
	{ pattern = "insertservice", kind = "nested_asset_loader", severity = "critical" },
	{ pattern = "loadasset%s*%(", kind = "nested_asset_loader", severity = "critical" },
	{ pattern = "fireserver%s*%(", kind = "remote_traffic", severity = "warning" },
	{ pattern = "invokeserver%s*%(", kind = "remote_traffic", severity = "warning" },
	{ pattern = "fireclient%s*%(", kind = "remote_traffic", severity = "warning" },
	{ pattern = "fireallclients%s*%(", kind = "remote_traffic", severity = "warning" },
	{ pattern = "onserverevent", kind = "remote_listener", severity = "warning" },
	{ pattern = "onclientevent", kind = "remote_listener", severity = "warning" },
	{ pattern = "string%.char%s*%(", kind = "possible_obfuscation", severity = "warning" },
	{ pattern = "base64", kind = "possible_encoded_payload", severity = "warning" },
}

local function scanContainer(container)
	local findings = { critical = {}, warning = {}, info = {} }
	local classCounts = {}
	local scripts = {}
	local remotes = {}
	local records = {}
	local roots = {}
	for _, child in ipairs(container:GetChildren()) do
		table.insert(roots, { name = child.Name, className = child.ClassName })
	end
	local instances = container:GetDescendants()
	for _, inst in ipairs(instances) do
		classCounts[inst.ClassName] = (classCounts[inst.ClassName] or 0) + 1
		local path = relativePath(inst, container)
		local record = path .. "|" .. inst.ClassName
		if inst:IsA("LuaSourceContainer") then
			local okRead, source = readEditorSource(inst)
			local scriptRow = {
				path = path,
				className = inst.ClassName,
				readable = okRead,
				disabled = inst:IsA("BaseScript") and inst.Disabled or nil,
			}
			if okRead then
				scriptRow.sourceHash = sourceHash(source)
				record ..= "|" .. scriptRow.sourceHash
				local lower = string.lower(source)
				for _, check in ipairs(SOURCE_PATTERNS) do
					if string.find(lower, check.pattern) then
						addFinding(findings, check.severity, {
							path = path,
							issueType = check.kind,
							detail = "Suspicious source signature matched.",
							recommendation = "Review the full script source before enabling or moving it out of quarantine.",
						})
					end
				end
				for line in string.gmatch(source .. "\n", "(.-)\n") do
					if #line > 500 then
						addFinding(findings, "warning", {
							path = path,
							issueType = "long_minified_line",
							detail = "A source line exceeds 500 characters.",
							recommendation = "Treat dense or generated source as untrusted until manually reviewed.",
						})
						break
					end
				end
			else
				addFinding(findings, "critical", {
					path = path,
					issueType = "unreadable_executable_source",
					detail = tostring(source),
					recommendation = "Do not enable an executable whose source could not be inspected.",
				})
			end
			table.insert(scripts, scriptRow)
			addFinding(findings, "warning", {
				path = path,
				issueType = "executable_descendant",
				detail = inst.ClassName .. " will be quarantined during guarded insertion.",
				recommendation = "Keep it quarantined unless a human source review approves it.",
			})
		elseif isRemote(inst) then
			table.insert(remotes, { path = path, className = inst.ClassName })
			addFinding(findings, "critical", {
				path = path,
				issueType = "remote_descendant",
				detail = "Imported asset contains " .. inst.ClassName .. ".",
				recommendation = "Keep unexpected networking instances quarantined and recreate only reviewed contracts.",
			})
		end
		table.insert(records, record)
	end
	table.sort(records)
	local fingerprint = sourceHash(table.concat(records, "\n"))
	return {
		fingerprint = fingerprint,
		instanceCount = #instances,
		rootCount = #roots,
		roots = roots,
		classCounts = classCounts,
		scripts = scripts,
		remotes = remotes,
		findings = findings,
		summary = {
			critical = #findings.critical,
			warning = #findings.warning,
			info = #findings.info,
			executableCount = #scripts,
			remoteCount = #remotes,
		},
		riskScreen = "Static signatures reduce risk but cannot prove an asset safe. Review quarantined source manually before enabling it.",
	}
end

local function loadAsset(assetId)
	local ok, container = pcall(function()
		return AssetService:LoadAssetAsync(assetId)
	end)
	if not ok or not container then
		return nil, "LoadAssetAsync failed (asset may be private, moderated, or unavailable): " .. tostring(container)
	end
	return container
end

function AssetGuardTools.scan(p)
	if RunService:IsRunning() then
		return { ok = false, err = "guarded asset scan is edit-context only" }
	end
	local assetId = tonumber(p.assetId)
	if not assetId or assetId < 1 then
		return { ok = false, err = "assetId must be a positive integer" }
	end
	local targetOk, targetErr = validateTarget(p.targetPath)
	if not targetOk then
		return { ok = false, err = targetErr }
	end
	local container, loadErr = loadAsset(assetId)
	if not container then
		return { ok = false, err = loadErr }
	end
	local okScan, report = pcall(scanContainer, container)
	container:Destroy()
	if not okScan then
		return { ok = false, err = "asset scan failed: " .. tostring(report) }
	end
	report.assetId = assetId
	report.targetPath = p.targetPath
	report.mutation = "none; asset was loaded into an unparented container and destroyed"
	return { ok = true, result = report }
end

local function quarantineExecutables(container, quarantine)
	local moved = {}
	for _, inst in ipairs(container:GetDescendants()) do
		if inst:IsA("LuaSourceContainer") or isRemote(inst) then
			if inst:IsA("BaseScript") then
				inst.Disabled = true
			end
			table.insert(moved, {
				originalPath = relativePath(inst, container),
				className = inst.ClassName,
				name = inst.Name,
			})
			inst.Parent = quarantine
		end
	end
	return moved
end

function AssetGuardTools.insert(p)
	if RunService:IsRunning() then
		return { ok = false, err = "guarded asset insertion is edit-context only" }
	end
	if p.confirm ~= true then
		return { ok = false, err = "guarded insertion requires confirm=true" }
	end
	local assetId = tonumber(p.assetId)
	if not assetId or assetId < 1 then
		return { ok = false, err = "assetId must be a positive integer" }
	end
	local targetOk, targetErr = validateTarget(p.targetPath)
	if not targetOk then
		return { ok = false, err = targetErr }
	end
	local target = resolvePath(p.targetPath)
	if not target then
		return { ok = false, err = "targetPath not found: " .. tostring(p.targetPath) }
	end
	local container, loadErr = loadAsset(assetId)
	if not container then
		return { ok = false, err = loadErr }
	end
	local okScan, preScan = pcall(scanContainer, container)
	if not okScan then
		container:Destroy()
		return { ok = false, err = "pre-insert scan failed: " .. tostring(preScan) }
	end
	if tostring(preScan.fingerprint) ~= tostring(p.expectedFingerprint) then
		container:Destroy()
		return {
			ok = false,
			err = "asset contents changed after inspection; fingerprint mismatch. Inspect again before inserting.",
		}
	end
	if preScan.summary.critical > 0 and p.allowCriticalRisk ~= true then
		container:Destroy()
		return {
			ok = false,
			err = "scan found critical risk; pass allowCriticalRisk=true only after reviewing the inspection report",
			result = preScan,
		}
	end
	local inserted = {}
	local quarantined = {}
	local quarantinePath = nil
	local okRecord, recordResult = recorded("guarded_insert_asset", function()
		local quarantineRoot = ServerStorage:FindFirstChild("NikMCPQuarantine")
		if not quarantineRoot then
			quarantineRoot = Instance.new("Folder")
			quarantineRoot.Name = "NikMCPQuarantine"
			quarantineRoot.Parent = ServerStorage
		end
		local quarantine = Instance.new("Folder")
		quarantine.Name = "Asset_" .. tostring(assetId) .. "_" .. tostring(os.time())
		quarantine:SetAttribute("AssetId", assetId)
		quarantine:SetAttribute("ScanFingerprint", preScan.fingerprint)
		quarantine.Parent = quarantineRoot
		quarantinePath = quarantine:GetFullName()
		quarantined = quarantineExecutables(container, quarantine)
		for _, child in ipairs(container:GetChildren()) do
			child.Parent = target
			table.insert(inserted, {
				path = child:GetFullName(),
				className = child.ClassName,
				name = child.Name,
			})
		end
	end)
	container:Destroy()
	if not okRecord then
		return { ok = false, err = "guarded insertion failed: " .. tostring(recordResult) }
	end
	local postScripts = {}
	local postRemotes = {}
	for _, root in ipairs(inserted) do
		local inst = resolvePath(root.path)
		if inst then
			for _, descendant in ipairs(inst:GetDescendants()) do
				if descendant:IsA("LuaSourceContainer") then
					table.insert(postScripts, descendant:GetFullName())
				elseif isRemote(descendant) then
					table.insert(postRemotes, descendant:GetFullName())
				end
			end
		end
	end
	return {
		ok = true,
		output = ("guarded insert completed: %d roots inserted, %d executable/network instances quarantined")
			:format(#inserted, #quarantined),
		result = {
			assetId = assetId,
			targetPath = p.targetPath,
			inserted = inserted,
			quarantined = quarantined,
			quarantinePath = quarantinePath,
			preInsertScan = preScan,
			postInsertScan = {
				scriptPaths = postScripts,
				remotePaths = postRemotes,
				clean = #postScripts == 0 and #postRemotes == 0,
			},
			scriptPolicy = "All Script, LocalScript, ModuleScript, RemoteEvent, RemoteFunction, and UnreliableRemoteEvent descendants were moved to ServerStorage.NikMCPQuarantine. BaseScripts were disabled.",
		},
	}
end

return AssetGuardTools
