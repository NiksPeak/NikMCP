--!nonstrict
-- Edit-context QA helpers. Multi-client orchestration stays Node-side; this
-- module owns only privileged Studio device simulator state.
local QATools = {}

local RunService = game:GetService("RunService")
local StudioDeviceSimulatorService = game:GetService("StudioDeviceSimulatorService")

local temporaryDevices = {}
local deviceSequence = 0

local function callGetter(methodName)
	local ok, value = pcall(function()
		return StudioDeviceSimulatorService[methodName](StudioDeviceSimulatorService)
	end)
	if not ok then
		return nil, tostring(value)
	end
	return value, nil
end

local function currentState()
	local deviceId, deviceErr = callGetter("GetDeviceAsync")
	local resolution, resolutionErr = callGetter("GetResolutionAsync")
	local orientation, orientationErr = callGetter("GetOrientationAsync")
	local pixelDensity, densityErr = callGetter("GetPixelDensityAsync")
	local scalingMode, scalingErr = callGetter("GetScalingModeAsync")
	return {
		deviceId = deviceId,
		resolution = resolution and { x = resolution.X, y = resolution.Y } or nil,
		orientation = orientation and orientation.Name or nil,
		pixelDensity = pixelDensity,
		scalingMode = scalingMode and scalingMode.Name or nil,
		readErrors = {
			device = deviceErr,
			resolution = resolutionErr,
			orientation = orientationErr,
			pixelDensity = densityErr,
			scalingMode = scalingErr,
		},
	}
end

function QATools.deviceSnapshot()
	if RunService:IsRunning() then
		return { ok = false, err = "device simulator snapshot is edit-context only" }
	end
	return { ok = true, result = currentState() }
end

local function enumItem(enumType, name)
	for _, item in ipairs(enumType:GetEnumItems()) do
		if item.Name == name then
			return item
		end
	end
	return nil
end

function QATools.deviceApply(p)
	if RunService:IsRunning() then
		return { ok = false, err = "device simulator changes are edit-context only" }
	end
	local width = math.floor(tonumber(p.width) or 0)
	local height = math.floor(tonumber(p.height) or 0)
	local density = math.floor(tonumber(p.pixelDensity) or 0)
	if width < 100 or height < 100 or density < 1 then
		return { ok = false, err = "width, height, and pixelDensity must describe a real device profile" }
	end
	local deviceForm = enumItem(Enum.DeviceForm, tostring(p.deviceForm))
	local orientation = enumItem(Enum.ScreenOrientation, tostring(p.orientation))
	local scalingMode = enumItem(Enum.DeviceSimulatorScalingMode, tostring(p.scalingMode or "FitToWindow"))
	if not deviceForm or not orientation or not scalingMode then
		return { ok = false, err = "invalid deviceForm, orientation, or scalingMode enum name" }
	end
	deviceSequence += 1
	local okCreate, deviceId = pcall(function()
		return StudioDeviceSimulatorService:CreateDeviceAsync({
			Name = "NikMCP QA " .. tostring(p.label or "device") .. " " .. tostring(deviceSequence),
			Width = width,
			Height = height,
			PixelDensity = density,
			DeviceForm = deviceForm,
		})
	end)
	if not okCreate then
		return { ok = false, err = "CreateDeviceAsync failed: " .. tostring(deviceId) }
	end
	table.insert(temporaryDevices, deviceId)
	local okApply, applyErr = pcall(function()
		StudioDeviceSimulatorService:SetDeviceAsync(deviceId)
		StudioDeviceSimulatorService:SetOrientationAsync(orientation)
		StudioDeviceSimulatorService:SetResolutionAsync(width, height)
		StudioDeviceSimulatorService:SetPixelDensityAsync(density)
		StudioDeviceSimulatorService:SetScalingModeAsync(scalingMode)
	end)
	if not okApply then
		return { ok = false, err = "device profile apply failed: " .. tostring(applyErr), result = { deviceId = deviceId } }
	end
	return {
		ok = true,
		result = {
			temporaryDeviceId = deviceId,
			requested = {
				label = p.label,
				width = width,
				height = height,
				pixelDensity = density,
				deviceForm = deviceForm.Name,
				orientation = orientation.Name,
				scalingMode = scalingMode.Name,
			},
			active = currentState(),
		},
	}
end

function QATools.deviceRestore(p)
	if RunService:IsRunning() then
		return { ok = false, err = "device simulator restore is edit-context only" }
	end
	local snapshot = type(p.snapshot) == "table" and p.snapshot or {}
	local errors = {}
	local targetId = tostring(snapshot.deviceId or "default")
	local okSwitch, switchErr = pcall(function()
		if targetId == "" or targetId == "default" then
			StudioDeviceSimulatorService:StopSimulationAsync()
		else
			StudioDeviceSimulatorService:SetDeviceAsync(targetId)
		end
	end)
	if not okSwitch then
		table.insert(errors, "restore device: " .. tostring(switchErr))
	end
	if okSwitch and targetId ~= "default" then
		local okDetails, detailsErr = pcall(function()
			local orientation = enumItem(Enum.ScreenOrientation, tostring(snapshot.orientation))
			local scalingMode = enumItem(Enum.DeviceSimulatorScalingMode, tostring(snapshot.scalingMode))
			if orientation then
				StudioDeviceSimulatorService:SetOrientationAsync(orientation)
			end
			if type(snapshot.resolution) == "table" then
				StudioDeviceSimulatorService:SetResolutionAsync(
					tonumber(snapshot.resolution.x) or 0,
					tonumber(snapshot.resolution.y) or 0
				)
			end
			if tonumber(snapshot.pixelDensity) then
				StudioDeviceSimulatorService:SetPixelDensityAsync(tonumber(snapshot.pixelDensity))
			end
			if scalingMode then
				StudioDeviceSimulatorService:SetScalingModeAsync(scalingMode)
			end
		end)
		if not okDetails then
			table.insert(errors, "restore profile: " .. tostring(detailsErr))
		end
	end
	local removed = {}
	for _, deviceId in ipairs(temporaryDevices) do
		local okRemove, removeErr = pcall(function()
			StudioDeviceSimulatorService:RemoveDeviceAsync(deviceId)
		end)
		table.insert(removed, {
			deviceId = deviceId,
			removed = okRemove,
			error = if okRemove then nil else tostring(removeErr),
		})
	end
	temporaryDevices = {}
	return {
		ok = #errors == 0,
		err = #errors > 0 and table.concat(errors, "; ") or nil,
		result = {
			restored = currentState(),
			temporaryDevices = removed,
			errors = errors,
		},
	}
end

return QATools
