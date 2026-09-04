--!nonstrict
-- Blender environment import assembly, spatial/material audits, and recoverable
-- model-tree backups. Kept out of Executor to preserve its Luau register budget.
local EnvironmentTools = {}

local Workspace = game:GetService("Workspace")
local ServerStorage = game:GetService("ServerStorage")
local Selection = game:GetService("Selection")
local MaterialService = game:GetService("MaterialService")
local HttpService = game:GetService("HttpService")
local AssetService = game:GetService("AssetService")
local ContentProvider = game:GetService("ContentProvider")

local resolvePath
local recorded

function EnvironmentTools.init(deps)
	resolvePath = deps.resolvePath
	recorded = deps.recorded
end

local function pathOf(inst)
	return inst:GetFullName()
end

local function countTree(inst)
	return 1 + #inst:GetDescendants()
end

local function v3(value)
	return { x = value.X, y = value.Y, z = value.Z }
end

local function cfComponents(value)
	return { value:GetComponents() }
end

local function vectorFrom(value)
	if typeof(value) == "Vector3" then
		return value
	end
	if type(value) ~= "table" then
		return nil
	end
	if type(value[1]) == "number" and type(value[2]) == "number" and type(value[3]) == "number" then
		return Vector3.new(value[1], value[2], value[3])
	end
	local x = value.x or value.X
	local y = value.y or value.Y
	local z = value.z or value.Z
	if type(x) == "number" and type(y) == "number" and type(z) == "number" then
		return Vector3.new(x, y, z)
	end
	return nil
end

local function collectParts(root, cap)
	local out = {}
	if root:IsA("BasePart") then
		table.insert(out, root)
	end
	for _, d in ipairs(root:GetDescendants()) do
		if d:IsA("BasePart") then
			table.insert(out, d)
			if cap and #out >= cap then
				break
			end
		end
	end
	return out
end

local function aabbForPart(part)
	local half = part.Size / 2
	local minV = Vector3.new(math.huge, math.huge, math.huge)
	local maxV = Vector3.new(-math.huge, -math.huge, -math.huge)
	for sx = -1, 1, 2 do
		for sy = -1, 1, 2 do
			for sz = -1, 1, 2 do
				local p = part.CFrame * Vector3.new(half.X * sx, half.Y * sy, half.Z * sz)
				minV = Vector3.new(math.min(minV.X, p.X), math.min(minV.Y, p.Y), math.min(minV.Z, p.Z))
				maxV = Vector3.new(math.max(maxV.X, p.X), math.max(maxV.Y, p.Y), math.max(maxV.Z, p.Z))
			end
		end
	end
	return minV, maxV
end

local function boundsForPlans(plans)
	local minV = Vector3.new(math.huge, math.huge, math.huge)
	local maxV = Vector3.new(-math.huge, -math.huge, -math.huge)
	local found = false
	for _, plan in ipairs(plans) do
		for _, part in ipairs(collectParts(plan.instance)) do
			local pmin, pmax = aabbForPart(part)
			local delta = Vector3.new(0, plan.deltaY, 0)
			pmin += delta
			pmax += delta
			minV = Vector3.new(math.min(minV.X, pmin.X), math.min(minV.Y, pmin.Y), math.min(minV.Z, pmin.Z))
			maxV = Vector3.new(math.max(maxV.X, pmax.X), math.max(maxV.Y, pmax.Y), math.max(maxV.Z, pmax.Z))
			found = true
		end
	end
	if not found then
		return nil
	end
	return { min = minV, max = maxV, center = (minV + maxV) / 2, size = maxV - minV }
end

local function resolveRequestedRoots(p)
	local roots = {}
	local missing = {}
	local seen = {}
	local requested = p.paths or p.importedRoots or p.rootNames
	if type(requested) ~= "table" or #requested == 0 then
		return nil, { "no imported roots or paths supplied" }
	end
	for _, raw in ipairs(requested) do
		local key = tostring(raw)
		local inst = resolvePath(key)
		if not inst and not string.find(key, "%.", 1, false) then
			inst = Workspace:FindFirstChild(key)
		end
		if not inst then
			table.insert(missing, key)
		elseif not inst:IsA("PVInstance") then
			table.insert(missing, key .. " (not a Model/BasePart)")
		elseif not seen[inst] then
			seen[inst] = true
			table.insert(roots, inst)
		end
	end
	for i, a in ipairs(roots) do
		for j, b in ipairs(roots) do
			if i ~= j and b:IsDescendantOf(a) then
				return nil, { pathOf(b) .. " is already inside requested root " .. pathOf(a) }
			end
		end
	end
	return roots, missing
end

local function manifestRows(manifest)
	if type(manifest) ~= "table" then
		return {}, {}
	end
	local source = manifest.chunks or manifest.objects or manifest
	local byKey = {}
	local keys = {}
	if type(source) ~= "table" then
		return byKey, keys
	end
	for k, entry in pairs(source) do
		if type(entry) == "table" then
			local key = tostring(entry.path or entry.name or entry.chunk or k)
			byKey[key] = entry
			table.insert(keys, key)
		end
	end
	return byKey, keys
end

local function entryPosition(entry)
	if type(entry) ~= "table" then
		return nil
	end
	local candidates = {
		entry.intendedOrigin,
		entry.origin,
		entry.position,
		entry.pivotPosition,
		entry.worldPosition,
		entry.transform and entry.transform.position,
	}
	for _, candidate in ipairs(candidates) do
		local value = vectorFrom(candidate)
		if value then
			return value
		end
	end
	if type(entry.y) == "number" then
		return Vector3.new(0, entry.y, 0), true
	end
	return nil
end

local function findManifestEntry(byKey, inst)
	local full = pathOf(inst)
	return byKey[full] or byKey[inst.Name], byKey[full] and full or (byKey[inst.Name] and inst.Name or nil)
end

local function ensureBackupsFolder()
	local root = ServerStorage:FindFirstChild("NikMCPBackups")
	if root and not root:IsA("Folder") then
		return nil, "ServerStorage.NikMCPBackups exists but is not a Folder"
	end
	if not root then
		root = Instance.new("Folder")
		root.Name = "NikMCPBackups"
		root.Parent = ServerStorage
	end
	return root
end

local function cloneComplete(root)
	local states = {}
	local all = { root }
	for _, descendant in ipairs(root:GetDescendants()) do
		table.insert(all, descendant)
	end
	for _, inst in ipairs(all) do
		states[inst] = inst.Archivable
		inst.Archivable = true
	end
	local ok, cloned = pcall(function()
		return root:Clone()
	end)
	for inst, value in pairs(states) do
		if inst.Parent or inst == root then
			inst.Archivable = value
		end
	end
	if not ok then
		return nil, tostring(cloned)
	end
	return cloned
end

local function createBackup(name, roots, replace)
	if type(name) ~= "string" or name == "" then
		return nil, "backup name required"
	end
	local backups, rootErr = ensureBackupsFolder()
	if not backups then
		return nil, rootErr
	end
	local existing = backups:FindFirstChild(name)
	if existing and replace ~= true then
		return nil, "backup already exists: ServerStorage.NikMCPBackups." .. name .. " (pass replace=true to overwrite)"
	end
	local made
	local ok, err = recorded("NikMCP backup " .. name, function()
		if existing then
			existing:Destroy()
		end
		local folder = Instance.new("Folder")
		folder.Name = name
		folder:SetAttribute("NikMCPBackupCreatedAt", os.time())
		folder:SetAttribute("NikMCPBackupRootCount", #roots)
		for index, source in ipairs(roots) do
			local item = Instance.new("Folder")
			item.Name = ("Item_%04d"):format(index)
			item:SetAttribute("OriginalName", source.Name)
			item:SetAttribute("OriginalPath", pathOf(source))
			item:SetAttribute("OriginalParentPath", source.Parent and pathOf(source.Parent) or "")
			local clone, cloneErr = cloneComplete(source)
			if not clone then
				error("could not clone " .. pathOf(source) .. ": " .. tostring(cloneErr))
			end
			clone.Parent = item
			item.Parent = folder
		end
		folder.Parent = backups
		made = folder
	end)
	if not ok then
		return nil, tostring(err)
	end
	local objects = 0
	for _, item in ipairs(made:GetChildren()) do
		local clone = item:GetChildren()[1]
		if clone then
			objects += countTree(clone)
		end
	end
	return {
		name = name,
		location = pathOf(made),
		rootCount = #roots,
		objectCount = objects,
	}
end

function EnvironmentTools.backupSelection(p)
	local roots = {}
	local missing = {}
	if type(p.paths) == "table" and #p.paths > 0 then
		local seen = {}
		for _, path in ipairs(p.paths) do
			local inst = resolvePath(path)
			if inst and not seen[inst] then
				seen[inst] = true
				table.insert(roots, inst)
			else
				table.insert(missing, tostring(path))
			end
		end
	else
		roots = Selection:Get()
	end
	if #missing > 0 then
		return { ok = false, err = "backup paths not found: " .. table.concat(missing, ", ") }
	end
	if #roots == 0 then
		return { ok = false, err = "backup_selection needs paths or a non-empty Studio selection" }
	end
	for _, root in ipairs(roots) do
		if root == game or root.Parent == game then
			return { ok = false, err = "backup_selection is scoped to model trees, not DataModel services: " .. pathOf(root) }
		end
	end
	local result, err = createBackup(p.name, roots, p.replace == true)
	if not result then
		return { ok = false, err = err }
	end
	return { ok = true, result = result }
end

function EnvironmentTools.restoreBackup(p)
	if p.confirm ~= true then
		return { ok = false, err = "restore_backup mutates the place; pass confirm=true" }
	end
	local backups = ServerStorage:FindFirstChild("NikMCPBackups")
	local backup = backups and backups:FindFirstChild(tostring(p.name))
	if not backup then
		return { ok = false, err = "backup not found: ServerStorage.NikMCPBackups." .. tostring(p.name) }
	end
	local plans = {}
	for _, item in ipairs(backup:GetChildren()) do
		local source = item:GetChildren()[1]
		local parentPath = item:GetAttribute("OriginalParentPath")
		local originalName = item:GetAttribute("OriginalName")
		local parent = type(parentPath) == "string" and resolvePath(parentPath) or nil
		if not source or not parent or type(originalName) ~= "string" then
			return { ok = false, err = "backup item is incomplete: " .. pathOf(item) }
		end
		local collisions = {}
		for _, child in ipairs(parent:GetChildren()) do
			if child.Name == originalName then
				table.insert(collisions, child)
			end
		end
		if #collisions > 0 and p.replaceExisting ~= true then
			return {
				ok = false,
				err = "restore collision at " .. pathOf(parent) .. "." .. originalName
					.. " (pass replaceExisting=true to replace only that recorded path)",
			}
		end
		table.insert(plans, { source = source, parent = parent, name = originalName, collisions = collisions })
	end
	local restored = {}
	local objectCount = 0
	local ok, err = recorded("NikMCP restore " .. tostring(p.name), function()
		for _, plan in ipairs(plans) do
			for _, collision in ipairs(plan.collisions) do
				collision:Destroy()
			end
			local clone, cloneErr = cloneComplete(plan.source)
			if not clone then
				error(cloneErr)
			end
			clone.Name = plan.name
			clone.Parent = plan.parent
			table.insert(restored, pathOf(clone))
			objectCount += countTree(clone)
		end
	end)
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	return {
		ok = true,
		result = {
			name = p.name,
			backupLocation = pathOf(backup),
			restoredPaths = restored,
			rootCount = #restored,
			objectCount = objectCount,
			backupRetained = true,
		},
	}
end

function EnvironmentTools.assembleImportedChunks(p)
	local roots, missing = resolveRequestedRoots(p)
	if not roots then
		return { ok = false, err = table.concat(missing, "; ") }
	end
	local byKey, manifestKeys = manifestRows(p.manifest)
	local usedManifest = {}
	local warnings = {}
	local reference = nil
	if p.referenceChunk then
		for _, root in ipairs(roots) do
			if root.Name == p.referenceChunk or pathOf(root) == p.referenceChunk then
				reference = root
				break
			end
		end
		reference = reference or resolvePath(p.referenceChunk)
		if not reference then
			table.insert(warnings, "reference chunk not found: " .. tostring(p.referenceChunk))
		end
	end
	local sharedOffsetY = 0
	local referenceEntry = reference and select(1, findManifestEntry(byKey, reference)) or nil
	local referenceExpected = entryPosition(referenceEntry)
	if reference and referenceExpected then
		sharedOffsetY = reference:GetPivot().Position.Y - referenceExpected.Y
	end
	local plans = {}
	local partCount = 0
	local unanchored = 0
	local maxOriginError = 0
	local placementMissing = false
	local requestedMissing = #missing > 0
	for _, root in ipairs(roots) do
		local pivot = root:GetPivot()
		local entry, key = findManifestEntry(byKey, root)
		local expected, yOnly = entryPosition(entry)
		if key then
			usedManifest[key] = true
		end
		local targetY = nil
		if expected then
			targetY = expected.Y + sharedOffsetY
		elseif reference then
			targetY = reference:GetPivot().Position.Y
			table.insert(warnings, "no manifest origin for " .. root.Name .. "; aligned to reference Y")
		else
			table.insert(missing, root.Name .. " (no manifest origin and no reference chunk)")
			placementMissing = true
		end
		local deltaY = targetY and (targetY - pivot.Position.Y) or 0
		local projected = pivot.Position + Vector3.new(0, deltaY, 0)
		if expected and not yOnly then
			local intended = expected + Vector3.new(0, sharedOffsetY, 0)
			maxOriginError = math.max(maxOriginError, (projected - intended).Magnitude)
		end
		local parts = collectParts(root)
		partCount += #parts
		for _, part in ipairs(parts) do
			if not part.Anchored then
				unanchored += 1
			end
		end
		table.insert(plans, {
			instance = root,
			originalPivot = pivot,
			targetPivot = pivot + Vector3.new(0, deltaY, 0),
			deltaY = deltaY,
		})
	end
	for _, key in ipairs(manifestKeys) do
		if not usedManifest[key] then
			table.insert(missing, key .. " (manifest chunk not imported/requested)")
		end
	end
	local bounds = boundsForPlans(plans)
	local reportedPlans = {}
	for _, plan in ipairs(plans) do
		table.insert(reportedPlans, {
			path = pathOf(plan.instance),
			originalPivot = cfComponents(plan.originalPivot),
			targetPivot = cfComponents(plan.targetPivot),
			deltaY = plan.deltaY,
		})
	end
	local reportedBounds = bounds and {
		min = v3(bounds.min),
		max = v3(bounds.max),
		center = v3(bounds.center),
		size = v3(bounds.size),
	} or nil
	local dryRun = p.dryRun ~= false
	local backupResult = nil
	if not dryRun then
		if requestedMissing or placementMissing then
			return {
				ok = false,
				err = "assembly preflight has missing requested chunks or unresolved Y origins; run dryRun and fix missingChunks before applying",
			}
		end
		local parentRootName = p.parentRootName or "LobbyEnvironment"
		local parentPath = p.parentPath or "Workspace"
		local parent = resolvePath(parentPath)
		if not parent then
			return { ok = false, err = "parent path not found: " .. tostring(parentPath) }
		end
		local existingRoot = parent:FindFirstChild(parentRootName)
		if existingRoot and not existingRoot:IsA("Model") then
			return { ok = false, err = pathOf(existingRoot) .. " exists but is not a Model" }
		end
		if existingRoot then
			for _, root in ipairs(roots) do
				if root == existingRoot then
					return { ok = false, err = "an imported chunk cannot also be the assembly root: " .. pathOf(root) }
				end
			end
		end
		if p.backupName then
			local backupErr
			backupResult, backupErr = createBackup(p.backupName, roots, p.replaceBackup == true)
			if not backupResult then
				return { ok = false, err = backupErr }
			end
		end
		local ok, err = recorded("Assemble imported chunks", function()
			local assemblyRoot = existingRoot
			if not assemblyRoot then
				assemblyRoot = Instance.new("Model")
				assemblyRoot.Name = parentRootName
				assemblyRoot.Parent = parent
			end
			local assemblyId = HttpService:GenerateGUID(false)
			for _, plan in ipairs(plans) do
				local root = plan.instance
				root:SetAttribute("NikMCP_AssemblyId", assemblyId)
				root:SetAttribute("NikMCP_OriginalPivot", plan.originalPivot)
				root:SetAttribute("NikMCP_AppliedDeltaY", plan.deltaY)
				root:PivotTo(plan.targetPivot)
				root.Parent = assemblyRoot
				if p.anchorParts ~= false then
					for _, part in ipairs(collectParts(root)) do
						part.Anchored = true
					end
				end
			end
			assemblyRoot:SetAttribute("NikMCP_AssemblyId", assemblyId)
			assemblyRoot:SetAttribute("NikMCP_ChunkCount", #plans)
		end)
		if not ok then
			return { ok = false, err = tostring(err) }
		end
	end
	return {
		ok = true,
		result = {
			dryRun = dryRun,
			parentRootName = p.parentRootName or "LobbyEnvironment",
			chunkCount = #plans,
			basePartCount = partCount,
			unanchoredCount = (p.anchorParts ~= false) and 0 or unanchored,
			unanchoredBefore = unanchored,
			assembledBounds = reportedBounds,
			maximumHorizontalDrift = 0,
			maximumOriginReconstructionError = maxOriginError,
			missingChunks = missing,
			warnings = warnings,
			backup = backupResult,
			plans = reportedPlans,
		},
	}
end

local function validAssetRef(value)
	if type(value) ~= "string" or value == "" then
		return false
	end
	return string.match(value, "^rbxassetid://%d+$") ~= nil
		or string.match(value, "^https?://") ~= nil
		or string.match(value, "^rbxasset://") ~= nil
		or string.match(value, "^rbxthumb://") ~= nil
end

local function readProperty(inst, property)
	local ok, value = pcall(function()
		return inst[property]
	end)
	if ok then
		return value, true
	end
	return nil, false
end

local SURFACE_MAPS = { "ColorMap", "NormalMap", "RoughnessMap", "MetalnessMap" }

local function inspectTextureRoot(root, maxMeshes)
	local meshes = {}
	local totalMeshCount = 0
	local usage = {
		meshTextureIds = {},
		surfaceMaps = {},
		materialVariants = {},
		materials = {},
		fetchStatuses = {},
	}
	local issues = { critical = {}, warning = {}, info = {} }
	local fallbackCount = 0
	local checkedFetch = {}
	local function checkFetchStatus(path, property, assetRef)
		if not validAssetRef(assetRef) or checkedFetch[assetRef] then
			return
		end
		checkedFetch[assetRef] = true
		local okStatus, status = pcall(function()
			return ContentProvider:GetAssetFetchStatus(assetRef)
		end)
		usage.fetchStatuses[assetRef] = okStatus and status.Name or "Unreadable"
		if okStatus and status.Name == "Failure" then
			table.insert(issues.critical, {
				path = path,
				kind = "asset_fetch_failure",
				property = property,
				detail = assetRef,
				suggestedFix = "Verify ownership/moderation/permissions and replace or reupload the failed dependency.",
			})
		end
	end
	for _, part in ipairs(collectParts(root)) do
		usage.materials[part.Material.Name] = (usage.materials[part.Material.Name] or 0) + 1
		local materialVariant = readProperty(part, "MaterialVariant") or ""
		if materialVariant ~= "" then
			usage.materialVariants[materialVariant] = (usage.materialVariants[materialVariant] or 0) + 1
			if not MaterialService:FindFirstChild(materialVariant) then
				table.insert(issues.critical, {
					path = pathOf(part),
					kind = "missing_material_variant",
					detail = "MaterialVariant '" .. materialVariant .. "' is not present in MaterialService",
					suggestedFix = "Import or recreate the named MaterialVariant, or clear the stale reference.",
				})
			end
		end
		if part:IsA("MeshPart") then
			totalMeshCount += 1
			local surface = part:FindFirstChildOfClass("SurfaceAppearance")
			local meshId, meshIdReadable = readProperty(part, "MeshId")
			local textureId, textureIdReadable = readProperty(part, "TextureID")
			local meshState = {
				path = pathOf(part),
				meshId = meshIdReadable and meshId or nil,
				meshIdReadable = meshIdReadable,
				textureId = textureIdReadable and textureId or nil,
				textureIdReadable = textureIdReadable,
				material = part.Material.Name,
				materialVariant = materialVariant,
				surfaceAppearance = surface and pathOf(surface) or nil,
			}
			if meshIdReadable and (meshId == "" or not validAssetRef(meshId)) then
				table.insert(issues.critical, {
					path = pathOf(part), kind = "missing_or_invalid_mesh_id",
					detail = "MeshPart.MeshId is empty or not a recognizable asset reference.",
					suggestedFix = "Reimport the mesh or assign a valid Roblox mesh asset.",
				})
			elseif not meshIdReadable then
				table.insert(issues.info, {
					path = pathOf(part), kind = "mesh_id_not_readable",
					detail = "Studio security did not expose MeshPart.MeshId in this plugin context.",
					suggestedFix = "Use the per-mesh import report or enable the permitted deep mesh scan if triangle/dependency proof is required.",
				})
			end
			if meshIdReadable and meshId ~= "" then
				checkFetchStatus(pathOf(part), "MeshId", meshId)
			end
			if textureIdReadable and textureId ~= "" then
				usage.meshTextureIds[textureId] = (usage.meshTextureIds[textureId] or 0) + 1
				if not validAssetRef(textureId) then
					table.insert(issues.critical, {
						path = pathOf(part), kind = "invalid_texture_id", detail = textureId,
						suggestedFix = "Assign a valid Roblox texture asset reference or reimport the FBX dependency.",
					})
				end
				checkFetchStatus(pathOf(part), "TextureID", textureId)
			end
			if surface then
				local maps = {}
				for _, prop in ipairs(SURFACE_MAPS) do
					local value, readable = readProperty(surface, prop)
					value = readable and value or ""
					maps[prop] = value
					if value ~= "" then
						usage.surfaceMaps[value] = (usage.surfaceMaps[value] or 0) + 1
						if not validAssetRef(value) then
							table.insert(issues.critical, {
								path = pathOf(surface), kind = "invalid_surface_map", property = prop, detail = value,
								suggestedFix = "Replace the invalid map reference with an uploaded Roblox image asset.",
							})
						end
						checkFetchStatus(pathOf(surface), prop, value)
					end
				end
				meshState.surfaceMaps = maps
				if maps.ColorMap == "" and (not textureIdReadable or textureId == "") then
					table.insert(issues.warning, {
						path = pathOf(part), kind = "surface_without_color_dependency",
						detail = "SurfaceAppearance has no ColorMap and MeshPart.TextureID is empty.",
						suggestedFix = "Confirm this is intentionally material-only; otherwise restore the missing color texture.",
					})
				end
			elseif textureIdReadable and textureId == "" and materialVariant == ""
				and (part.Material == Enum.Material.Plastic or part.Material == Enum.Material.SmoothPlastic) then
				fallbackCount += 1
				table.insert(issues.warning, {
					path = pathOf(part), kind = "likely_fallback_material",
					detail = "Mesh has no TextureID, SurfaceAppearance, or MaterialVariant and uses a default plastic material.",
					suggestedFix = "Check the FBX image dependency and material assignment; leave it only if plain plastic is intentional.",
				})
			end
			if #meshes < maxMeshes then
				table.insert(meshes, meshState)
			end
		end
	end
	return {
		meshCount = totalMeshCount,
		perMeshTruncated = totalMeshCount > #meshes,
		perMesh = meshes,
		usageCounts = usage,
		issues = issues,
		fallbackMaterialCount = fallbackCount,
		uvLimitation = "Roblox cannot repair invalid Blender UVs. This audit only identifies missing or suspicious imported dependencies; UV unwrap/channel defects must be fixed and re-exported from Blender.",
		fetchStatusLimitation = "GetAssetFetchStatus reports current engine state only. A non-Failure status does not prove that an asset will load for every client or permission context.",
	}
end

function EnvironmentTools.inspectTextureHealth(p)
	local root = resolvePath(p.path or p.root)
	if not root then
		return { ok = false, err = "texture-health root not found: " .. tostring(p.path or p.root) }
	end
	local result = inspectTextureRoot(root, math.clamp(tonumber(p.maxMeshes) or 2000, 1, 10000))
	result.root = pathOf(root)
	return { ok = true, result = result }
end

local function addFinding(groups, severity, finding, cap)
	if #groups.critical + #groups.warning + #groups.info >= cap then
		return false
	end
	table.insert(groups[severity], finding)
	return true
end

function EnvironmentTools.auditEnvironment(p)
	local root = resolvePath(p.path or p.root)
	if not root then
		return { ok = false, err = "audit root not found: " .. tostring(p.path or p.root) }
	end
	local maxParts = math.clamp(tonumber(p.maxParts) or 2000, 1, 10000)
	local parts = collectParts(root, maxParts)
	local allPartCount = root:IsA("BasePart") and 1 or 0
	for _, d in ipairs(root:GetDescendants()) do
		if d:IsA("BasePart") then allPartCount += 1 end
	end
	local findings = { critical = {}, warning = {}, info = {} }
	local cap = math.clamp(tonumber(p.maxFindings) or 500, 1, 5000)
	local sceneMin = vectorFrom(p.sceneMin or (p.sceneBounds and p.sceneBounds.min))
	local sceneMax = vectorFrom(p.sceneMax or (p.sceneBounds and p.sceneBounds.max))
	local triangleLimit = tonumber(p.triangleLimit) or 20000
	local floatingDistance = tonumber(p.floatingDistance) or 5
	local floatingTolerance = tonumber(p.floatingTolerance) or 0.08
	local nearTolerance = tonumber(p.nearCoplanarTolerance) or 0.02
	local aabbs = {}
	local triangleInspectable = 0
	local triangleScanFailures = 0
	local deepTriangleScans = 0
	local meshPartCount = 0
	local maxTriangleMeshes = math.clamp(tonumber(p.maxTriangleMeshes) or 100, 0, 1000)
	for _, part in ipairs(parts) do
		local minV, maxV = aabbForPart(part)
		table.insert(aabbs, { part = part, min = minV, max = maxV })
		if not part.Anchored then
			addFinding(findings, "critical", {
				path = pathOf(part), kind = "unanchored_part", detail = "Imported environment part is not anchored.",
				suggestedFix = "Anchor the part unless it is intentionally physics-driven.",
			}, cap)
		end
		if part.CanCollide and part.Transparency >= 0.99 and not part:IsA("SpawnLocation") then
			addFinding(findings, "warning", {
				path = pathOf(part),
				kind = "invisible_collision",
				detail = "Fully transparent part still has CanCollide enabled.",
				suggestedFix = "Confirm this is an intentional blocker; otherwise disable collision or make the boundary visible.",
			}, cap)
		end
		if sceneMin and sceneMax and (
			minV.X < sceneMin.X or minV.Y < sceneMin.Y or minV.Z < sceneMin.Z
			or maxV.X > sceneMax.X or maxV.Y > sceneMax.Y or maxV.Z > sceneMax.Z
		) then
			addFinding(findings, "warning", {
				path = pathOf(part), kind = "outside_scene_bounds", bounds = { min = v3(minV), max = v3(maxV) },
				suggestedFix = "Move the object inside the configured scene bounds or expand the bounds intentionally.",
			}, cap)
		end
		if part:IsA("MeshPart") then
			meshPartCount += 1
			local okMesh, meshSize = pcall(function() return part.MeshSize end)
			if okMesh and typeof(meshSize) == "Vector3" and meshSize.X > 0 and meshSize.Y > 0 and meshSize.Z > 0 then
				local scale = Vector3.new(part.Size.X / meshSize.X, part.Size.Y / meshSize.Y, part.Size.Z / meshSize.Z)
				local lo = math.min(scale.X, scale.Y, scale.Z)
				local hi = math.max(scale.X, scale.Y, scale.Z)
				if lo > 0 and hi / lo > (tonumber(p.nonUniformScaleRatio) or 1.05) then
					addFinding(findings, "warning", {
						path = pathOf(part), kind = "non_uniform_mesh_scale", scale = v3(scale),
						suggestedFix = "Apply scale in Blender and re-export if this distortion is unintended.",
					}, cap)
				end
			end
			local triangleCount = nil
			-- MeshPart has no official TriangleCount property. An opt-in deep scan
			-- uses the documented EditableMesh:GetFaces() path, capped because it
			-- yields, consumes editable-mesh memory, and can require asset permission.
			if p.deepTriangleScan == true and deepTriangleScans < maxTriangleMeshes then
				deepTriangleScans += 1
				local meshId, readable = readProperty(part, "MeshId")
				if readable and validAssetRef(meshId) then
					local okEditable, editable = pcall(function()
						return AssetService:CreateEditableMeshAsync(Content.fromUri(meshId), { FixedSize = true })
					end)
					if okEditable and editable then
						local okFaces, faces = pcall(function() return editable:GetFaces() end)
						if okFaces and type(faces) == "table" then
							triangleCount = #faces
						end
						pcall(function() editable:Destroy() end)
					else
						triangleScanFailures += 1
					end
				else
					triangleScanFailures += 1
				end
			end
			if type(triangleCount) == "number" then
				triangleInspectable += 1
				if triangleCount > triangleLimit then
					addFinding(findings, "critical", {
						path = pathOf(part), kind = "triangle_limit", triangleCount = triangleCount, limit = triangleLimit,
						suggestedFix = "Split or decimate this mesh in Blender and re-export it below the configured limit.",
					}, cap)
				end
			end
		end
		local horizontalArea = part.Size.X * part.Size.Z
		if horizontalArea < (tonumber(p.groundAreaSkip) or 10000) then
			local params = RaycastParams.new()
			params.FilterType = Enum.RaycastFilterType.Exclude
			params.FilterDescendantsInstances = { part }
			local origin = Vector3.new(part.Position.X, minV.Y + 0.05, part.Position.Z)
			local hit = Workspace:Raycast(origin, Vector3.new(0, -floatingDistance, 0), params)
			if not hit then
				addFinding(findings, "warning", {
					path = pathOf(part), kind = "no_support_below", checkedDistance = floatingDistance,
					suggestedFix = "Inspect this object in side view and move it onto terrain/support if it is meant to be grounded.",
				}, cap)
			else
				local gap = math.max(0, minV.Y - hit.Position.Y)
				if gap > floatingTolerance then
					addFinding(findings, "warning", {
						path = pathOf(part), kind = "floating_gap", gap = gap, supportPath = pathOf(hit.Instance),
						suggestedFix = "Lower the object to its support or confirm the gap is intentional.",
					}, cap)
				end
			end
		end
	end
	local pairCap = math.clamp(tonumber(p.maxPairs) or 250000, 1, 1000000)
	local pairsChecked = 0
	local pairTruncated = false
	for i = 1, #aabbs do
		for j = i + 1, #aabbs do
			pairsChecked += 1
			if pairsChecked > pairCap then
				pairTruncated = true
				break
			end
			local a, b = aabbs[i], aabbs[j]
			local ox = math.min(a.max.X, b.max.X) - math.max(a.min.X, b.min.X)
			local oy = math.min(a.max.Y, b.max.Y) - math.max(a.min.Y, b.min.Y)
			local oz = math.min(a.max.Z, b.max.Z) - math.max(a.min.Z, b.min.Z)
			if ox > 0 and oy > 0 and oz > 0 then
				local overlaps = { ox, oy, oz }
				table.sort(overlaps)
				local sameSize = (a.part.Size - b.part.Size).Magnitude < 0.01
				local samePosition = (a.part.Position - b.part.Position).Magnitude < 0.01
				if sameSize and samePosition then
					addFinding(findings, "critical", {
						paths = { pathOf(a.part), pathOf(b.part) }, kind = "duplicate_geometry",
						suggestedFix = "Delete the unintended duplicate or offset it deliberately.",
					}, cap)
				elseif overlaps[1] <= nearTolerance and overlaps[2] > 0.25 and overlaps[3] > 0.25 then
					addFinding(findings, "warning", {
						paths = { pathOf(a.part), pathOf(b.part) }, kind = "near_coplanar_overlap",
						minimumOverlap = overlaps[1],
						suggestedFix = "Separate, trim, or slightly desize one surface to remove likely Z-fighting.",
					}, cap)
				else
					local intersection = ox * oy * oz
					local minVolume = math.min(a.part.Size.X * a.part.Size.Y * a.part.Size.Z, b.part.Size.X * b.part.Size.Y * b.part.Size.Z)
					if minVolume > 0 and intersection / minVolume > (tonumber(p.deepIntersectionRatio) or 0.5) then
						addFinding(findings, "warning", {
							paths = { pathOf(a.part), pathOf(b.part) }, kind = "deep_intersection",
							intersectionRatio = intersection / minVolume,
							suggestedFix = "Inspect both pieces; trim or reposition one if this embedding is not structural.",
						}, cap)
					end
				end
			end
		end
		if pairTruncated then break end
	end
	local textures = inspectTextureRoot(root, maxParts)
	for severity, rows in pairs(textures.issues) do
		for _, row in ipairs(rows) do
			addFinding(findings, severity, row, cap)
		end
	end
	local total = #findings.critical + #findings.warning + #findings.info
	return {
		ok = true,
		result = {
			root = pathOf(root),
			summary = {
				partsScanned = #parts,
				totalParts = allPartCount,
				truncatedParts = allPartCount > #parts,
				pairsChecked = pairsChecked,
				pairScanTruncated = pairTruncated,
				triangleInspectableMeshParts = triangleInspectable,
				deepTriangleScans = deepTriangleScans,
				triangleScanFailures = triangleScanFailures,
				triangleScanTruncated = p.deepTriangleScan == true and deepTriangleScans < meshPartCount,
				critical = #findings.critical,
				warning = #findings.warning,
				info = #findings.info,
				totalFindings = total,
				findingsTruncated = total >= cap,
			},
			findings = findings,
			heuristics = {
				geometry = "AABB overlap checks are conservative and may over-report rotated or intentionally nested geometry.",
				floating = "Downward center raycasts cannot prove every contact point; inspect reported paths visually.",
				triangles = triangleInspectable > 0
					and "Triangle counts came from opt-in EditableMesh:GetFaces() reads."
					or (p.deepTriangleScan == true
						and "Deep triangle scan produced no readable meshes. Check Allow Mesh/Image APIs, asset permissions, and maxTriangleMeshes."
						or "Roblox exposes no MeshPart.TriangleCount property. Pass deepTriangleScan=true for a capped EditableMesh:GetFaces() audit."),
				uv = textures.uvLimitation,
			},
		},
	}
end

return EnvironmentTools
