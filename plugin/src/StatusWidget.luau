-- Dock widget: Nik Studio MCP control panel.
-- Layered dark dashboard: gradient-lifted header with a pulsing status pill,
-- a monospace address field-chip, a horizontally-scrolling port lane (state-
-- colored chips + pinned "+"), four status rows, an animated arm toggle on the
-- Playtest agent row, and a sheened Connect/Disconnect button.
-- Polish (hover, press-squash, pulse, soft click) per addictive-game-feel;
-- UIListLayout + AutomaticSize + ScrollingFrame sizing per roblox-ui-layout.
local StatusWidget = {}
StatusWidget.__index = StatusWidget

local SoundService = game:GetService("SoundService")
local TweenService = game:GetService("TweenService")

local Settings = require(script.Parent.Settings)

-- Style-from-config: one place to retune the panel.
-- Restrained dev-tool dark theme: near-black neutrals, subtle elevation, ONE
-- desaturated slate accent, muted semantic colors. Tuned for calm + legibility.
local Theme = {
	bg = Color3.fromRGB(17, 18, 22),
	bg2 = Color3.fromRGB(12, 13, 16),
	panel = Color3.fromRGB(24, 26, 31),
	panelHi = Color3.fromRGB(33, 36, 43),
	field = Color3.fromRGB(19, 20, 25),
	stroke = Color3.fromRGB(43, 46, 55),
	text = Color3.fromRGB(225, 227, 233),
	subtext = Color3.fromRGB(129, 134, 147),
	green = Color3.fromRGB(108, 167, 130), -- muted sage = ok
	amber = Color3.fromRGB(196, 165, 102), -- muted = partial
	red = Color3.fromRGB(196, 111, 111), -- desaturated = error/destructive
	accent = Color3.fromRGB(112, 132, 170), -- single restrained slate accent
	accent2 = Color3.fromRGB(132, 148, 184),
	idle = Color3.fromRGB(90, 95, 107),
}

local STATE_COLOR = {
	Connected = Theme.green,
	Connecting = Theme.amber,
	Disconnected = Theme.red,
}
local WORD = {
	Connected = "Connected",
	Connecting = "Connecting...",
	Disconnected = "Disconnected",
}
local AGENT_COLOR = {
	off = Theme.idle,
	armed = Theme.amber,
	active = Theme.green,
	error = Theme.red,
}

-- -- builders ---------------------------------------------------------------
local function corner(parent: Instance, radius: number): UICorner
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, radius)
	c.Parent = parent
	return c
end

local function padding(parent: Instance, top: number, right: number, bottom: number, left: number): UIPadding
	local p = Instance.new("UIPadding")
	p.PaddingTop = UDim.new(0, top)
	p.PaddingRight = UDim.new(0, right)
	p.PaddingBottom = UDim.new(0, bottom)
	p.PaddingLeft = UDim.new(0, left)
	p.Parent = parent
	return p
end

local function vlist(parent: Instance, gap: number): UIListLayout
	local l = Instance.new("UIListLayout")
	l.FillDirection = Enum.FillDirection.Vertical
	l.Padding = UDim.new(0, gap)
	l.SortOrder = Enum.SortOrder.LayoutOrder
	l.Parent = parent
	return l
end

local function hlist(parent: Instance, gap: number): UIListLayout
	local l = Instance.new("UIListLayout")
	l.FillDirection = Enum.FillDirection.Horizontal
	l.Padding = UDim.new(0, gap)
	l.VerticalAlignment = Enum.VerticalAlignment.Center
	l.SortOrder = Enum.SortOrder.LayoutOrder
	l.Parent = parent
	return l
end

local function stroke(parent: Instance, color: Color3, trans: number?): UIStroke
	local s = Instance.new("UIStroke")
	s.Color = color
	s.Transparency = trans or 0
	s.Thickness = 1
	s.Parent = parent
	return s
end

-- Subtle vertical sheen. UIGradient multiplies the background, so white->gray
-- gives a top-lit lift on any base color (survives recoloring).
local function sheen(parent: Instance, bottom: number, rotation: number?): UIGradient
	local g = Instance.new("UIGradient")
	g.Color = ColorSequence.new(Color3.new(1, 1, 1), Color3.fromRGB(bottom, bottom, bottom))
	g.Rotation = rotation or 90
	g.Parent = parent
	return g
end

-- Two-stop color gradient (opaque; root background depth).
local function gradient(parent: Instance, cTop: Color3, cBottom: Color3, rot: number?): UIGradient
	local g = Instance.new("UIGradient")
	g.Color = ColorSequence.new(cTop, cBottom)
	g.Rotation = rot or 90
	g.Parent = parent
	return g
end

-- A grouped content card: lifted panel + sheen + hairline, padded vertical stack.
local function card(parent: Instance, order: number): Frame
	local c = Instance.new("Frame")
	c.Size = UDim2.new(1, 0, 0, 0)
	c.AutomaticSize = Enum.AutomaticSize.Y
	c.BackgroundColor3 = Theme.panel
	c.BorderSizePixel = 0
	c.LayoutOrder = order
	corner(c, 10)
	stroke(c, Theme.stroke, 0.18)
	sheen(c, 244)
	padding(c, 12, 12, 12, 12)
	vlist(c, 10)
	c.Parent = parent
	return c
end

local function textConstraint(lbl: Instance, max: number, min: number?)
	local c = Instance.new("UITextSizeConstraint")
	c.MaxTextSize = max
	c.MinTextSize = min or 8
	c.Parent = lbl
	return c
end

-- A status row: dot + label, with a right-side slot for trailing controls.
local function makeRow(parent: Instance, order: number, label: string)
	local row = Instance.new("Frame")
	row.Name = label
	row.Size = UDim2.new(1, 0, 0, 26)
	row.BackgroundTransparency = 1
	row.LayoutOrder = order
	row.Parent = parent

	local dot = Instance.new("Frame")
	dot.Name = "Dot"
	dot.Size = UDim2.fromOffset(9, 9)
	dot.Position = UDim2.new(0, 1, 0.5, 0)
	dot.AnchorPoint = Vector2.new(0, 0.5)
	dot.BackgroundColor3 = Theme.idle
	corner(dot, 5)
	dot.Parent = row

	local text = Instance.new("TextLabel")
	text.Size = UDim2.new(1, -64, 1, 0)
	text.Position = UDim2.fromOffset(20, 0)
	text.BackgroundTransparency = 1
	text.Font = Enum.Font.GothamMedium
	text.Text = label
	text.TextColor3 = Theme.text
	text.TextXAlignment = Enum.TextXAlignment.Left
	text.TextYAlignment = Enum.TextYAlignment.Center
	text.TextScaled = true
	textConstraint(text, 14, 10)
	text.Parent = row

	return row, dot
end

-- color a row dot by tri-state ok
local function paintDot(dot: Frame, ok: boolean?)
	if ok == nil then
		dot.BackgroundColor3 = Theme.idle
	elseif ok then
		dot.BackgroundColor3 = Theme.green
	else
		dot.BackgroundColor3 = Theme.red
	end
end

-- A reusable on/off switch pinned to the right of its parent row. Returns the
-- clickable track plus a setter that animates to the given state.
local function makeSwitch(parent: Instance): (TextButton, (boolean) -> ())
	local track = Instance.new("TextButton")
	track.AnchorPoint = Vector2.new(1, 0.5)
	track.Position = UDim2.new(1, 0, 0.5, 0)
	track.Size = UDim2.fromOffset(38, 20)
	track.BackgroundColor3 = Theme.idle
	track.AutoButtonColor = false
	track.Text = ""
	corner(track, 10)
	track.Parent = parent

	local knob = Instance.new("Frame")
	knob.Size = UDim2.fromOffset(16, 16)
	knob.AnchorPoint = Vector2.new(0, 0.5)
	knob.Position = UDim2.new(0, 2, 0.5, 0)
	knob.BackgroundColor3 = Theme.text
	corner(knob, 8)
	knob.Parent = track

	local function set(on: boolean)
		TweenService:Create(track, TweenInfo.new(0.12), {
			BackgroundColor3 = on and Theme.green or Theme.idle,
		}):Play()
		TweenService:Create(knob, TweenInfo.new(0.12, Enum.EasingStyle.Quad), {
			Position = on and UDim2.new(1, -18, 0.5, 0) or UDim2.new(0, 2, 0.5, 0),
		}):Play()
	end
	return track, set
end

-- primary button feel: hover lighten (read from current base so it stays
-- correct after the button recolors between Connect/Disconnect) + press squash
local function wireButtonFeel(btn: TextButton)
	local scale = Instance.new("UIScale")
	scale.Parent = btn
	local function base(): Color3
		return (btn:GetAttribute("BaseColor") :: Color3) or btn.BackgroundColor3
	end
	btn.MouseEnter:Connect(function()
		TweenService:Create(btn, TweenInfo.new(0.12), {
			BackgroundColor3 = base():Lerp(Color3.new(1, 1, 1), 0.16),
		}):Play()
	end)
	btn.MouseButton1Up:Connect(function()
		TweenService:Create(btn, TweenInfo.new(0.12), { BackgroundColor3 = base() }):Play()
	end)
	btn.MouseLeave:Connect(function()
		TweenService:Create(btn, TweenInfo.new(0.12), { BackgroundColor3 = base() }):Play()
		TweenService:Create(scale, TweenInfo.new(0.08), { Scale = 1 }):Play()
	end)
	btn.MouseButton1Down:Connect(function()
		TweenService:Create(scale, TweenInfo.new(0.06), { Scale = 0.95 }):Play()
	end)
end

-- -- constructor ------------------------------------------------------------
function StatusWidget.new(plugin: Plugin)
	local self = setmetatable({}, StatusWidget)

	-- InitialEnabled=false + overrideRestore=false: start HIDDEN and respect the
	-- user's last placement (restored if saved). This stops the dock from forcing
	-- itself open on every plugin reload -- including when entering a playtest,
	-- where it used to overlay gameplay. It opens only when Nik clicks the toolbar
	-- button (StatusWidget:toggle is the only place that sets widget.Enabled).
	local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 300, 440, 240, 360)
	local widget = plugin:CreateDockWidgetPluginGui("RobloxStudioMCP_Status", info)
	widget.Title = "Nik Studio MCP"

	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = Theme.bg
	root.BorderSizePixel = 0
	gradient(root, Theme.bg, Theme.bg2, 90)
	root.Parent = widget

	-- Tab strip: Status / Settings / Activity. Body holds the three views.
	local tabBar = Instance.new("Frame")
	tabBar.Size = UDim2.new(1, 0, 0, 38)
	tabBar.BackgroundColor3 = Theme.bg
	tabBar.BorderSizePixel = 0
	tabBar.Parent = root
	padding(tabBar, 8, 8, 0, 8)
	hlist(tabBar, 6)

	local body = Instance.new("Frame")
	body.Size = UDim2.new(1, 0, 1, -38)
	body.Position = UDim2.fromOffset(0, 38)
	body.BackgroundTransparency = 1
	body.BorderSizePixel = 0
	body.Parent = root

	-- helper: a vertical scrolling view that fills the body
	local function makeView(): ScrollingFrame
		local v = Instance.new("ScrollingFrame")
		v.Size = UDim2.fromScale(1, 1)
		v.BackgroundTransparency = 1
		v.BorderSizePixel = 0
		v.ScrollBarThickness = 4
		v.ScrollBarImageColor3 = Theme.stroke
		v.CanvasSize = UDim2.new()
		v.AutomaticCanvasSize = Enum.AutomaticSize.Y
		v.CanvasPosition = Vector2.new(0, 0)
		v.Visible = false
		padding(v, 12, 12, 12, 12)
		vlist(v, 10)
		v.Parent = body
		return v
	end

	-- the Status view (existing content scrolls vertically when the dock is short)
	local scroller = makeView()
	scroller.Visible = true
	-- center compact items (the secondary Disconnect button); full-width cards,
	-- header and the Connect CTA span the width so centering is a no-op for them.
	local scrollerList = scroller:FindFirstChildOfClass("UIListLayout")
	if scrollerList then
		scrollerList.HorizontalAlignment = Enum.HorizontalAlignment.Center
	end

	-- Status tab order: header(1) -> ports(2) -> Connect button(3) -> status card(4).
	local portsCard = card(scroller, 2)
	local connCard = card(scroller, 4)
	-- ports reads as a slim strip: trim the card's vertical padding
	local pcPad = portsCard:FindFirstChildOfClass("UIPadding")
	if pcPad then
		pcPad.PaddingTop = UDim.new(0, 6)
		pcPad.PaddingBottom = UDim.new(0, 6)
	end

	-- Small serif build stamp, tucked into the top-left just under the tab strip and
	-- above the header (the empty strip in the body's top padding). Additive overlay
	-- parented to root -- not part of any UIListLayout -- so existing layout/bindings
	-- are untouched. Same muted color as the header subtitle (Theme.subtext). Keep the
	-- text in sync with package.json "version".
	local version = Instance.new("TextLabel")
	version.Name = "VersionTag"
	version.Position = UDim2.fromOffset(12, 39)
	version.Size = UDim2.fromOffset(120, 9)
	version.BackgroundTransparency = 1
	version.Font = Enum.Font.Merriweather -- readable serif at small sizes
	version.Text = "version 0.1.2"
	version.TextColor3 = Theme.subtext
	version.TextXAlignment = Enum.TextXAlignment.Left
	version.TextYAlignment = Enum.TextYAlignment.Top
	version.TextScaled = true
	textConstraint(version, 9, 7)
	version.Parent = root

	self.widget = widget
	self.connState = "Disconnected" -- the SELECTED port's state (drives pill + rows)
	self.ports = {}
	self.selectedPort = nil -- which port the Status tab shows (display only)
	self.portStates = {} -- [port] = display state; each chip shows its own
	self.armed = false
	self.soundEnabled = true
	self.settings = Settings.default()
	self.toolSwitches = {}
	self.flagSwitches = {}
	self.activityRows = {}

	-- callbacks the edit plugin assigns
	self.onPrimary = nil
	self.onAddPort = nil
	self.onRemovePort = nil
	self.onSelectPort = nil
	self.onArm = nil
	self.onToggleTool = nil
	self.onSetFlag = nil
	self.onSetAuth = nil
	-- task 26 RoCreate: dock -> init.server HTTP callbacks. init.server POSTs to the
	-- bridge routes; the widget never holds a cookie/key, only triggers and booleans.
	self.onRocreateUnlock = nil -- (password) -> "ok" | "wrong password" | error string
	self.onRocreateLock = nil -- () -> ()
	self.onRocreateSetCreds = nil -- (cookie, password) -> "ok" | error string

	-- Header: lifted gradient panel with title + subtitle and a status pill.
	local header = Instance.new("Frame")
	header.Size = UDim2.new(1, 0, 0, 60)
	header.BackgroundColor3 = Theme.panelHi
	header.BorderSizePixel = 0
	header.LayoutOrder = 1
	corner(header, 14)
	stroke(header, Theme.stroke, 0.2)
	sheen(header, 232)
	padding(header, 11, 12, 11, 14)
	header.Parent = scroller

	local title = Instance.new("TextLabel")
	title.Size = UDim2.new(1, -120, 0, 22)
	title.BackgroundTransparency = 1
	title.Font = Enum.Font.GothamBold
	title.Text = "Nik Studios MCP"
	title.TextColor3 = Theme.text
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.TextScaled = true
	textConstraint(title, 18, 12)
	title.Parent = header

	local subtitle = Instance.new("TextLabel")
	subtitle.Size = UDim2.new(1, -120, 0, 14)
	subtitle.Position = UDim2.fromOffset(0, 24)
	subtitle.BackgroundTransparency = 1
	subtitle.Font = Enum.Font.Gotham
	subtitle.Text = "Studio <-> Node bridge"
	subtitle.TextColor3 = Theme.subtext
	subtitle.TextXAlignment = Enum.TextXAlignment.Left
	subtitle.TextScaled = true
	textConstraint(subtitle, 12, 9)
	subtitle.Parent = header

	-- Status pill (the signature element): dot + word, state-tinted, pulses.
	local pill = Instance.new("Frame")
	pill.Name = "Pill"
	pill.AnchorPoint = Vector2.new(1, 0.5)
	pill.Position = UDim2.new(1, 0, 0.5, 0)
	pill.Size = UDim2.fromOffset(0, 26)
	pill.AutomaticSize = Enum.AutomaticSize.X
	pill.BackgroundColor3 = Theme.red
	pill.BackgroundTransparency = 0.82
	corner(pill, 13)
	local pillStroke = stroke(pill, Theme.red, 0.4)
	local pillPad = Instance.new("UIPadding")
	pillPad.PaddingLeft = UDim.new(0, 9)
	pillPad.PaddingRight = UDim.new(0, 11)
	pillPad.Parent = pill
	hlist(pill, 6)
	local pillScale = Instance.new("UIScale")
	pillScale.Parent = pill
	pill.Parent = header

	local pillDot = Instance.new("Frame")
	pillDot.Size = UDim2.fromOffset(8, 8)
	pillDot.BackgroundColor3 = Theme.red
	pillDot.LayoutOrder = 1
	corner(pillDot, 4)
	pillDot.Parent = pill

	local pillWord = Instance.new("TextLabel")
	pillWord.AutomaticSize = Enum.AutomaticSize.X
	pillWord.Size = UDim2.fromOffset(0, 26)
	pillWord.BackgroundTransparency = 1
	pillWord.Font = Enum.Font.GothamMedium
	pillWord.Text = WORD.Disconnected
	pillWord.TextColor3 = Theme.text
	pillWord.TextSize = 13
	pillWord.LayoutOrder = 2
	pillWord.Parent = pill

	self.pill, self.pillDot, self.pillWord, self.pillStroke, self.pillScale =
		pill, pillDot, pillWord, pillStroke, pillScale

	-- Monospace address rendered as a field-chip with a state-colored marker.
	local addr = Instance.new("Frame")
	addr.Size = UDim2.new(1, 0, 0, 32)
	addr.BackgroundColor3 = Theme.field
	addr.BorderSizePixel = 0
	addr.LayoutOrder = 1
	corner(addr, 10)
	stroke(addr, Theme.stroke, 0.3)
	padding(addr, 0, 12, 0, 12)
	addr.Parent = connCard

	local addrDot = Instance.new("Frame")
	addrDot.Size = UDim2.fromOffset(7, 7)
	addrDot.Position = UDim2.new(0, 0, 0.5, 0)
	addrDot.AnchorPoint = Vector2.new(0, 0.5)
	addrDot.BackgroundColor3 = Theme.red
	corner(addrDot, 4)
	addrDot.Parent = addr

	local address = Instance.new("TextLabel")
	address.Size = UDim2.new(1, -16, 1, 0)
	address.Position = UDim2.fromOffset(16, 0)
	address.BackgroundTransparency = 1
	address.Font = Enum.Font.Code
	address.Text = "http://127.0.0.1:---"
	address.TextColor3 = Theme.text
	address.TextXAlignment = Enum.TextXAlignment.Left
	address.TextScaled = true
	textConstraint(address, 15, 10)
	address.Parent = addr
	self.address, self.addrDot = address, addrDot

	-- Port lane: horizontally-scrolling chips + a "+" pinned outside the scroll.
	-- Slim strip: chips vertically centered, just enough room for the scrollbar.
	local lane = Instance.new("Frame")
	lane.Name = "PortLane"
	lane.Size = UDim2.new(1, 0, 0, 26)
	lane.BackgroundTransparency = 1
	lane.LayoutOrder = 1
	lane.Parent = portsCard

	local chipScroll = Instance.new("ScrollingFrame")
	chipScroll.Size = UDim2.new(1, -38, 1, 0) -- room on the right for "+"; the editor overlays on top
	chipScroll.BackgroundTransparency = 1
	chipScroll.BorderSizePixel = 0
	chipScroll.ScrollingDirection = Enum.ScrollingDirection.X
	chipScroll.AutomaticCanvasSize = Enum.AutomaticSize.X
	chipScroll.CanvasSize = UDim2.new()
	chipScroll.ScrollBarThickness = 3
	chipScroll.ScrollBarImageColor3 = Theme.stroke
	chipScroll.ScrollBarImageTransparency = 0.2
	chipScroll.Parent = lane
	local chipLayout = hlist(chipScroll, 6)
	chipLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	local chipPad = Instance.new("UIPadding")
	chipPad.PaddingBottom = UDim.new(0, 4) -- room for the bottom scrollbar
	chipPad.Parent = chipScroll
	self.chipScroll = chipScroll

	-- "+" add control, pinned to the right of the lane (outside the scroll).
	local add = Instance.new("TextButton")
	add.Name = "AddPort"
	add.AnchorPoint = Vector2.new(1, 0.5)
	add.Position = UDim2.new(1, 0, 0.5, 0)
	add.Size = UDim2.fromOffset(32, 22)
	add.BackgroundColor3 = Theme.panel
	add.AutoButtonColor = false
	add.Text = "+"
	add.Font = Enum.Font.GothamBold
	add.TextColor3 = Theme.text
	add.TextScaled = true
	corner(add, 8)
	stroke(add, Theme.stroke, 0.1)
	textConstraint(add, 18, 12)
	add.Parent = lane

	self.dir = "up" -- persisted "+" suggestion direction (default; init pushes saved value)
	self.defaultPort = 58741 -- overridden by init (Config.DEFAULT_PORT)

	-- ONE reusable inline port editor (hidden by default), shared by the "+" flow
	-- (adds a port) and the chip-click flow (edits a port in place). Overlays the
	-- right of the chip lane, just left of "+". The ^/v steppers live INSIDE here,
	-- so the arrows are only visible while an editor is open.
	local editor = Instance.new("Frame")
	editor.Name = "PortEditor"
	editor.AnchorPoint = Vector2.new(1, 0.5)
	editor.Position = UDim2.new(1, -38, 0.5, 0)
	editor.Size = UDim2.fromOffset(96, 22)
	editor.BackgroundTransparency = 1
	editor.Visible = false
	editor.ZIndex = 10
	editor.Parent = lane
	self.editor = editor
	self.overStepper = nil -- "up" | "down" while the mouse hovers a stepper

	local editBox = Instance.new("TextBox")
	editBox.Size = UDim2.new(1, -22, 1, 0)
	editBox.BackgroundColor3 = Theme.field
	editBox.Text = ""
	editBox.PlaceholderText = "port"
	editBox.Font = Enum.Font.Code
	editBox.TextColor3 = Theme.text
	editBox.PlaceholderColor3 = Theme.subtext
	editBox.TextScaled = true
	editBox.ClearTextOnFocus = false
	editBox.ZIndex = 10
	corner(editBox, 8)
	stroke(editBox, Theme.accent, 0.1)
	textConstraint(editBox, 14, 10)
	editBox.Parent = editor
	self.editBox = editBox

	-- stepper: stacked ^/v that adjust the number being edited (skip taken, clamp)
	local stepper = Instance.new("Frame")
	stepper.AnchorPoint = Vector2.new(1, 0)
	stepper.Position = UDim2.new(1, 0, 0, 0)
	stepper.Size = UDim2.new(0, 20, 1, 0)
	stepper.BackgroundColor3 = Theme.panel
	stepper.BorderSizePixel = 0
	stepper.ZIndex = 10
	corner(stepper, 8)
	stroke(stepper, Theme.stroke, 0.1)
	stepper.Parent = editor

	local function stepBtn(glyph: string, dir: string, top: boolean): TextButton
		local b = Instance.new("TextButton")
		b.Size = UDim2.new(1, 0, 0, 12)
		b.Position = top and UDim2.new(0, 0, 0, 1) or UDim2.new(0, 0, 1, -13)
		b.BackgroundTransparency = 1
		b.Text = glyph
		b.Font = Enum.Font.GothamBold
		b.TextColor3 = Theme.subtext
		b.TextSize = 11
		b.AutoButtonColor = false
		b.ZIndex = 11
		b.Parent = stepper
		-- The actual step is done in editBox.FocusLost (we know which stepper the
		-- mouse is over), so clicking a stepper never cancels the editor.
		b.MouseEnter:Connect(function()
			self.overStepper = dir
			b.TextColor3 = Theme.accent
		end)
		b.MouseLeave:Connect(function()
			self.overStepper = nil
			b.TextColor3 = Theme.subtext
		end)
		return b
	end
	stepBtn("^", "up", true)
	stepBtn("v", "down", false)

	editBox.FocusLost:Connect(function(enterPressed)
		if enterPressed then
			self:_commitEditor()
		elseif self.overStepper then
			-- focus was lost because the user pressed a stepper: step + keep editing
			self:_step(self.overStepper)
			editBox:CaptureFocus()
			editBox.CursorPosition = #editBox.Text + 1
		else
			self:_cancelEditor() -- Esc or clicked away
		end
	end)

	add.MouseEnter:Connect(function()
		TweenService:Create(add, TweenInfo.new(0.1), { BackgroundColor3 = Theme.panelHi }):Play()
	end)
	add.MouseLeave:Connect(function()
		TweenService:Create(add, TweenInfo.new(0.1), { BackgroundColor3 = Theme.panel }):Play()
	end)
	add.MouseButton1Click:Connect(function()
		self:_click()
		if self.editor.Visible then
			self:_cancelEditor() -- toggle the add editor off
			return
		end
		self:_openEditor(self:_suggestPort())
	end)

	-- thin divider
	local divider = Instance.new("Frame")
	divider.Size = UDim2.new(1, 0, 0, 1)
	divider.BackgroundColor3 = Theme.stroke
	divider.BackgroundTransparency = 0.3
	divider.BorderSizePixel = 0
	divider.LayoutOrder = 2
	divider.Parent = connCard

	-- status rows
	local rows = Instance.new("Frame")
	rows.Size = UDim2.new(1, 0, 0, 116)
	rows.BackgroundTransparency = 1
	rows.LayoutOrder = 3
	vlist(rows, 4)
	rows.Parent = connCard

	local _httpRow, httpDot = makeRow(rows, 1, "HTTP server")
	local _mcpRow, mcpDot = makeRow(rows, 2, "MCP bridge")
	local _cmdRow, cmdDot = makeRow(rows, 3, "Commands")
	local agentRow, agentDot = makeRow(rows, 4, "Playtest agent")
	self.httpDot, self.mcpDot, self.cmdDot, self.agentDot = httpDot, mcpDot, cmdDot, agentDot
	paintDot(httpDot, false)
	paintDot(mcpDot, nil)
	paintDot(cmdDot, nil)
	agentDot.BackgroundColor3 = Theme.idle

	-- arm toggle switch on the Playtest agent row
	local track = Instance.new("TextButton")
	track.Name = "ArmToggle"
	track.AnchorPoint = Vector2.new(1, 0.5)
	track.Position = UDim2.new(1, 0, 0.5, 0)
	track.Size = UDim2.fromOffset(38, 20)
	track.BackgroundColor3 = Theme.idle
	track.AutoButtonColor = false
	track.Text = ""
	corner(track, 10)
	track.Parent = agentRow

	local knob = Instance.new("Frame")
	knob.Size = UDim2.fromOffset(16, 16)
	knob.AnchorPoint = Vector2.new(0, 0.5)
	knob.Position = UDim2.new(0, 2, 0.5, 0)
	knob.BackgroundColor3 = Theme.text
	corner(knob, 8)
	knob.Parent = track
	self.armTrack, self.armKnob = track, knob
	track.MouseButton1Click:Connect(function()
		self:_click()
		if self.onArm then
			self.onArm()
		end
	end)

	-- Primary Connect/Disconnect button (sheened, hover-lighten, press-squash).
	local primary = Instance.new("TextButton")
	primary.Size = UDim2.new(1, 0, 0, 36)
	primary.BackgroundColor3 = Theme.accent
	primary.TextColor3 = Color3.new(1, 1, 1)
	primary.Font = Enum.Font.GothamBold
	primary.Text = "Connect"
	primary.TextScaled = true
	primary.AutoButtonColor = false
	primary.LayoutOrder = 3 -- directly under the ports card
	primary:SetAttribute("BaseColor", Theme.accent)
	corner(primary, 11)
	sheen(primary, 205)
	textConstraint(primary, 18, 13)
	primary.Parent = scroller
	self.primary = primary
	wireButtonFeel(primary)
	primary.MouseButton1Click:Connect(function()
		self:_click()
		if self.onPrimary then
			self.onPrimary()
		end
	end)

	-- Settings + Activity + RoCreate views and the tab strip that switches between them.
	local settingsView = makeView()
	local activityView = makeView()
	local rocreateView = makeView()
	self.settingsView = settingsView
	self.activityView = activityView
	self.rocreateView = rocreateView
	self.views = { Status = scroller, Settings = settingsView, Activity = activityView, RoCreate = rocreateView }
	self:_buildSettings(settingsView)
	self:_buildActivity(activityView)
	self:_buildRoCreate(rocreateView)

	self.tabs = {}
	-- 4 tabs now; narrower footprint so the strip still fits the dock width.
	for i, name in ipairs({ "Status", "Settings", "Activity", "RoCreate" }) do
		local tab = Instance.new("TextButton")
		tab.Name = name
		tab.Size = UDim2.fromOffset(66, 24)
		tab.BackgroundColor3 = Theme.panel
		tab.AutoButtonColor = false
		tab.Text = name
		tab.Font = Enum.Font.GothamMedium
		tab.TextColor3 = Theme.subtext
		tab.TextScaled = true
		tab.LayoutOrder = i
		corner(tab, 8)
		textConstraint(tab, 13, 10)
		tab.Parent = tabBar
		self.tabs[name] = tab
		tab.MouseButton1Click:Connect(function()
			self:_click()
			self:_showTab(name)
		end)
	end
	self:_showTab("Status")

	self:_applyConnectionState("Disconnected")
	return self
end

-- -- tab switching ----------------------------------------------------------
function StatusWidget:_showTab(name: string)
	for tabName, view in pairs(self.views) do
		view.Visible = tabName == name
		local tab = self.tabs[tabName]
		local active = tabName == name
		-- subtle selected state: lifted panel + bright text vs recessed + muted
		tab.BackgroundColor3 = active and Theme.panelHi or Theme.bg2
		tab.TextColor3 = active and Theme.text or Theme.subtext
	end
end

-- -- port chips -------------------------------------------------------------
-- Live-state color for the connected chip's fill (idle/connecting/connected).
local function connColor(state: string): Color3
	if state == "Connected" then
		return Theme.green
	elseif state == "Connecting" then
		return Theme.amber
	elseif state == "Error" then
		return Theme.red
	end
	return Theme.idle
end

function StatusWidget:_rebuildChips()
	for _, child in ipairs(self.chipScroll:GetChildren()) do
		if child:IsA("TextButton") then
			child:Destroy()
		end
	end

	local order = 1
	for _, port in ipairs(self.ports) do
		local isSelected = port == self.selectedPort
		-- each chip shows ITS OWN connection state (many can be green at once)
		local pState = self.portStates[port] or "Disconnected"
		local colored = pState == "Connected" or pState == "Connecting" or pState == "Error"
		local bg = colored and connColor(pState) or Theme.panel
		local fg = colored and Theme.bg or Theme.text

		local chip = Instance.new("TextButton")
		chip.Name = "Port" .. tostring(port)
		-- ponytail: fixed chip footprint (tiny element); AutomaticSize.X with a
		-- Scale-width child inside an X-scroll is a layout-feedback footgun.
		chip.Size = UDim2.fromOffset(84, 22)
		chip.BackgroundColor3 = bg
		chip.AutoButtonColor = false
		chip.Text = ""
		chip.LayoutOrder = order
		order += 1
		corner(chip, 8)
		-- selected chip outlined in accent; others a hairline
		stroke(chip, isSelected and Theme.accent or Theme.stroke, isSelected and 0 or 0.2)
		chip.Parent = self.chipScroll

		local lbl = Instance.new("TextLabel")
		lbl.BackgroundTransparency = 1
		lbl.Font = Enum.Font.Code
		lbl.Text = ":" .. tostring(port)
		lbl.TextColor3 = fg
		lbl.TextXAlignment = Enum.TextXAlignment.Left
		lbl.Size = UDim2.new(1, -24, 1, 0)
		lbl.Position = UDim2.fromOffset(9, 0)
		lbl.TextScaled = true
		textConstraint(lbl, 13, 10)
		lbl.Parent = chip

		-- hover lighten on plain (not-colored) chips only
		if not colored then
			chip.MouseEnter:Connect(function()
				TweenService:Create(chip, TweenInfo.new(0.1), { BackgroundColor3 = Theme.panelHi }):Play()
			end)
			chip.MouseLeave:Connect(function()
				TweenService:Create(chip, TweenInfo.new(0.1), { BackgroundColor3 = Theme.panel }):Play()
			end)
		end

		-- clicking the chip body selects this port (never auto-connects)
		chip.MouseButton1Click:Connect(function()
			self:_click()
			if self.onSelectPort then
				self.onSelectPort(port)
			end
		end)

		local x = Instance.new("TextButton")
		x.Name = "Remove"
		x.Size = UDim2.fromOffset(18, 18)
		x.Position = UDim2.new(1, -4, 0.5, 0)
		x.AnchorPoint = Vector2.new(1, 0.5)
		x.ZIndex = 2 -- above the chip body so "x" removes instead of selecting
		x.BackgroundTransparency = 1
		x.Text = "x"
		x.Font = Enum.Font.GothamBold
		x.TextColor3 = colored and fg or Theme.subtext
		x.TextScaled = true
		textConstraint(x, 14, 9)
		x.Parent = chip
		x.MouseButton1Click:Connect(function()
			self:_click()
			if self.onRemovePort then
				self.onRemovePort(port)
			end
		end)
	end
end

-- -- port editor (shared by "+" add and chip-click edit) --------------------
-- init pushes the persisted "+" suggestion direction at startup.
function StatusWidget:setDirection(dir: string)
	self.dir = (dir == "down") and "down" or "up"
end

function StatusWidget:_openEditor(prefill: number?)
	self.editBox.Text = prefill and tostring(prefill) or ""
	self.editor.Visible = true
	self.editBox:CaptureFocus()
	self.editBox.CursorPosition = #self.editBox.Text + 1
end

function StatusWidget:_closeEditor()
	self.overStepper = nil
	self.editor.Visible = false
end

function StatusWidget:_cancelEditor()
	self:_closeEditor()
end

-- commit the (edited) value: add a new port.
function StatusWidget:_commitEditor()
	local raw = self.editBox.Text
	self:_closeEditor()
	local n = tonumber(raw)
	if not (n and n == math.floor(n) and n >= 1 and n <= 65535) then
		return -- out of range / non-integer: ignore
	end
	if self.onAddPort then
		self.onAddPort(n)
	end
end

-- step the number being edited by 1, skipping taken ports, clamped 1..65535
function StatusWidget:_step(dir: string)
	local cur = tonumber(self.editBox.Text) or self.defaultPort or 1
	cur = math.floor(cur)
	local taken = {}
	for _, p in ipairs(self.ports) do
		taken[p] = true
	end
	local n = cur
	if dir == "up" then
		n += 1
		while n <= 65535 and taken[n] do
			n += 1
		end
		if n > 65535 then
			return
		end
	else
		n -= 1
		while n >= 1 and taken[n] do
			n -= 1
		end
		if n < 1 then
			return
		end
	end
	self.editBox.Text = tostring(n)
end

-- Next free port for the current direction, clamped to 1..65535. nil if none.
function StatusWidget:_suggestPort(): number?
	local ports = self.ports
	if #ports == 0 then
		return self.defaultPort
	end
	local taken = {}
	local lo, hi = ports[1], ports[1]
	for _, p in ipairs(ports) do
		taken[p] = true
		if p < lo then
			lo = p
		end
		if p > hi then
			hi = p
		end
	end
	if self.dir == "down" then
		local c = lo - 1
		while c >= 1 do
			if not taken[c] then
				return c
			end
			c -= 1
		end
		return nil
	end
	local c = hi + 1
	while c <= 65535 do
		if not taken[c] then
			return c
		end
		c += 1
	end
	return nil
end

-- -- settings view ----------------------------------------------------------
-- a single labeled row with a switch on the right; returns the switch setter
function StatusWidget:_settingsRow(parent: Instance, order: number, label: string, initial: boolean, onChange: (boolean) -> ()): (boolean) -> ()
	local row = Instance.new("Frame")
	row.Size = UDim2.new(1, 0, 0, 28)
	row.BackgroundTransparency = 1
	row.LayoutOrder = order
	row.Parent = parent

	local lbl = Instance.new("TextLabel")
	lbl.Size = UDim2.new(1, -50, 1, 0)
	lbl.BackgroundTransparency = 1
	lbl.Font = Enum.Font.Gotham
	lbl.Text = label
	lbl.TextColor3 = Theme.text
	lbl.TextXAlignment = Enum.TextXAlignment.Left
	lbl.TextScaled = true
	textConstraint(lbl, 13, 9)
	lbl.Parent = row

	local track, set = makeSwitch(row)
	local state = initial
	set(state)
	track.MouseButton1Click:Connect(function()
		self:_click()
		state = not state
		set(state)
		onChange(state)
	end)
	return set
end

function StatusWidget:_sectionHeader(parent: Instance, order: number, text: string)
	local h = Instance.new("TextLabel")
	h.Size = UDim2.new(1, 0, 0, 20)
	h.BackgroundTransparency = 1
	h.Font = Enum.Font.GothamBold
	h.Text = text
	h.TextColor3 = Theme.subtext
	h.TextXAlignment = Enum.TextXAlignment.Left
	h.TextScaled = true
	h.LayoutOrder = order
	textConstraint(h, 13, 10)
	h.Parent = parent
end

function StatusWidget:_buildSettings(view: ScrollingFrame)
	local order = 0
	local function nextOrder(): number
		order += 1
		return order
	end

	-- Tools grouped under Read / Write / Experimental
	for _, group in ipairs(Settings.GROUPS) do
		self:_sectionHeader(view, nextOrder(), group.label)
		for _, tool in ipairs(Settings.TOOLS) do
			if tool.group == group.key then
				local name = tool.name
				local setter = self:_settingsRow(view, nextOrder(), tool.label, true, function(on)
					self.settings.tools[name] = on
					if self.onToggleTool then
						self.onToggleTool(name, on)
					end
				end)
				self.toolSwitches[name] = setter
			end
		end
	end

	-- Misc flags
	self:_sectionHeader(view, nextOrder(), "Misc")
	local FLAGS = {
		{ key = "readOnly", label = "Read-only mode (block writes)" },
		{ key = "confirmDestructive", label = "Confirm destructive (stub)" },
		{ key = "soundEnabled", label = "Sound" },
		{ key = "activityLog", label = "Activity log" },
		{ key = "playtestAutoStop", label = "Auto-stop abandoned playtests" },
	}
	for _, f in ipairs(FLAGS) do
		local key = f.key
		local setter = self:_settingsRow(view, nextOrder(), f.label, true, function(on)
			self.settings[key] = on
			if key == "soundEnabled" then
				self.soundEnabled = on
			end
			if self.onSetFlag then
				self.onSetFlag(key, on)
			end
		end)
		self.flagSwitches[key] = setter
	end

	-- Playtest auto-stop thresholds (seconds). Pairs with the toggle above.
	self:_sectionHeader(view, nextOrder(), "Playtest auto-stop (seconds)")
	self.numberFields = {}
	local function numberField(labelText: string, key: string)
		local row = Instance.new("Frame")
		row.Size = UDim2.new(1, 0, 0, 28)
		row.BackgroundTransparency = 1
		row.LayoutOrder = nextOrder()
		row.Parent = view
		local lbl = Instance.new("TextLabel")
		lbl.Size = UDim2.new(1, -76, 1, 0)
		lbl.BackgroundTransparency = 1
		lbl.Font = Enum.Font.Gotham
		lbl.Text = labelText
		lbl.TextColor3 = Theme.text
		lbl.TextXAlignment = Enum.TextXAlignment.Left
		lbl.TextScaled = true
		textConstraint(lbl, 13, 9)
		lbl.Parent = row
		local box = Instance.new("TextBox")
		box.AnchorPoint = Vector2.new(1, 0.5)
		box.Position = UDim2.new(1, 0, 0.5, 0)
		box.Size = UDim2.new(0, 64, 0, 24)
		box.BackgroundColor3 = Theme.field
		box.Font = Enum.Font.Code
		box.TextColor3 = Theme.text
		box.TextScaled = true
		box.ClearTextOnFocus = false
		box.Text = tostring(self.settings[key] or "")
		corner(box, 6)
		stroke(box, Theme.stroke, 0.2)
		textConstraint(box, 13, 9)
		box.Parent = row
		box.FocusLost:Connect(function()
			local n = tonumber(box.Text)
			if n and n > 0 then
				n = math.floor(n)
				self.settings[key] = n
				box.Text = tostring(n)
				if self.onSetNumber then
					self.onSetNumber(key, n)
				end
			else
				box.Text = tostring(self.settings[key] or "")
			end
		end)
		self.numberFields[key] = box
	end
	numberField("Max run time", "playtestMaxSeconds")
	numberField("Idle timeout", "playtestIdleSeconds")

	-- Auth: enable switch + token field (TOFU; off by default)
	self:_sectionHeader(view, nextOrder(), "Auth (optional, TOFU)")
	local authRow = Instance.new("Frame")
	authRow.Size = UDim2.new(1, 0, 0, 28)
	authRow.BackgroundTransparency = 1
	authRow.LayoutOrder = nextOrder()
	authRow.Parent = view
	local authLbl = Instance.new("TextLabel")
	authLbl.Size = UDim2.new(1, -50, 1, 0)
	authLbl.BackgroundTransparency = 1
	authLbl.Font = Enum.Font.Gotham
	authLbl.Text = "Require token"
	authLbl.TextColor3 = Theme.text
	authLbl.TextXAlignment = Enum.TextXAlignment.Left
	authLbl.TextScaled = true
	textConstraint(authLbl, 13, 9)
	authLbl.Parent = authRow
	local authTrack, authSet = makeSwitch(authRow)
	authSet(false)
	self.authSwitch = authSet

	local tokenBox = Instance.new("TextBox")
	tokenBox.Size = UDim2.new(1, 0, 0, 28)
	tokenBox.BackgroundColor3 = Theme.field
	tokenBox.Text = ""
	tokenBox.PlaceholderText = "token (e.g. a random string)"
	tokenBox.Font = Enum.Font.Code
	tokenBox.TextColor3 = Theme.text
	tokenBox.PlaceholderColor3 = Theme.subtext
	tokenBox.TextScaled = true
	tokenBox.ClearTextOnFocus = false
	tokenBox.LayoutOrder = nextOrder()
	corner(tokenBox, 8)
	stroke(tokenBox, Theme.stroke, 0.2)
	textConstraint(tokenBox, 13, 9)
	tokenBox.Parent = view
	self.tokenBox = tokenBox

	local authEnabled = false
	local function pushAuth()
		if self.onSetAuth then
			self.onSetAuth(authEnabled, tokenBox.Text)
		end
	end
	authTrack.MouseButton1Click:Connect(function()
		self:_click()
		authEnabled = not authEnabled
		authSet(authEnabled)
		self.settings.auth.enabled = authEnabled
		pushAuth()
	end)
	tokenBox.FocusLost:Connect(function()
		self.settings.auth.token = tokenBox.Text
		pushAuth()
	end)
end

-- -- RoCreate view -----------------------------------------------------------
-- Locked by default: a password unlocks the encrypted cookie in Node (memory only).
-- The widget holds NO secrets -- it triggers bridge routes and shows booleans.
function StatusWidget:_buildRoCreate(view: ScrollingFrame)
	local order = 0
	local function nextOrder(): number
		order += 1
		return order
	end

	local title = Instance.new("TextLabel")
	title.Size = UDim2.new(1, 0, 0, 20)
	title.BackgroundTransparency = 1
	title.Font = Enum.Font.GothamBold
	title.Text = "RoCreate"
	title.TextColor3 = Theme.text
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.TextScaled = true
	title.LayoutOrder = nextOrder()
	textConstraint(title, 15, 11)
	title.Parent = view

	local hint = Instance.new("TextLabel")
	hint.Size = UDim2.new(1, 0, 0, 26)
	hint.BackgroundTransparency = 1
	hint.Font = Enum.Font.Gotham
	hint.Text = "Password-gated reupload. The cookie is encrypted on disk; the password is never stored."
	hint.TextColor3 = Theme.subtext
	hint.TextXAlignment = Enum.TextXAlignment.Left
	hint.TextWrapped = true
	hint.TextScaled = true
	hint.LayoutOrder = nextOrder()
	textConstraint(hint, 11, 9)
	hint.Parent = view

	-- status line (unlocked / hasKey / hasCookie); refreshed by _setRocreateStatus
	local status = Instance.new("TextLabel")
	status.Size = UDim2.new(1, 0, 0, 18)
	status.BackgroundTransparency = 1
	status.Font = Enum.Font.Code
	status.Text = "status: locked"
	status.TextColor3 = Theme.amber
	status.TextXAlignment = Enum.TextXAlignment.Left
	status.TextScaled = true
	status.LayoutOrder = nextOrder()
	textConstraint(status, 12, 9)
	status.Parent = view
	self.rcStatusLabel = status

	local result = Instance.new("TextLabel")
	result.Size = UDim2.new(1, 0, 0, 18)
	result.BackgroundTransparency = 1
	result.Font = Enum.Font.Gotham
	result.Text = ""
	result.TextColor3 = Theme.subtext
	result.TextXAlignment = Enum.TextXAlignment.Left
	result.TextScaled = true
	result.LayoutOrder = 999
	textConstraint(result, 11, 9)
	result.Parent = view
	self.rcResultLabel = result

	local function makeBox(placeholder: string, mask: boolean): TextBox
		local box = Instance.new("TextBox")
		box.Size = UDim2.new(1, 0, 0, 28)
		box.BackgroundColor3 = Theme.field
		box.Text = ""
		box.PlaceholderText = placeholder
		box.Font = Enum.Font.Code
		box.TextColor3 = Theme.text
		box.PlaceholderColor3 = Theme.subtext
		box.TextScaled = true
		box.ClearTextOnFocus = false
		box.LayoutOrder = nextOrder()
		corner(box, 8)
		stroke(box, Theme.stroke, 0.2)
		textConstraint(box, 13, 9)
		box.Parent = view
		return box
	end

	local function makeBtn(text: string, fill: Color3): TextButton
		local btn = Instance.new("TextButton")
		btn.Size = UDim2.new(0.5, -4, 0, 30)
		btn.BackgroundColor3 = fill
		btn.AutoButtonColor = true
		btn.Text = text
		btn.Font = Enum.Font.GothamMedium
		btn.TextColor3 = Theme.bg
		btn.TextScaled = true
		corner(btn, 8)
		textConstraint(btn, 13, 10)
		return btn
	end

	-- Unlock row: password + Unlock / Lock
	local pwBox = makeBox("password (unlock)", true)

	local btnRow = Instance.new("Frame")
	btnRow.Size = UDim2.new(1, 0, 0, 30)
	btnRow.BackgroundTransparency = 1
	btnRow.LayoutOrder = nextOrder()
	hlist(btnRow, 8)
	btnRow.Parent = view

	local unlockBtn = makeBtn("Unlock", Theme.green)
	unlockBtn.Parent = btnRow
	local lockBtn = makeBtn("Lock", Theme.panelHi)
	lockBtn.TextColor3 = Theme.text
	lockBtn.Parent = btnRow

	unlockBtn.MouseButton1Click:Connect(function()
		self:_click()
		if self.onRocreateUnlock then
			local res = self.onRocreateUnlock(pwBox.Text)
			pwBox.Text = ""
			self:_setRocreateResult(res)
		end
	end)
	lockBtn.MouseButton1Click:Connect(function()
		self:_click()
		if self.onRocreateLock then
			self.onRocreateLock()
		end
		self:_setRocreateStatus({ unlocked = false })
		self:_setRocreateResult("locked")
	end)

	-- Set-credentials section (collapsible-ish; always shown, compact)
	local credHeader = Instance.new("TextLabel")
	credHeader.Size = UDim2.new(1, 0, 0, 18)
	credHeader.BackgroundTransparency = 1
	credHeader.Font = Enum.Font.GothamBold
	credHeader.Text = "Set credentials (one time)"
	credHeader.TextColor3 = Theme.subtext
	credHeader.TextXAlignment = Enum.TextXAlignment.Left
	credHeader.TextScaled = true
	credHeader.LayoutOrder = nextOrder()
	textConstraint(credHeader, 12, 9)
	credHeader.Parent = view

	local cookieBox = makeBox("paste .ROBLOSECURITY cookie", false)
	local credPwBox = makeBox("password to encrypt it with", true)
	local saveBtn = makeBtn("Save credentials", Theme.accent)
	saveBtn.Size = UDim2.new(1, 0, 0, 30)
	saveBtn.LayoutOrder = nextOrder()
	saveBtn.Parent = view
	saveBtn.MouseButton1Click:Connect(function()
		self:_click()
		if self.onRocreateSetCreds then
			local res = self.onRocreateSetCreds(cookieBox.Text, credPwBox.Text)
			cookieBox.Text = ""
			credPwBox.Text = ""
			self:_setRocreateResult(res)
		end
	end)
end

-- Refresh the status line from booleans (values never leave Node; these are flags).
function StatusWidget:_setRocreateStatus(s: any)
	if not self.rcStatusLabel then
		return
	end
	local unlocked = s and s.unlocked == true
	local parts = { unlocked and "unlocked" or "locked" }
	if s and s.hasKey ~= nil then
		table.insert(parts, "key:" .. (s.hasKey and "yes" or "no"))
	end
	if s and s.hasCookie ~= nil then
		table.insert(parts, "cookie:" .. (s.hasCookie and "yes" or "no"))
	end
	if s and s.cookieExpired == true then
		table.insert(parts, "COOKIE EXPIRED - re-enter")
	end
	self.rcStatusLabel.Text = "status: " .. table.concat(parts, "  ")
	self.rcStatusLabel.TextColor3 = unlocked and Theme.green or Theme.amber
end

function StatusWidget:_setRocreateResult(text: string?)
	if self.rcResultLabel then
		self.rcResultLabel.Text = text or ""
	end
end

-- -- activity view ----------------------------------------------------------
function StatusWidget:_buildActivity(view: ScrollingFrame)
	local header = Instance.new("TextLabel")
	header.Name = "ActivityHeader"
	header.Size = UDim2.new(1, 0, 0, 18)
	header.BackgroundTransparency = 1
	header.Font = Enum.Font.GothamBold
	header.Text = "Recent commands"
	header.TextColor3 = Theme.subtext
	header.TextXAlignment = Enum.TextXAlignment.Left
	header.TextScaled = true
	header.LayoutOrder = -1000000 -- stay on top; rows sort newest-first below it
	textConstraint(header, 13, 10)
	header.Parent = view
	self.activityHeader = header
	self.activityList = view
	self.activitySeq = 0
end

-- entry = { tool, target, ok, ms, time }
function StatusWidget:addActivity(entry: any)
	local view = self.activityList
	if not view then
		return
	end
	self.activitySeq += 1

	local row = Instance.new("Frame")
	row.Size = UDim2.new(1, 0, 0, 30)
	row.BackgroundColor3 = Theme.panel
	row.BorderSizePixel = 0
	-- newest on top: header is LayoutOrder 0, rows use decreasing negative order
	row.LayoutOrder = -self.activitySeq
	corner(row, 6)
	stroke(row, Theme.stroke, 0.4)
	padding(row, 0, 8, 0, 8)
	row.Parent = view

	local dot = Instance.new("Frame")
	dot.Size = UDim2.fromOffset(7, 7)
	dot.Position = UDim2.new(0, 0, 0.5, 0)
	dot.AnchorPoint = Vector2.new(0, 0.5)
	dot.BackgroundColor3 = entry.ok and Theme.green or Theme.red
	corner(dot, 4)
	dot.Parent = row

	local name = Instance.new("TextLabel")
	name.Size = UDim2.new(1, -64, 0, 16)
	name.Position = UDim2.fromOffset(14, 2)
	name.BackgroundTransparency = 1
	name.Font = Enum.Font.Code
	name.Text = tostring(entry.tool)
	name.TextColor3 = Theme.text
	name.TextXAlignment = Enum.TextXAlignment.Left
	name.TextScaled = true
	textConstraint(name, 12, 9)
	name.Parent = row

	local target = Instance.new("TextLabel")
	target.Size = UDim2.new(1, -64, 0, 11)
	target.Position = UDim2.fromOffset(14, 18)
	target.BackgroundTransparency = 1
	target.Font = Enum.Font.Gotham
	local stamp = ""
	pcall(function()
		stamp = os.date("%H:%M:%S", entry.time) :: string
	end)
	target.Text = (stamp ~= "" and (stamp .. "  ") or "") .. tostring(entry.target or "")
	target.TextColor3 = Theme.subtext
	target.TextXAlignment = Enum.TextXAlignment.Left
	target.TextScaled = true
	textConstraint(target, 10, 8)
	target.Parent = row

	local ms = Instance.new("TextLabel")
	ms.Size = UDim2.fromOffset(50, 16)
	ms.AnchorPoint = Vector2.new(1, 0.5)
	ms.Position = UDim2.new(1, 0, 0.5, 0)
	ms.BackgroundTransparency = 1
	ms.Font = Enum.Font.Code
	ms.Text = (entry.ms and (tostring(entry.ms) .. "ms")) or ""
	ms.TextColor3 = entry.ok and Theme.green or Theme.red
	ms.TextXAlignment = Enum.TextXAlignment.Right
	ms.TextScaled = true
	textConstraint(ms, 11, 8)
	ms.Parent = row

	table.insert(self.activityRows, row)
	-- cap at ~50 rows; drop the oldest
	if #self.activityRows > 50 then
		local oldest = table.remove(self.activityRows, 1)
		oldest:Destroy()
	end
end

-- -- sound ------------------------------------------------------------------
function StatusWidget:_click()
	if not self.soundEnabled then
		return
	end
	local sound = self._sound
	if not sound then
		sound = Instance.new("Sound")
		sound.SoundId = "rbxassetid://9112824440"
		sound.Volume = 0.4
		sound.Parent = SoundService
		self._sound = sound
	end
	pcall(function()
		SoundService:PlayLocalSound(sound)
	end)
end

-- pulse the status pill on a connection state change
function StatusWidget:_pulse()
	local scale = self.pillScale
	local up = TweenService:Create(scale, TweenInfo.new(0.12, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Scale = 1.08 })
	local down = TweenService:Create(scale, TweenInfo.new(0.18), { Scale = 1 })
	up:Play()
	up.Completed:Once(function()
		down:Play()
	end)
end

-- -- public API -------------------------------------------------------------
function StatusWidget:_applyConnectionState(state: string)
	self.connState = state
	local color = STATE_COLOR[state] or Theme.idle
	self.pill.BackgroundColor3 = color
	self.pillStroke.Color = color
	self.pillDot.BackgroundColor3 = color
	self.pillWord.Text = WORD[state] or state
	self.addrDot.BackgroundColor3 = connColor(state) -- gray idle / amber / green
	-- Disconnect is offered whenever a connection is up or being attempted.
	local live = state == "Connected" or state == "Connecting"
	if live then
		-- compact, muted secondary: dark chip + red text (destructive, restrained),
		-- centered by the scroller's list layout -- NOT a full-width red block.
		self.primary.Text = "Disconnect"
		self.primary.Size = UDim2.fromOffset(128, 28)
		self.primary.BackgroundColor3 = Theme.panel
		self.primary.TextColor3 = Theme.red
		self.primary:SetAttribute("BaseColor", Theme.panel)
	else
		-- prominent primary CTA: full-width accent
		self.primary.Text = "Connect"
		self.primary.Size = UDim2.new(1, 0, 0, 36)
		self.primary.BackgroundColor3 = Theme.accent
		self.primary.TextColor3 = Color3.new(1, 1, 1)
		self.primary:SetAttribute("BaseColor", Theme.accent)
	end
	self:_rebuildChips() -- recolor the connected chip to match the new state
end

function StatusWidget:setConnectionState(state: string)
	local changed = self.connState ~= state
	self:_applyConnectionState(state)
	if changed then
		self:_pulse()
		if state == "Connected" then
			self:_click()
		end
	end
end

-- The selected port drives the address line + the accent chip outline.
function StatusWidget:setSelectedPort(port: number?)
	self.selectedPort = port
	if port then
		self.address.Text = ("http://127.0.0.1:%d"):format(port)
	else
		self.address.Text = "http://127.0.0.1:---"
	end
	self:_rebuildChips()
end

-- Per-port connection states { [port] = "Connected"|"Connecting"|"Disconnected"|"Error" }.
-- Each chip is filled from its own entry, so several can be green at once.
function StatusWidget:setPortStates(states: { [number]: string })
	self.portStates = states or {}
	self:_rebuildChips()
end

function StatusWidget:refreshPorts(ports: { number })
	self.ports = ports
	self:_rebuildChips()
end

function StatusWidget:setHttp(ok: boolean?)
	paintDot(self.httpDot, ok)
end
function StatusWidget:setMcp(ok: boolean?)
	paintDot(self.mcpDot, ok)
end
function StatusWidget:setCommands(ok: boolean?)
	paintDot(self.cmdDot, ok)
end

-- "off" | "armed" | "active" | "error" -> gray / amber / green / red
function StatusWidget:setAgentState(state: string)
	self.agentDot.BackgroundColor3 = AGENT_COLOR[state] or Theme.idle
end

function StatusWidget:setArmed(on: boolean)
	self.armed = on
	local toColor = on and Theme.green or Theme.idle
	local toPos = on and UDim2.new(1, -18, 0.5, 0) or UDim2.new(0, 2, 0.5, 0)
	TweenService:Create(self.armTrack, TweenInfo.new(0.15), { BackgroundColor3 = toColor }):Play()
	TweenService:Create(self.armKnob, TweenInfo.new(0.15, Enum.EasingStyle.Quad), { Position = toPos }):Play()
end

function StatusWidget:setSoundEnabled(on: boolean)
	self.soundEnabled = on
end

-- init pushes the live settings table; reflect every switch + token to it.
function StatusWidget:setSettings(s: any)
	self.settings = s
	self.soundEnabled = s.soundEnabled ~= false
	for name, setter in pairs(self.toolSwitches) do
		setter(s.tools[name] ~= false)
	end
	for key, setter in pairs(self.flagSwitches) do
		setter(s[key] == true)
	end
	if self.numberFields then
		for key, box in pairs(self.numberFields) do
			box.Text = tostring(s[key] or "")
		end
	end
	if self.authSwitch then
		self.authSwitch(s.auth ~= nil and s.auth.enabled == true)
	end
	if self.tokenBox and s.auth then
		self.tokenBox.Text = s.auth.token or ""
	end
end

function StatusWidget:toggle()
	self.widget.Enabled = not self.widget.Enabled
end

return StatusWidget
