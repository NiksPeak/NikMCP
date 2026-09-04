--!nonstrict
-- High-value agent reliability tools kept outside Executor.luau so the main
-- dispatch module remains safely below Luau's 200-local register limit.
local AgentTools = {}

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local ScriptProfilerService = game:GetService("ScriptProfilerService")

local resolvePath
local readEditorSource

function AgentTools.init(deps)
	resolvePath = deps and deps.resolvePath or nil
	readEditorSource = deps and deps.readEditorSource or nil
end

local SCRIPT_CLASSES = {
	Script = true,
	LocalScript = true,
	ModuleScript = true,
}
local profilerBusy = false

local function normalizeSource(source)
	return (string.gsub(source, "\r\n", "\n"))
end

-- FNV-1a over UTF-8 bytes. Keep this bit-identical to src/sync.ts.
local function sourceHash(source)
	local bytes = buffer.fromstring(normalizeSource(source))
	local hash = 2166136261
	for index = 0, buffer.len(bytes) - 1 do
		hash = bit32.bxor(hash, buffer.readu8(bytes, index))
		hash = (bit32.lshift(hash, 24) + bit32.lshift(hash, 8) + hash * 0x93) % 4294967296
	end
	return string.format("%08x", hash)
end

local function readSource(instance)
	if type(readEditorSource) ~= "function" then
		return false, "AgentTools.init requires readEditorSource"
	end
	local okCall, okRead, source = pcall(readEditorSource, instance)
	if not okCall then
		return false, tostring(okRead)
	end
	if not okRead or type(source) ~= "string" then
		return false, tostring(source or "could not read source")
	end
	return true, source
end

local function updateSourceIfHash(instance, expectedHash, source)
	local observedHash = nil
	local cancelledReason = nil
	local ok, err = pcall(function()
		ScriptEditorService:UpdateSourceAsync(instance, function(oldContent)
			if type(oldContent) ~= "string" then
				cancelledReason = "UpdateSourceAsync supplied non-string oldContent"
				return nil
			end
			observedHash = sourceHash(oldContent)
			if observedHash ~= expectedHash then
				cancelledReason =
					("source drifted inside UpdateSourceAsync: observed %s, expected %s")
						:format(tostring(observedHash), expectedHash)
				return nil
			end
			return source
		end)
	end)
	if not ok then
		return false, tostring(err), observedHash
	end
	if cancelledReason then
		return false, cancelledReason, observedHash
	end
	return true, nil, observedHash
end

local function rollbackTouched(touched, failure)
	local rows = {}
	local failures = {}
	for index = #touched, 1, -1 do
		local item = touched[index]
		local initialReadOk, initialSourceOrErr = readSource(item.instance)
		local initialHash = if initialReadOk then sourceHash(initialSourceOrErr) else nil
		local writeOk = initialReadOk
		local writeErr = if initialReadOk then nil else tostring(initialSourceOrErr)
		local callbackHash = nil
		if initialReadOk and initialHash == item.desiredHash then
			writeOk, writeErr, callbackHash =
				updateSourceIfHash(item.instance, item.desiredHash, item.originalSource)
		elseif initialReadOk and initialHash ~= item.beforeHash then
			writeOk = false
			writeErr =
				("rollback refused to overwrite concurrent source hash %s; expected patched %s or original %s")
					:format(tostring(initialHash), item.desiredHash, item.beforeHash)
		end

		local readOk, currentOrErr = readSource(item.instance)
		local restoredHash = if readOk then sourceHash(currentOrErr) else nil
		local restored = readOk and restoredHash == item.beforeHash
		local row = {
			path = item.path,
			beforeHash = item.beforeHash,
			initialRollbackHash = initialHash,
			callbackHash = callbackHash,
			restoredHash = restoredHash,
			restored = restored,
			writeOk = writeOk,
			writeError = writeErr,
			readError = if readOk then nil else tostring(currentOrErr),
		}
		table.insert(rows, 1, row)
		if not restored then
			table.insert(
				failures,
				("ROLLBACK FAILURE at %s: write=%s read=%s restoredHash=%s expected=%s")
					:format(
						item.path,
						tostring(writeErr or "ok"),
						tostring(if readOk then "ok" else currentOrErr),
						tostring(restoredHash),
						item.beforeHash
					)
			)
		end
	end

	local complete = #failures == 0
	local message = tostring(failure)
	if not complete then
		message ..= " | CRITICAL: transactional rollback was incomplete: " .. table.concat(failures, " | ")
	end
	return {
		ok = false,
		err = message,
		result = {
			phase = "rollback",
			failure = tostring(failure),
			mutationState = if complete
				then "all touched scripts restored to their pre-transaction hashes"
				else "CRITICAL: one or more scripts were not safely restored; concurrent source was preserved",
			rollback = {
				attempted = #touched,
				complete = complete,
				items = rows,
				failures = failures,
				strategy = "conditional source restore with before/desired hash guards",
			},
		},
	}
end

function AgentTools.applyScriptPatchset(payload)
	if RunService:IsRunning() then
		return { ok = false, err = "apply_script_patchset is edit-context only (stop the playtest first)" }
	end
	if type(resolvePath) ~= "function" or type(readEditorSource) ~= "function" then
		return { ok = false, err = "AgentTools.init was not called with resolvePath and readEditorSource" }
	end
	if type(payload) ~= "table" or payload.confirm ~= true then
		return { ok = false, err = "apply_script_patchset requires confirm=true" }
	end
	if type(payload.items) ~= "table" or #payload.items < 1 or #payload.items > 50 then
		return { ok = false, err = "items must contain 1-50 existing script patches" }
	end

	local validated = {}
	local seenInstances = {}
	local totalSourceBytes = 0
	for index, rawItem in ipairs(payload.items) do
		if type(rawItem) ~= "table" then
			return { ok = false, err = ("items[%d] must be an object"):format(index) }
		end
		if type(rawItem.path) ~= "string" or rawItem.path == "" then
			return { ok = false, err = ("items[%d].path must be a non-empty string"):format(index) }
		end
		if type(rawItem.expectedHash) ~= "string"
			or #rawItem.expectedHash ~= 8
			or not string.match(rawItem.expectedHash, "^[0-9a-fA-F]+$")
		then
			return { ok = false, err = ("items[%d].expectedHash must be an 8-character FNV-1a hex hash"):format(index) }
		end
		if type(rawItem.source) ~= "string" then
			return { ok = false, err = ("items[%d].source must be a string"):format(index) }
		end

		local instance = resolvePath(rawItem.path)
		if not instance then
			return { ok = false, err = ("items[%d] path not found: %s"):format(index, rawItem.path) }
		end
		if not SCRIPT_CLASSES[instance.ClassName] or not instance:IsA("LuaSourceContainer") then
			return {
				ok = false,
				err = ("items[%d] path is %s, not an editable Script, LocalScript, or ModuleScript: %s")
					:format(index, instance.ClassName, rawItem.path),
			}
		end
		if seenInstances[instance] then
			return {
				ok = false,
				err = ("items[%d] resolves to a script already present in this patchset: %s"):format(index, instance:GetFullName()),
			}
		end
		seenInstances[instance] = true

		local readOk, originalOrErr = readSource(instance)
		if not readOk then
			return {
				ok = false,
				err = ("items[%d] could not read %s: %s"):format(index, instance:GetFullName(), tostring(originalOrErr)),
			}
		end
		local beforeHash = sourceHash(originalOrErr)
		local expectedHash = string.lower(rawItem.expectedHash)
		if beforeHash ~= expectedHash then
			return {
				ok = false,
				err = ("items[%d] drifted before apply: %s is %s, expected %s")
					:format(index, instance:GetFullName(), beforeHash, expectedHash),
				result = {
					phase = "prevalidate",
					failedIndex = index,
					path = instance:GetFullName(),
					actualHash = beforeHash,
					expectedHash = expectedHash,
					mutation = "none",
				},
			}
		end

		local desiredSource = normalizeSource(rawItem.source)
		if #desiredSource > 1000000 then
			return {
				ok = false,
				err = ("items[%d].source exceeds the 1,000,000-byte cap"):format(index),
			}
		end
		local desiredHash = sourceHash(desiredSource)
		totalSourceBytes += #desiredSource
		if totalSourceBytes > 5000000 then
			return { ok = false, err = "patchset sources exceed the 5,000,000-byte total cap" }
		end
		table.insert(validated, {
			instance = instance,
			path = instance:GetFullName(),
			className = instance.ClassName,
			originalSource = originalOrErr,
			beforeHash = beforeHash,
			expectedHash = expectedHash,
			desiredSource = desiredSource,
			desiredHash = desiredHash,
		})
	end

	local changedCount = 0
	for _, item in ipairs(validated) do
		if item.beforeHash ~= item.desiredHash then
			changedCount += 1
		end
	end
	if changedCount == 0 then
		local evidence = {}
		for _, item in ipairs(validated) do
			table.insert(evidence, {
				path = item.path,
				className = item.className,
				beforeHash = item.beforeHash,
				afterHash = item.beforeHash,
				expectedHash = item.expectedHash,
				desiredHash = item.desiredHash,
				changed = false,
			})
		end
		return {
			ok = true,
			output = "transactional patchset already applied; no script source changed",
			result = {
				requestedCount = #validated,
				appliedCount = 0,
				totalSourceBytes = totalSourceBytes,
				undo = "not needed",
				items = evidence,
			},
		}
	end

	local touched = {}
	local evidence = {}

	for _, item in ipairs(validated) do
		local liveReadOk, liveSourceOrErr = readSource(item.instance)
		if not liveReadOk then
			return rollbackTouched(
				touched,
				("apply stopped before %s: source could not be re-read: %s"):format(item.path, tostring(liveSourceOrErr))
			)
		end
		local liveHash = sourceHash(liveSourceOrErr)
		if liveHash ~= item.beforeHash then
			return rollbackTouched(
				touched,
				("apply stopped before %s: concurrent drift changed hash from %s to %s")
					:format(item.path, item.beforeHash, liveHash)
			)
		end
		if item.beforeHash == item.desiredHash then
			table.insert(evidence, {
				path = item.path,
				className = item.className,
				beforeHash = item.beforeHash,
				afterHash = liveHash,
				expectedHash = item.expectedHash,
				desiredHash = item.desiredHash,
				changed = false,
			})
			continue
		end

		table.insert(touched, item)
		local writeOk, writeErr, callbackHash =
			updateSourceIfHash(item.instance, item.beforeHash, item.desiredSource)
		if not writeOk then
			return rollbackTouched(
				touched,
				("apply failed at %s: UpdateSourceAsync failed: %s (callback hash %s)")
					:format(item.path, tostring(writeErr), tostring(callbackHash))
			)
		end
		local readOk, currentOrErr = readSource(item.instance)
		if not readOk then
			return rollbackTouched(
				touched,
				("apply failed at %s: post-write source could not be read: %s"):format(item.path, tostring(currentOrErr))
			)
		end
		local afterHash = sourceHash(currentOrErr)
		if afterHash ~= item.desiredHash then
			return rollbackTouched(
				touched,
				("apply failed at %s: post-write hash %s did not match desired hash %s")
					:format(item.path, afterHash, item.desiredHash)
			)
		end
		table.insert(evidence, {
			path = item.path,
			className = item.className,
			beforeHash = item.beforeHash,
			afterHash = afterHash,
			expectedHash = item.expectedHash,
			desiredHash = item.desiredHash,
			changed = true,
		})
	end

	return {
		ok = true,
		output = ("transactional patchset applied: %d scripts changed, %d verified"):format(changedCount, #validated),
		result = {
			requestedCount = #validated,
			appliedCount = changedCount,
			totalSourceBytes = totalSourceBytes,
			undo = "LuaSourceContainer source writes are not captured by ChangeHistoryService",
			rollback = "on failure, every touched source is conditionally restored and hash-verified",
			verification = "every changed script was re-read and matched its desired FNV-1a hash",
			items = evidence,
		},
	}
end

local function boundedNumber(value, defaultValue, minimum, maximum)
	local numberValue = if value == nil then defaultValue else tonumber(value)
	if not numberValue or numberValue < minimum or numberValue > maximum then
		return nil
	end
	return numberValue
end

local function sanitizeProfile(root, maxDepth, maxNodes)
	local stats = {
		nodesVisited = 0,
		depthTruncations = 0,
		nodeTruncations = 0,
		stringTruncations = 0,
		cycles = 0,
	}
	local seen = {}

	local function sanitize(value, depth)
		if stats.nodesVisited >= maxNodes then
			stats.nodeTruncations += 1
			return "<truncated: node limit>"
		end
		stats.nodesVisited += 1
		if depth > maxDepth then
			stats.depthTruncations += 1
			return "<truncated: depth limit>"
		end

		local valueType = typeof(value)
		if value == nil or valueType == "boolean" then
			return value
		elseif valueType == "number" then
			if value ~= value or value == math.huge or value == -math.huge then
				return tostring(value)
			end
			return value
		elseif valueType == "string" then
			if #value > 4096 then
				stats.stringTruncations += 1
				return string.sub(value, 1, 4096) .. "<truncated>"
			end
			return value
		elseif valueType == "Instance" then
			local ok, path = pcall(function()
				return value:GetFullName()
			end)
			return {
				type = "Instance",
				path = if ok then path else tostring(value),
				className = value.ClassName,
			}
		elseif valueType ~= "table" then
			return tostring(value)
		end

		if seen[value] then
			stats.cycles += 1
			return "<cycle>"
		end
		seen[value] = true

		local length = #value
		local isArray = length > 0
		if isArray then
			for key in pairs(value) do
				if type(key) ~= "number" or key < 1 or key > length or key % 1 ~= 0 then
					isArray = false
					break
				end
			end
		end
		local output = {}
		if isArray then
			for index = 1, length do
				if stats.nodesVisited >= maxNodes then
					stats.nodeTruncations += 1
					table.insert(output, "<truncated: node limit>")
					break
				end
				table.insert(output, sanitize(value[index], depth + 1))
			end
		else
			for key, child in pairs(value) do
				if stats.nodesVisited >= maxNodes then
					stats.nodeTruncations += 1
					output["<truncated>"] = "node limit"
					break
				end
				local safeKey = tostring(key)
				if #safeKey > 256 then
					safeKey = string.sub(safeKey, 1, 256) .. "<truncated>"
				end
				output[safeKey] = sanitize(child, depth + 1)
			end
		end
		seen[value] = nil
		return output
	end

	return sanitize(root, 0), stats
end

function AgentTools.captureScriptProfile(payload)
	-- This module runs in Studio's edit-plugin DataModel, where the local
	-- RunService can remain stopped while a separate F5 server DataModel is
	-- active. The Node orchestrator requires a connected runtime server before
	-- dispatch; ScriptProfilerService's start call is the final engine check.
	local p = if type(payload) == "table" then payload else {}
	local side = tostring(p.side or "server")
	if side ~= "server" and side ~= "client" then
		return { ok = false, err = "side must be 'server' or 'client'" }
	end
	local duration = boundedNumber(p.durationSec, 2, 0.25, 10)
	local dataTimeout = boundedNumber(p.dataTimeoutSec, 5, 0.25, 10)
	local maxDepth = boundedNumber(p.maxDepth, 12, 1, 20)
	local maxNodes = boundedNumber(p.maxNodes, 5000, 100, 20000)
	if not duration then
		return { ok = false, err = "durationSec must be between 0.25 and 10" }
	elseif not dataTimeout then
		return { ok = false, err = "dataTimeoutSec must be between 0.25 and 10" }
	elseif not maxDepth then
		return { ok = false, err = "maxDepth must be between 1 and 20" }
	elseif not maxNodes then
		return { ok = false, err = "maxNodes must be between 100 and 20000" }
	end

	local targetPlayer = nil
	if side == "client" then
		targetPlayer = Players:GetPlayers()[1]
		if not targetPlayer then
			return { ok = false, err = "client profiling requires at least one playtest player" }
		end
	end
	if profilerBusy then
		return { ok = false, err = "another NikMCP script profile capture is already running" }
	end
	profilerBusy = true

	local jsonData = nil
	local dataPlayer = nil
	local acceptData = false
	local started = false
	local stopped = false
	local connectOk, connectionOrErr = pcall(function()
		return ScriptProfilerService.OnNewData:Connect(function(player, jsonString)
			local matches = if side == "server" then player == nil else player == targetPlayer
			if acceptData and matches and jsonData == nil and type(jsonString) == "string" then
				jsonData = jsonString
				dataPlayer = player
			end
		end)
	end)
	if not connectOk then
		profilerBusy = false
		return { ok = false, err = "could not subscribe to ScriptProfilerService.OnNewData: " .. tostring(connectionOrErr) }
	end
	local connection = connectionOrErr

	local function stopProfile()
		if not started or stopped then
			return true, nil
		end
		local ok, err = pcall(function()
			if side == "server" then
				ScriptProfilerService:ServerStop()
			else
				ScriptProfilerService:ClientStop(targetPlayer)
			end
		end)
		if ok then
			stopped = true
		end
		return ok, if ok then nil else tostring(err)
	end

	local okRun, resultOrErr = xpcall(function()
		local startOk, startErr = pcall(function()
			if side == "server" then
				ScriptProfilerService:ServerStart()
			else
				ScriptProfilerService:ClientStart(targetPlayer)
			end
		end)
		if not startOk then
			error(
				"capture_script_profile requires an active Studio playtest; profiler start failed: " .. tostring(startErr),
				0
			)
		end
		started = true

		local captureStartedAt = os.clock()
		task.wait(duration)
		local stopOk, stopErr = stopProfile()
		if not stopOk then
			error("profiler stop failed: " .. tostring(stopErr), 0)
		end

		acceptData = true
		local requestOk, requestErr = pcall(function()
			if side == "server" then
				ScriptProfilerService:ServerRequestData()
			else
				ScriptProfilerService:ClientRequestData(targetPlayer)
			end
		end)
		if not requestOk then
			acceptData = false
			error("profiler data request failed: " .. tostring(requestErr), 0)
		end

		local waitStartedAt = os.clock()
		while jsonData == nil and os.clock() - waitStartedAt < dataTimeout do
			task.wait(0.05)
		end
		if jsonData == nil then
			acceptData = false
			error(("profiler produced no %s data within %.2f seconds"):format(side, dataTimeout), 0)
		end
		acceptData = false
		local rawJson = jsonData
		local parseOk, parsedOrErr = pcall(function()
			return ScriptProfilerService:DeserializeJSON(rawJson)
		end)
		if not parseOk then
			error("profiler JSON deserialization failed: " .. tostring(parsedOrErr), 0)
		end
		local sanitized, truncation = sanitizeProfile(parsedOrErr, math.floor(maxDepth), math.floor(maxNodes))
		return {
			side = side,
			player = dataPlayer and dataPlayer.Name or nil,
			durationSec = duration,
			elapsedSec = os.clock() - captureStartedAt,
			frequency = "engine default",
			rawJsonBytes = #rawJson,
			profile = sanitized,
			truncation = truncation,
			rawJsonReturned = false,
		}
	end, debug.traceback)

	acceptData = false
	local cleanupStopOk, cleanupStopErr = stopProfile()
	local disconnectOk, disconnectErr = pcall(function()
		connection:Disconnect()
	end)
	profilerBusy = false
	if not okRun then
		local cleanupParts = {}
		if not cleanupStopOk then
			table.insert(cleanupParts, "cleanup stop failed: " .. tostring(cleanupStopErr))
		end
		if not disconnectOk then
			table.insert(cleanupParts, "cleanup disconnect failed: " .. tostring(disconnectErr))
		end
		local cleanupSuffix = if #cleanupParts > 0 then " | " .. table.concat(cleanupParts, " | ") else ""
		return { ok = false, err = tostring(resultOrErr) .. cleanupSuffix }
	end
	if not cleanupStopOk or not disconnectOk then
		return {
			ok = false,
			err = "profile data was captured, but cleanup was incomplete: "
				.. table.concat({
					if cleanupStopOk then "stop ok" else "stop failed: " .. tostring(cleanupStopErr),
					if disconnectOk then "disconnect ok" else "disconnect failed: " .. tostring(disconnectErr),
				}, "; "),
			result = resultOrErr,
		}
	end
	return {
		ok = true,
		output = ("captured %.2f seconds of bounded %s script-profiler data"):format(duration, side),
		result = resultOrErr,
	}
end

return AgentTools
