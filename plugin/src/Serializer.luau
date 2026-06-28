--!strict
-- Bidirectional conversion between Roblox datatypes and JSON-safe tables.
-- Tagged form: { __t = "Vector3", x = ..., y = ..., z = ... }
local Serializer = {}

function Serializer.serialize(value: any): any
	local t = typeof(value)
	if t == "Vector3" then
		return { __t = "Vector3", x = value.X, y = value.Y, z = value.Z }
	elseif t == "Vector2" then
		return { __t = "Vector2", x = value.X, y = value.Y }
	elseif t == "CFrame" then
		return { __t = "CFrame", comps = { value:GetComponents() } }
	elseif t == "Color3" then
		return { __t = "Color3", r = value.R, g = value.G, b = value.B }
	elseif t == "UDim2" then
		local s, o = value.X, value.Y
		return { __t = "UDim2", xs = s.Scale, xo = s.Offset, ys = o.Scale, yo = o.Offset }
	elseif t == "UDim" then
		return { __t = "UDim", scale = value.Scale, offset = value.Offset }
	elseif t == "EnumItem" then
		return { __t = "EnumItem", enum = tostring(value.EnumType), name = value.Name }
	elseif t == "Instance" then
		return { __t = "Instance", className = value.ClassName, name = value.Name, path = value:GetFullName() }
	elseif t == "table" then
		local out: { [any]: any } = {}
		for k, v in pairs(value) do
			out[k] = Serializer.serialize(v)
		end
		return out
	else
		-- string | number | boolean | nil pass through
		return value
	end
end

function Serializer.deserialize(value: any): any
	if type(value) ~= "table" then
		return value
	end
	local tag = value.__t
	if tag == "Vector3" then
		return Vector3.new(value.x, value.y, value.z)
	elseif tag == "Vector2" then
		return Vector2.new(value.x, value.y)
	elseif tag == "CFrame" then
		return CFrame.new(table.unpack(value.comps))
	elseif tag == "Color3" then
		return Color3.new(value.r, value.g, value.b)
	elseif tag == "UDim2" then
		return UDim2.new(value.xs, value.xo, value.ys, value.yo)
	elseif tag == "UDim" then
		return UDim.new(value.scale, value.offset)
	elseif tag == "EnumItem" then
		local enumName = (value.enum :: string):gsub("^Enum%.", "")
		local enums = Enum :: any
		return enums[enumName][value.name]
	else
		return value -- plain table
	end
end

return Serializer
