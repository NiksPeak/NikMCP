-- Dock widget: Nik Studio MCP control panel (v0.2.0 makeover).
-- Layout: fixed brand bar (logo mark, title, version badge, pulsing status pill)
-- -> segmented tab strip with a sliding indicator -> scrolling views.
-- Status view: Bridge card (address chip + port lane), Connect CTA, Health card
-- (four state rows with state words + the arm switch), session stats footer.
-- Settings: one card per tool group with a count badge. Activity: newest-first
-- command cards with latency chips and an empty state. RoCreate: card sections.
-- Every public method/callback used by init.server.luau is unchanged.
-- Polish (hover, press-squash, pulse ring, slide, soft click) per
-- addictive-game-feel; UIListLayout + AutomaticSize + ScrollingFrame sizing per
-- roblox-ui-layout. Scale widths everywhere so the dock stays usable at 240px.
local StatusWidget = {}
StatusWidget.__index = StatusWidget

local SoundService = game:GetService("SoundService")
local TweenService = game:GetService("TweenService")

local Settings = require(script.Parent.Settings)

local VERSION_TEXT = "version 0.2.0" -- keep in sync with package.json "version"

-- Style-from-config: one place to retune the panel.
-- Deep cool neutrals, layered elevation, one electric indigo accent, clear
-- semantic colors. Contrast tuned for a 240-300 px dock.
local Theme = {
	bg = Color3.fromRGB(13, 14, 19),
	bg2 = Color3.fromRGB(9, 10, 14),
	panel = Color3.fromRGB(22, 24, 31),
	panelHi = Color3.fromRGB(31, 34, 44),
	field = Color3.fromRGB(16, 17, 23),
	stroke = Color3.fromRGB(44, 48, 60),
	strokeHi = Color3.fromRGB(62, 68, 86),
	text = Color3.fromRGB(233, 235, 241),
	subtext = Color3.fromRGB(140, 146, 162),
	muted = Color3.fromRGB(96, 102, 118),
	green = Color3.fromRGB(92, 204, 140),
	amber = Color3.fromRGB(234, 186, 86),
	red = Color3.fromRGB(238, 104, 104),
	accent = Color3.fromRGB(108, 125, 255),
	accent2 = Color3.fromRGB(146, 160, 255),
	accentDeep = Color3.fromRGB(74, 90, 214),
	idle = Color3.fromRGB(84, 90, 104),
}

-- Fonts: BuilderSans (current Roblox UI face) with Gotham fallbacks for older
-- Studio builds. Looked up defensively so a missing enum can never kill the dock.
local function fontOr(name: string, fallback: Enum.Font): Enum.Font
	local ok, f = pcall(function()
		return (Enum.Font :: any)[name]
	end)
	if ok and typeof(f) == "EnumItem" then
		return f :: Enum.Font
	end
	return fallback
end
local FONT_DISPLAY = fontOr("BuilderSansExtraBold", Enum.Font.GothamBold)
local FONT_BOLD = fontOr("BuilderSansBold", Enum.Font.GothamBold)
local FONT_MED = fontOr("BuilderSansMedium", Enum.Font.GothamMedium)
local FONT_BODY = fontOr("BuilderSans", Enum.Font.Gotham)
local FONT_MONO = Enum.Font.Code

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
local AGENT_WORD = {
	off = "off",
	armed = "armed",
	active = "live",
	error = "error",
}

local TWEEN_FAST = TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local TWEEN_SLIDE = TweenInfo.new(0.2, Enum.EasingStyle.Quart, Enum.EasingDirection.Out)

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

local function stroke(parent: Instance, color: Color3, trans: number?, thickness: number?): UIStroke
	local s = Instance.new("UIStroke")
	s.Color = color
	s.Transparency = trans or 0
	s.Thickness = thickness or 1
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
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

-- Two-stop color gradient (opaque; root background depth, accent buttons).
local function gradient(parent: Instance, cTop: Color3, cBottom: Color3, rot: number?): UIGradient
	local g = Instance.new("UIGradient")
	g.Color = ColorSequence.new(cTop, cBottom)
	g.Rotation = rot or 90
	g.Parent = parent
	return g
end

local function textConstraint(lbl: Instance, max: number, min: number?)
	local c = Instance.new("UITextSizeConstraint")
	c.MaxTextSize = max
	c.MinTextSize = min or 8
	c.Parent = lbl
	return c
end

-- Generic label factory: scaled text with a max/min constraint.
local function label(parent: Instance, text: string, font: Enum.Font, color: Color3, max: number, min: number?): TextLabel
	local t = Instance.new("TextLabel")
	t.BackgroundTransparency = 1
	t.Font = font
	t.Text = text
	t.TextColor3 = color
	t.TextXAlignment = Enum.TextXAlignment.Left
	t.TextYAlignment = Enum.TextYAlignment.Center
	t.TextScaled = true
	textConstraint(t, max, min or 8)
	t.Parent = parent
	return t
end

-- A grouped content card: lifted panel + sheen + hairline, padded vertical stack.
local function card(parent: Instance, order: number): Frame
	local c = Instance.new("Frame")
	c.Size = UDim2.new(1, 0, 0, 0)
	c.AutomaticSize = Enum.AutomaticSize.Y
	c.BackgroundColor3 = Theme.panel
	c.BorderSizePixel = 0
	c.LayoutOrder = order
	corner(c, 12)
	stroke(c, Theme.stroke, 0.1)
	sheen(c, 240)
	padding(c, 12, 12, 12, 12)
	vlist(c, 8)
	c.Parent = parent
	return c
end

-- Small uppercase section title inside a card, with an optional right-side badge.
local function cardTitle(parent: Instance, order: number, text: string, badgeText: string?): (Frame, TextLabel?)
	local row = Instance.new("Frame")
	row.Size = UDim2.new(1, 0, 0, 16)
	row.BackgroundTransparency = 1
	row.LayoutOrder = order
	row.Parent = parent

	local bar = Instance.new("Frame")
	bar.Size = UDim2.fromOffset(3, 12)
	bar.Position = UDim2.new(0, 0, 0.5, 0)
	bar.AnchorPoint = Vector2.new(0, 0.5)
	bar.BackgroundColor3 = Theme.accent
	bar.BorderSizePixel = 0
	corner(bar, 2)
	bar.Parent = row

	local t = label(row, string.upper(text), FONT_BOLD, Theme.subtext, 11, 8)
	t.Size = UDim2.new(1, -60, 1, 0)
	t.Position = UDim2.fromOffset(10, 0)

	local badge: TextLabel? = nil
	if badgeText then
		local b = Instance.new("TextLabel")
		b.AnchorPoint = Vector2.new(1, 0.5)
		b.Position = UDim2.new(1, 0, 0.5, 0)
		b.Size = UDim2.fromOffset(0, 16)
		b.AutomaticSize = Enum.AutomaticSize.X
		b.BackgroundColor3 = Theme.panelHi
		b.Font = FONT_MONO
		b.Text = badgeText
		b.TextColor3 = Theme.subtext
		b.TextSize = 10
		corner(b, 8)
		stroke(b, Theme.stroke, 0.2)
		padding(b, 0, 7, 0, 7)
		b.Parent = row
		badge = b
	end
	return row, badge
end

-- A status row: dot + label + right-side state word, plus a slot for controls.
local function makeRow(parent: Instance, order: number, text: string, reserveRight: number)
	local row = Instance.new("Frame")
	row.Name = text
	row.Size = UDim2.new(1, 0, 0, 28)
	row.BackgroundColor3 = Theme.panelHi
	row.BackgroundTransparency = 1
	row.BorderSizePixel = 0
	row.LayoutOrder = order
	corner(row, 8)
	row.Parent = parent
	row.MouseEnter:Connect(function()
		TweenService:Create(row, TWEEN_FAST, { BackgroundTransparency = 0.55 }):Play()
	end)
	row.MouseLeave:Connect(function()
		TweenService:Create(row, TWEEN_FAST, { BackgroundTransparency = 1 }):Play()
	end)

	local dot = Instance.new("Frame")
	dot.Name = "Dot"
	dot.Size = UDim2.fromOffset(8, 8)
	dot.Position = UDim2.new(0, 8, 0.5, 0)
	dot.AnchorPoint = Vector2.new(0, 0.5)
	dot.BackgroundColor3 = Theme.idle
	corner(dot, 4)
	stroke(dot, Theme.idle, 0.6, 2)
	dot.Parent = row

	local t = label(row, text, FONT_MED, Theme.text, 13, 10)
	t.Size = UDim2.new(1, -(reserveRight + 26), 1, 0)
	t.Position = UDim2.fromOffset(24, 0)

	local word = label(row, "", FONT_MONO, Theme.muted, 11, 8)
	word.AnchorPoint = Vector2.new(1, 0.5)
	word.Position = UDim2.new(1, -(reserveRight + 8), 0.5, 0)
	word.Size = UDim2.fromOffset(64, 14)
	word.TextXAlignment = Enum.TextXAlignment.Right

	return row, dot, word
end

-- Color a row dot (+ its halo) and its state word by tri-state ok.
local function paintDot(dot: Frame, word: TextLabel?, ok: boolean?, words: { string }?)
	local color = if ok == nil then Theme.idle elseif ok then Theme.green else Theme.red
	dot.BackgroundColor3 = color
	local halo = dot:FindFirstChildOfClass("UIStroke")
	if halo then
		halo.Color = color
	end
	if word and words then
		word.Text = if ok == nil then words[3] elseif ok then words[1] else words[2]
		word.TextColor3 = if ok == nil then Theme.muted else color
	end
end

-- A reusable on/off switch pinned to the right of its parent row. Returns the
-- clickable track plus a setter that animates to the given state.
local function makeSwitch(parent: Instance): (TextButton, (boolean) -> ())
	local track = Instance.new("TextButton")
	track.Name = "Switch"
	track.AnchorPoint = Vector2.new(1, 0.5)
	track.Position = UDim2.new(1, -4, 0.5, 0)
	track.Size = UDim2.fromOffset(36, 20)
	track.BackgroundColor3 = Theme.idle
	track.AutoButtonColor = false
	track.Text = ""
	corner(track, 10)
	local ring = stroke(track, Theme.accent2, 1, 1.5)
	track.Parent = parent

	local knob = Instance.new("Frame")
	knob.Size = UDim2.fromOffset(16, 16)
	knob.AnchorPoint = Vector2.new(0, 0.5)
	knob.Position = UDim2.new(0, 2, 0.5, 0)
	knob.BackgroundColor3 = Theme.text
	corner(knob, 8)
	sheen(knob, 214)
	knob.Parent = track

	track.MouseEnter:Connect(function()
		TweenService:Create(ring, TWEEN_FAST, { Transparency = 0.35 }):Play()
	end)
	track.MouseLeave:Connect(function()
		TweenService:Create(ring, TWEEN_FAST, { Transparency = 1 }):Play()
	end)

	local function set(on: boolean)
		TweenService:Create(track, TWEEN_FAST, {
			BackgroundColor3 = on and Theme.accent or Theme.idle,
		}):Play()
		TweenService:Create(knob, TweenInfo.new(0.16, Enum.EasingStyle.Back, Enum.EasingDirection.Out), {
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
		TweenService:Create(btn, TWEEN_FAST, {
			BackgroundColor3 = base():Lerp(Color3.new(1, 1, 1), 0.14),
		}):Play()
	end)
	btn.MouseButton1Up:Connect(function()
		TweenService:Create(btn, TWEEN_FAST, { BackgroundColor3 = base() }):Play()
	end)
	btn.MouseLeave:Connect(function()
		TweenService:Create(btn, TWEEN_FAST, { BackgroundColor3 = base() }):Play()
		TweenService:Create(scale, TweenInfo.new(0.08), { Scale = 1 }):Play()
	end)
	btn.MouseButton1Down:Connect(function()
		TweenService:Create(scale, TweenInfo.new(0.06), { Scale = 0.96 }):Play()
	end)
end

-- Text field chip shared by every view (settings token, RoCreate secrets, ...).
local function makeField(parent: Instance, placeholder: string, order: number?): TextBox
	local box = Instance.new("TextBox")
	box.Size = UDim2.new(1, 0, 0, 30)
	box.BackgroundColor3 = Theme.field
	box.Text = ""
	box.PlaceholderText = placeholder
	box.Font = FONT_MONO
	box.TextColor3 = Theme.text
	box.PlaceholderColor3 = Theme.muted
	box.TextScaled = true
	box.ClearTextOnFocus = false
	box.TextXAlignment = Enum.TextXAlignment.Left
	if order then
		box.LayoutOrder = order
	end
	corner(box, 9)
	local s = stroke(box, Theme.stroke, 0.1)
	padding(box, 0, 10, 0, 10)
	textConstraint(box, 13, 9)
	box.Focused:Connect(function()
		TweenService:Create(s, TWEEN_FAST, { Color = Theme.accent, Transparency = 0 }):Play()
	end)
	box.FocusLost:Connect(function()
		TweenService:Create(s, TWEEN_FAST, { Color = Theme.stroke, Transparency = 0.1 }):Play()
	end)
	box.Parent = parent
	return box
end

-- Filled action button (RoCreate + secondary actions).
local function makeAction(parent: Instance, text: string, fill: Color3, fg: Color3, order: number?): TextButton
	local btn = Instance.new("TextButton")
	btn.Size = UDim2.new(1, 0, 0, 32)
	btn.BackgroundColor3 = fill
	btn.AutoButtonColor = false
	btn.Text = text
	btn.Font = FONT_BOLD
	btn.TextColor3 = fg
	btn.TextScaled = true
	if order then
		btn.LayoutOrder = order
	end
	btn:SetAttribute("BaseColor", fill)
	corner(btn, 9)
	sheen(btn, 212)
	textConstraint(btn, 13, 10)
	wireButtonFeel(btn)
	btn.Parent = parent
	return btn
end

-- -- constructor ------------------------------------------------------------
function StatusWidget.new(plugin: Plugin)
	local self = setmetatable({}, StatusWidget)

	-- InitialEnabled=false + overrideRestore=false: start HIDDEN and respect the
	-- user's last placement (restored if saved). This stops the dock from forcing
	-- itself open on every plugin reload -- including when entering a playtest,
	-- where it used to overlay gameplay. It opens only when Nik clicks the toolbar
	-- button (StatusWidget:toggle is the only place that sets widget.Enabled).
	local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 300, 460, 240, 360)
	local widget = plugin:CreateDockWidgetPluginGui("RobloxStudioMCP_Status", info)
	widget.Title = "Nik Studio MCP"

	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = Theme.bg
	root.BorderSizePixel = 0
	gradient(root, Theme.bg, Theme.bg2, 90)
	root.Parent = widget

	-- Faint accent glow bleeding from the top edge (depth without noise).
	local glow = Instance.new("Frame")
	glow.Name = "TopGlow"
	glow.Size = UDim2.new(1, 0, 0, 120)
	glow.BackgroundColor3 = Theme.accent
	glow.BackgroundTransparency = 0.9
	glow.BorderSizePixel = 0
	glow.ZIndex = 0
	local glowGrad = Instance.new("UIGradient")
	glowGrad.Transparency = NumberSequence.new({
		NumberSequenceKeypoint.new(0, 0.55),
		NumberSequenceKeypoint.new(1, 1),
	})
	glowGrad.Rotation = 90
	glowGrad.Parent = glow
	glow.Parent = root

	-- == Brand bar (fixed) ======================================================
	local BRAND_H = 62
	local brand = Instance.new("Frame")
	brand.Name = "BrandBar"
	brand.Size = UDim2.new(1, 0, 0, BRAND_H)
	brand.BackgroundTransparency = 1
	brand.BorderSizePixel = 0
	brand.ZIndex = 2
	padding(brand, 12, 12, 0, 12)
	brand.Parent = root

	local mark = Instance.new("Frame")
	mark.Name = "Mark"
	mark.Size = UDim2.fromOffset(34, 34)
	mark.Position = UDim2.fromOffset(0, 1)
	mark.BackgroundColor3 = Theme.accent
	mark.BorderSizePixel = 0
	mark.ZIndex = 2
	corner(mark, 10)
	gradient(mark, Theme.accent2, Theme.accentDeep, 135)
	stroke(mark, Theme.accent2, 0.5)
	mark.Parent = brand
	local markGlyph = label(mark, "N", FONT_DISPLAY, Color3.new(1, 1, 1), 20, 12)
	markGlyph.Size = UDim2.fromScale(1, 1)
	markGlyph.TextXAlignment = Enum.TextXAlignment.Center
	markGlyph.ZIndex = 3
	-- tiny "bridge" tick under the glyph: two dots joined by a line
	local markLine = Instance.new("Frame")
	markLine.Size = UDim2.new(0.5, 0, 0, 2)
	markLine.Position = UDim2.new(0.5, 0, 1, -6)
	markLine.AnchorPoint = Vector2.new(0.5, 0.5)
	markLine.BackgroundColor3 = Color3.new(1, 1, 1)
	markLine.BackgroundTransparency = 0.45
	markLine.BorderSizePixel = 0
	markLine.ZIndex = 3
	corner(markLine, 1)
	markLine.Parent = mark

	local title = label(brand, "NikMCP", FONT_DISPLAY, Theme.text, 19, 13)
	title.Size = UDim2.new(1, -170, 0, 22)
	title.Position = UDim2.fromOffset(44, 0)
	title.ZIndex = 2

	local subtitle = label(brand, "Studio <-> Node bridge", FONT_BODY, Theme.subtext, 11, 8)
	subtitle.Size = UDim2.new(1, -240, 0, 13)
	subtitle.Position = UDim2.fromOffset(44, 23)
	subtitle.ZIndex = 2

	-- Version badge: mono chip right after the subtitle. Keep the text in sync
	-- with package.json "version" (tests/version-parity.mjs pins it).
	local version = Instance.new("TextLabel")
	version.Name = "VersionTag"
	version.AnchorPoint = Vector2.new(0, 0.5)
	version.Position = UDim2.new(0, 44, 0, 45)
	version.Size = UDim2.fromOffset(0, 16)
	version.AutomaticSize = Enum.AutomaticSize.X
	version.BackgroundColor3 = Theme.panelHi
	version.Font = FONT_MONO
	version.Text = "version 0.2.0"
	version.TextColor3 = Theme.accent2
	version.TextSize = 10
	version.ZIndex = 2
	corner(version, 8)
	stroke(version, Theme.accent, 0.55)
	padding(version, 0, 7, 0, 7)
	version.Parent = brand
	self.versionTag = version

	-- Status pill (the signature element): dot + word, state-tinted, pulses.
	local pill = Instance.new("Frame")
	pill.Name = "Pill"
	pill.AnchorPoint = Vector2.new(1, 0)
	pill.Position = UDim2.new(1, 0, 0, 4)
	pill.Size = UDim2.fromOffset(0, 26)
	pill.AutomaticSize = Enum.AutomaticSize.X
	pill.BackgroundColor3 = Theme.red
	pill.BackgroundTransparency = 0.84
	pill.ZIndex = 2
	corner(pill, 13)
	local pillStroke = stroke(pill, Theme.red, 0.45)
	local pillPad = Instance.new("UIPadding")
	pillPad.PaddingLeft = UDim.new(0, 9)
	pillPad.PaddingRight = UDim.new(0, 11)
	pillPad.Parent = pill
	hlist(pill, 6)
	local pillScale = Instance.new("UIScale")
	pillScale.Parent = pill
	pill.Parent = brand

	local pillDot = Instance.new("Frame")
	pillDot.Size = UDim2.fromOffset(8, 8)
	pillDot.BackgroundColor3 = Theme.red
	pillDot.LayoutOrder = 1
	pillDot.ZIndex = 3
	corner(pillDot, 4)
	pillDot.Parent = pill
	-- expanding ring for the pulse (scaled + faded on each state change)
	local pillRing = Instance.new("Frame")
	pillRing.Size = UDim2.fromOffset(8, 8)
	pillRing.Position = UDim2.fromScale(0.5, 0.5)
	pillRing.AnchorPoint = Vector2.new(0.5, 0.5)
	pillRing.BackgroundTransparency = 1
	pillRing.ZIndex = 3
	corner(pillRing, 4)
	local pillRingStroke = stroke(pillRing, Theme.red, 1, 1.5)
	local pillRingScale = Instance.new("UIScale")
	pillRingScale.Parent = pillRing
	pillRing.Parent = pillDot

	local pillWord = Instance.new("TextLabel")
	pillWord.AutomaticSize = Enum.AutomaticSize.X
	pillWord.Size = UDim2.fromOffset(0, 26)
	pillWord.BackgroundTransparency = 1
	pillWord.Font = FONT_MED
	pillWord.Text = WORD.Disconnected
	pillWord.TextColor3 = Theme.text
	pillWord.TextSize = 12
	pillWord.LayoutOrder = 2
	pillWord.ZIndex = 3
	pillWord.Parent = pill

	self.pill, self.pillDot, self.pillWord, self.pillStroke, self.pillScale =
		pill, pillDot, pillWord, pillStroke, pillScale
	self.pillRingStroke, self.pillRingScale = pillRingStroke, pillRingScale

	-- == Segmented tab strip (fixed) ===========================================
	local TAB_H = 34
	local tabWrap = Instance.new("Frame")
	tabWrap.Name = "TabBar"
	tabWrap.Size = UDim2.new(1, 0, 0, TAB_H + 8)
	tabWrap.Position = UDim2.fromOffset(0, BRAND_H)
	tabWrap.BackgroundTransparency = 1
	tabWrap.ZIndex = 2
	padding(tabWrap, 0, 12, 8, 12)
	tabWrap.Parent = root

	local tabBar = Instance.new("Frame")
	tabBar.Size = UDim2.new(1, 0, 0, TAB_H)
	tabBar.BackgroundColor3 = Theme.field
	tabBar.BorderSizePixel = 0
	tabBar.ZIndex = 2
	corner(tabBar, 10)
	stroke(tabBar, Theme.stroke, 0.2)
	padding(tabBar, 3, 3, 3, 3)
	tabBar.Parent = tabWrap

	local indicator = Instance.new("Frame")
	indicator.Name = "Indicator"
	indicator.Size = UDim2.new(0.25, 0, 1, 0)
	indicator.Position = UDim2.new(0, 0, 0, 0)
	indicator.BackgroundColor3 = Theme.panelHi
	indicator.BorderSizePixel = 0
	indicator.ZIndex = 2
	corner(indicator, 8)
	stroke(indicator, Theme.accent, 0.35)
	sheen(indicator, 226)
	indicator.Parent = tabBar
	self.tabIndicator = indicator

	local hairline = Instance.new("Frame")
	hairline.Size = UDim2.new(1, -24, 0, 1)
	hairline.Position = UDim2.new(0, 12, 0, BRAND_H + TAB_H + 8)
	hairline.BackgroundColor3 = Theme.stroke
	hairline.BackgroundTransparency = 0.5
	hairline.BorderSizePixel = 0
	hairline.Parent = root

	local BODY_TOP = BRAND_H + TAB_H + 9
	local body = Instance.new("Frame")
	body.Size = UDim2.new(1, 0, 1, -BODY_TOP)
	body.Position = UDim2.fromOffset(0, BODY_TOP)
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
		v.ScrollBarImageColor3 = Theme.strokeHi
		v.CanvasSize = UDim2.new()
		v.AutomaticCanvasSize = Enum.AutomaticSize.Y
		v.CanvasPosition = Vector2.new(0, 0)
		v.Visible = false
		padding(v, 10, 12, 14, 12)
		vlist(v, 10)
		v.Parent = body
		return v
	end

	-- the Status view (existing content scrolls vertically when the dock is short)
	local scroller = makeView()
	scroller.Visible = true
	-- center compact items (the secondary Disconnect button); full-width cards
	-- and the Connect CTA span the width so centering is a no-op for them.
	local scrollerList = scroller:FindFirstChildOfClass("UIListLayout")
	if scrollerList then
		scrollerList.HorizontalAlignment = Enum.HorizontalAlignment.Center
	end

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
	self.commandCount = 0
	self.lastMs = nil

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
	self.onRocreateSetApiKey = nil -- (apiKey) -> "ok" | error string

	-- Status tab order: bridge card(1) -> Connect button(2) -> health card(3) -> stats(4).
	local bridgeCard = card(scroller, 1)
	cardTitle(bridgeCard, 1, "Bridge")

	-- Monospace address rendered as a field-chip with a state-colored marker.
	local addr = Instance.new("Frame")
	addr.Size = UDim2.new(1, 0, 0, 32)
	addr.BackgroundColor3 = Theme.field
	addr.BorderSizePixel = 0
	addr.LayoutOrder = 2
	corner(addr, 9)
	stroke(addr, Theme.stroke, 0.2)
	padding(addr, 0, 12, 0, 12)
	addr.Parent = bridgeCard

	local addrDot = Instance.new("Frame")
	addrDot.Size = UDim2.fromOffset(7, 7)
	addrDot.Position = UDim2.new(0, 0, 0.5, 0)
	addrDot.AnchorPoint = Vector2.new(0, 0.5)
	addrDot.BackgroundColor3 = Theme.red
	corner(addrDot, 4)
	addrDot.Parent = addr

	local address = label(addr, "http://127.0.0.1:---", FONT_MONO, Theme.text, 14, 10)
	address.Size = UDim2.new(1, -16, 1, 0)
	address.Position = UDim2.fromOffset(16, 0)
	self.address, self.addrDot = address, addrDot

	-- Port lane: horizontally-scrolling chips + a "+" pinned outside the scroll.
	-- The scrollbar stays visible and tall enough to grab in Studio's compact dock.
	local lane = Instance.new("Frame")
	lane.Name = "PortLane"
	lane.Size = UDim2.new(1, 0, 0, 30)
	lane.BackgroundTransparency = 1
	lane.LayoutOrder = 3
	lane.Parent = bridgeCard

	local chipScroll = Instance.new("ScrollingFrame")
	chipScroll.Size = UDim2.new(1, -38, 1, 0) -- room on the right for "+"; the editor overlays on top
	chipScroll.BackgroundTransparency = 1
	chipScroll.BorderSizePixel = 0
	chipScroll.Active = true
	chipScroll.ClipsDescendants = true
	chipScroll.ScrollingEnabled = true
	chipScroll.ScrollingDirection = Enum.ScrollingDirection.X
	chipScroll.AutomaticCanvasSize = Enum.AutomaticSize.X
	chipScroll.CanvasSize = UDim2.new()
	chipScroll.ScrollBarThickness = 6
	chipScroll.ScrollBarImageColor3 = Theme.strokeHi
	chipScroll.ScrollBarImageTransparency = 0
	chipScroll.Parent = lane
	local chipLayout = hlist(chipScroll, 6)
	chipLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	local chipPad = Instance.new("UIPadding")
	chipPad.PaddingBottom = UDim.new(0, 6) -- reserve the scrollbar instead of covering chips
	chipPad.Parent = chipScroll
	self.chipScroll = chipScroll

	-- Roblox maps wheel motion to Y by default. This lane only scrolls on X, so
	-- translate the documented wheel events into a bounded horizontal step.
	local function scrollPortLane(delta: number)
		local maxX = math.max(0, chipScroll.AbsoluteCanvasSize.X - chipScroll.AbsoluteWindowSize.X)
		local nextX = math.clamp(chipScroll.CanvasPosition.X + delta, 0, maxX)
		chipScroll.CanvasPosition = Vector2.new(nextX, chipScroll.CanvasPosition.Y)
	end
	chipScroll.MouseWheelForward:Connect(function()
		scrollPortLane(-48)
	end)
	chipScroll.MouseWheelBackward:Connect(function()
		scrollPortLane(48)
	end)

	-- "+" add control, pinned to the right of the lane (outside the scroll).
	local add = Instance.new("TextButton")
	add.Name = "AddPort"
	add.AnchorPoint = Vector2.new(1, 0.5)
	add.Position = UDim2.new(1, 0, 0.5, -3)
	add.Size = UDim2.fromOffset(32, 22)
	add.BackgroundColor3 = Theme.panelHi
	add.AutoButtonColor = false
	add.Text = "+"
	add.Font = FONT_BOLD
	add.TextColor3 = Theme.accent2
	add.TextScaled = true
	corner(add, 8)
	stroke(add, Theme.strokeHi, 0.2)
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
	editor.Position = UDim2.new(1, -38, 0.5, -3)
	editor.Size = UDim2.fromOffset(96, 22)
	editor.BackgroundColor3 = Theme.panelHi
	editor.BackgroundTransparency = 0
	editor.BorderSizePixel = 0
	editor.Active = true -- sink clicks in the overlay gaps so covered chips cannot fire
	editor.Visible = false
	editor.ZIndex = 10
	corner(editor, 8)
	stroke(editor, Theme.accent, 0.1)
	editor.Parent = lane
	self.editor = editor
	self.overStepper = nil -- "up" | "down" while the mouse hovers a stepper

	local editBox = Instance.new("TextBox")
	editBox.Size = UDim2.new(1, -22, 1, 0)
	editBox.BackgroundColor3 = Theme.field
	editBox.Text = ""
	editBox.PlaceholderText = "port"
	editBox.Font = FONT_MONO
	editBox.TextColor3 = Theme.text
	editBox.PlaceholderColor3 = Theme.muted
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
		b.Font = FONT_BOLD
		b.TextColor3 = Theme.subtext
		b.TextSize = 11
		b.AutoButtonColor = false
		b.ZIndex = 11
		b.Parent = stepper
		-- The actual step is done in editBox.FocusLost (we know which stepper the
		-- mouse is over), so clicking a stepper never cancels the editor.
		b.MouseEnter:Connect(function()
			self.overStepper = dir
			b.TextColor3 = Theme.accent2
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
		TweenService:Create(add, TWEEN_FAST, { BackgroundColor3 = Theme.accentDeep, TextColor3 = Color3.new(1, 1, 1) }):Play()
	end)
	add.MouseLeave:Connect(function()
		TweenService:Create(add, TWEEN_FAST, { BackgroundColor3 = Theme.panelHi, TextColor3 = Theme.accent2 }):Play()
	end)
	add.MouseButton1Click:Connect(function()
		self:_click()
		if self.editor.Visible then
			self:_cancelEditor() -- toggle the add editor off
			return
		end
		self:_openEditor(self:_suggestPort())
	end)

	-- Primary Connect/Disconnect button (gradient, glow ring, hover-lighten, press-squash).
	local primary = Instance.new("TextButton")
	primary.Name = "Primary"
	primary.Size = UDim2.new(1, 0, 0, 38)
	primary.BackgroundColor3 = Theme.accent
	primary.TextColor3 = Color3.new(1, 1, 1)
	primary.Font = FONT_BOLD
	primary.Text = "Connect"
	primary.TextScaled = true
	primary.AutoButtonColor = false
	primary.LayoutOrder = 2 -- directly under the bridge card
	primary:SetAttribute("BaseColor", Theme.accent)
	corner(primary, 11)
	local primaryGrad = sheen(primary, 196)
	local primaryRing = stroke(primary, Theme.accent2, 0.6)
	textConstraint(primary, 16, 12)
	primary.Parent = scroller
	self.primary, self.primaryGrad, self.primaryRing = primary, primaryGrad, primaryRing
	wireButtonFeel(primary)
	primary.MouseButton1Click:Connect(function()
		self:_click()
		if self.onPrimary then
			self.onPrimary()
		end
	end)

	-- Health card: four state rows (dot + label + state word) + the arm switch.
	local healthCard = card(scroller, 3)
	cardTitle(healthCard, 1, "Health")
	local rows = Instance.new("Frame")
	rows.Size = UDim2.new(1, 0, 0, 0)
	rows.AutomaticSize = Enum.AutomaticSize.Y
	rows.BackgroundTransparency = 1
	rows.LayoutOrder = 2
	vlist(rows, 2)
	rows.Parent = healthCard

	local _httpRow, httpDot, httpWord = makeRow(rows, 1, "HTTP server", 0)
	local _mcpRow, mcpDot, mcpWord = makeRow(rows, 2, "MCP bridge", 0)
	local _cmdRow, cmdDot, cmdWord = makeRow(rows, 3, "Commands", 0)
	local agentRow, agentDot, agentWord = makeRow(rows, 4, "Playtest agent", 44)
	self.httpDot, self.mcpDot, self.cmdDot, self.agentDot = httpDot, mcpDot, cmdDot, agentDot
	self.httpWord, self.mcpWord, self.cmdWord, self.agentWord = httpWord, mcpWord, cmdWord, agentWord
	paintDot(httpDot, httpWord, false, { "online", "offline", "idle" })
	paintDot(mcpDot, mcpWord, nil, { "linked", "down", "idle" })
	paintDot(cmdDot, cmdWord, nil, { "proven", "failing", "none yet" })
	agentDot.BackgroundColor3 = Theme.idle
	agentWord.Text = AGENT_WORD.off

	-- arm toggle switch on the Playtest agent row
	local track, setArmSwitch = makeSwitch(agentRow)
	track.Name = "ArmToggle"
	self.armTrack, self.setArmSwitch = track, setArmSwitch
	track.MouseButton1Click:Connect(function()
		self:_click()
		if self.onArm then
			self.onArm()
		end
	end)

	-- Session stats footer: version, tool count, commands this session, last latency.
	local stats = label(scroller, "", FONT_MONO, Theme.muted, 10, 8)
	stats.Name = "Stats"
	stats.Size = UDim2.new(1, 0, 0, 14)
	stats.LayoutOrder = 4
	stats.TextXAlignment = Enum.TextXAlignment.Center
	self.statsLabel = stats
	self:_refreshStats()

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
	self.tabOrder = { "Status", "Settings", "Activity", "RoCreate" }
	for i, name in ipairs(self.tabOrder) do
		local tab = Instance.new("TextButton")
		tab.Name = name
		tab.Size = UDim2.new(0.25, 0, 1, 0)
		tab.Position = UDim2.new(0.25 * (i - 1), 0, 0, 0)
		tab.BackgroundTransparency = 1
		tab.AutoButtonColor = false
		tab.Text = name
		tab.Font = FONT_MED
		tab.TextColor3 = Theme.subtext
		tab.TextScaled = true
		tab.ZIndex = 3
		textConstraint(tab, 12, 9)
		tab.Parent = tabBar
		self.tabs[name] = tab
		tab.MouseEnter:Connect(function()
			if self.activeTab ~= name then
				TweenService:Create(tab, TWEEN_FAST, { TextColor3 = Theme.text }):Play()
			end
		end)
		tab.MouseLeave:Connect(function()
			if self.activeTab ~= name then
				TweenService:Create(tab, TWEEN_FAST, { TextColor3 = Theme.subtext }):Play()
			end
		end)
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
	self.activeTab = name
	for tabName, view in pairs(self.views) do
		view.Visible = tabName == name
		local tab = self.tabs[tabName]
		local active = tabName == name
		TweenService:Create(tab, TWEEN_FAST, { TextColor3 = active and Theme.text or Theme.subtext }):Play()
		tab.Font = active and FONT_BOLD or FONT_MED
	end
	for i, tabName in ipairs(self.tabOrder) do
		if tabName == name then
			TweenService:Create(self.tabIndicator, TWEEN_SLIDE, {
				Position = UDim2.new(0.25 * (i - 1), 0, 0, 0),
			}):Play()
		end
	end
end

-- -- session stats ------------------------------------------------------------
function StatusWidget:_refreshStats()
	if not self.statsLabel then
		return
	end
	local parts = { VERSION_TEXT, tostring(#Settings.TOOLS) .. " tools" }
	if self.commandCount > 0 then
		table.insert(parts, tostring(self.commandCount) .. " cmds")
	end
	if self.lastMs then
		table.insert(parts, "last " .. tostring(self.lastMs) .. " ms")
	end
	self.statsLabel.Text = table.concat(parts, "  |  ")
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
		local bg = if colored then connColor(pState) elseif isSelected then Theme.panelHi else Theme.panel
		local fg = colored and Theme.bg or (isSelected and Theme.text or Theme.subtext)

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
		stroke(chip, isSelected and Theme.accent or Theme.stroke, isSelected and 0 or 0.2, isSelected and 1.5 or 1)
		if colored then
			sheen(chip, 224)
		end
		chip.Parent = self.chipScroll

		local lbl = Instance.new("TextLabel")
		lbl.BackgroundTransparency = 1
		lbl.Font = FONT_MONO
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
				TweenService:Create(chip, TWEEN_FAST, { BackgroundColor3 = Theme.panelHi }):Play()
				TweenService:Create(lbl, TWEEN_FAST, { TextColor3 = Theme.text }):Play()
			end)
			chip.MouseLeave:Connect(function()
				TweenService:Create(chip, TWEEN_FAST, { BackgroundColor3 = bg }):Play()
				TweenService:Create(lbl, TWEEN_FAST, { TextColor3 = fg }):Play()
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
		x.Size = UDim2.fromOffset(14, 16)
		x.Position = UDim2.new(1, -4, 0.5, 0)
		x.AnchorPoint = Vector2.new(1, 0.5)
		x.ZIndex = 2 -- above the chip body so "x" removes instead of selecting
		x.BackgroundTransparency = 1
		x.Text = "x"
		x.Font = FONT_BOLD
		x.TextColor3 = colored and fg or Theme.muted
		x.TextScaled = true
		textConstraint(x, 11, 8)
		corner(x, 5)
		x.Parent = chip

		-- Port removal stops a live polling lane, so require a deliberate second
		-- click. The first click arms briefly and gives an unmistakable "?" state.
		local removeArmed = false
		local removeArmToken = 0
		x.MouseButton1Click:Connect(function()
			self:_click()
			if not removeArmed then
				removeArmed = true
				removeArmToken += 1
				local token = removeArmToken
				x.Text = "?"
				x.TextColor3 = Theme.red
				x.BackgroundColor3 = Theme.bg2
				x.BackgroundTransparency = 0
				task.delay(1.4, function()
					if x.Parent and removeArmed and removeArmToken == token then
						removeArmed = false
						x.Text = "x"
						x.TextColor3 = colored and fg or Theme.muted
						x.BackgroundTransparency = 1
					end
				end)
				return
			end
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
function StatusWidget:_settingsRow(parent: Instance, order: number, text: string, initial: boolean, onChange: (boolean) -> ()): (boolean) -> ()
	local row = Instance.new("Frame")
	row.Size = UDim2.new(1, 0, 0, 28)
	row.BackgroundColor3 = Theme.panelHi
	row.BackgroundTransparency = 1
	row.BorderSizePixel = 0
	row.LayoutOrder = order
	corner(row, 8)
	row.Parent = parent
	row.MouseEnter:Connect(function()
		TweenService:Create(row, TWEEN_FAST, { BackgroundTransparency = 0.55 }):Play()
	end)
	row.MouseLeave:Connect(function()
		TweenService:Create(row, TWEEN_FAST, { BackgroundTransparency = 1 }):Play()
	end)

	local lbl = label(row, text, FONT_BODY, Theme.text, 13, 9)
	lbl.Size = UDim2.new(1, -58, 1, 0)
	lbl.Position = UDim2.fromOffset(8, 0)

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

function StatusWidget:_buildSettings(view: ScrollingFrame)
	local order = 0
	local function nextOrder(): number
		order += 1
		return order
	end

	-- Tools grouped under Read / Write / Assets / Experimental / Scene, one card each.
	for _, group in ipairs(Settings.GROUPS) do
		local members = {}
		for _, tool in ipairs(Settings.TOOLS) do
			if tool.group == group.key then
				table.insert(members, tool)
			end
		end
		local c = card(view, nextOrder())
		cardTitle(c, 0, group.label, tostring(#members))
		for i, tool in ipairs(members) do
			local name = tool.name
			local setter = self:_settingsRow(c, i, tool.label, true, function(on)
				self.settings.tools[name] = on
				if self.onToggleTool then
					self.onToggleTool(name, on)
				end
			end)
			self.toolSwitches[name] = setter
		end
	end

	-- Misc flags
	local misc = card(view, nextOrder())
	cardTitle(misc, 0, "Behavior")
	local FLAGS = {
		{ key = "readOnly", label = "Read-only mode (block writes)" },
		{ key = "confirmDestructive", label = "Confirm destructive (stub)" },
		{ key = "soundEnabled", label = "Sound" },
		{ key = "activityLog", label = "Activity log" },
		{ key = "playtestAutoStop", label = "Auto-stop abandoned playtests" },
	}
	for i, f in ipairs(FLAGS) do
		local key = f.key
		local setter = self:_settingsRow(misc, i, f.label, true, function(on)
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
	local limits = card(view, nextOrder())
	cardTitle(limits, 0, "Playtest auto-stop (seconds)")
	self.numberFields = {}
	local function numberField(labelText: string, key: string, rowOrder: number)
		local row = Instance.new("Frame")
		row.Size = UDim2.new(1, 0, 0, 28)
		row.BackgroundTransparency = 1
		row.LayoutOrder = rowOrder
		row.Parent = limits
		local lbl = label(row, labelText, FONT_BODY, Theme.text, 13, 9)
		lbl.Size = UDim2.new(1, -84, 1, 0)
		lbl.Position = UDim2.fromOffset(8, 0)
		local box = Instance.new("TextBox")
		box.AnchorPoint = Vector2.new(1, 0.5)
		box.Position = UDim2.new(1, -4, 0.5, 0)
		box.Size = UDim2.new(0, 66, 0, 24)
		box.BackgroundColor3 = Theme.field
		box.Font = FONT_MONO
		box.TextColor3 = Theme.text
		box.TextScaled = true
		box.ClearTextOnFocus = false
		box.Text = tostring(self.settings[key] or "")
		corner(box, 7)
		stroke(box, Theme.stroke, 0.1)
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
	numberField("Max run time", "playtestMaxSeconds", 1)
	numberField("Idle timeout", "playtestIdleSeconds", 2)

	-- Auth: enable switch + token field (TOFU; off by default)
	local auth = card(view, nextOrder())
	cardTitle(auth, 0, "Auth (optional, TOFU)")
	local authRow = Instance.new("Frame")
	authRow.Size = UDim2.new(1, 0, 0, 28)
	authRow.BackgroundTransparency = 1
	authRow.LayoutOrder = 1
	authRow.Parent = auth
	local authLbl = label(authRow, "Require token", FONT_BODY, Theme.text, 13, 9)
	authLbl.Size = UDim2.new(1, -58, 1, 0)
	authLbl.Position = UDim2.fromOffset(8, 0)
	local authTrack, authSet = makeSwitch(authRow)
	authSet(false)
	self.authSwitch = authSet

	local tokenBox = makeField(auth, "token (e.g. a random string)", 2)
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

	-- Header block: title, lock pill, hint.
	local head = card(view, nextOrder())
	local headRow = Instance.new("Frame")
	headRow.Size = UDim2.new(1, 0, 0, 24)
	headRow.BackgroundTransparency = 1
	headRow.LayoutOrder = 1
	headRow.Parent = head
	local title = label(headRow, "RoCreate", FONT_DISPLAY, Theme.text, 16, 12)
	title.Size = UDim2.new(1, -110, 1, 0)

	local status = Instance.new("TextLabel")
	status.AnchorPoint = Vector2.new(1, 0.5)
	status.Position = UDim2.new(1, 0, 0.5, 0)
	status.Size = UDim2.fromOffset(0, 20)
	status.AutomaticSize = Enum.AutomaticSize.X
	status.BackgroundColor3 = Theme.amber
	status.BackgroundTransparency = 0.84
	status.Font = FONT_MONO
	status.Text = "locked"
	status.TextColor3 = Theme.amber
	status.TextSize = 11
	corner(status, 10)
	local statusStroke = stroke(status, Theme.amber, 0.5)
	padding(status, 0, 9, 0, 9)
	status.Parent = headRow
	self.rcStatusLabel, self.rcStatusStroke = status, statusStroke

	local hint = label(head, "Password-gated reupload. The cookie is encrypted on disk; the password is never stored.", FONT_BODY, Theme.subtext, 11, 9)
	hint.Size = UDim2.new(1, 0, 0, 28)
	hint.LayoutOrder = 2
	hint.TextWrapped = true
	hint.TextYAlignment = Enum.TextYAlignment.Top

	local result = label(head, "", FONT_MONO, Theme.subtext, 11, 9)
	result.Size = UDim2.new(1, 0, 0, 16)
	result.LayoutOrder = 3
	result.Visible = false
	self.rcResultLabel = result

	-- Unlock card: password + Unlock / Lock
	local unlockCard = card(view, nextOrder())
	cardTitle(unlockCard, 0, "Unlock")
	local pwBox = makeField(unlockCard, "password (unlock)", 1)

	local btnRow = Instance.new("Frame")
	btnRow.Size = UDim2.new(1, 0, 0, 32)
	btnRow.BackgroundTransparency = 1
	btnRow.LayoutOrder = 2
	hlist(btnRow, 8)
	btnRow.Parent = unlockCard

	local unlockBtn = makeAction(btnRow, "Unlock", Theme.green, Theme.bg, 1)
	unlockBtn.Size = UDim2.new(0.5, -4, 0, 32)
	local lockBtn = makeAction(btnRow, "Lock", Theme.panelHi, Theme.text, 2)
	lockBtn.Size = UDim2.new(0.5, -4, 0, 32)

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

	-- Credentials card (one time)
	local credCard = card(view, nextOrder())
	cardTitle(credCard, 0, "Credentials (one time)")
	local cookieBox = makeField(credCard, "paste .ROBLOSECURITY cookie", 1)
	local credPwBox = makeField(credCard, "password to encrypt it with", 2)
	local saveBtn = makeAction(credCard, "Save credentials", Theme.accent, Color3.new(1, 1, 1), 3)
	saveBtn.MouseButton1Click:Connect(function()
		self:_click()
		if self.onRocreateSetCreds then
			local res = self.onRocreateSetCreds(cookieBox.Text, credPwBox.Text)
			cookieBox.Text = ""
			credPwBox.Text = ""
			self:_setRocreateResult(res)
		end
	end)

	-- API key card
	local keyCard = card(view, nextOrder())
	cardTitle(keyCard, 0, "Open Cloud API key")
	local apiKeyBox = makeField(keyCard, "paste RoCreate API key", 1)
	local saveKeyBtn = makeAction(keyCard, "Save API key", Theme.accent, Color3.new(1, 1, 1), 2)
	saveKeyBtn.MouseButton1Click:Connect(function()
		self:_click()
		if self.onRocreateSetApiKey then
			local res = self.onRocreateSetApiKey(apiKeyBox.Text)
			apiKeyBox.Text = ""
			self:_setRocreateResult(res)
		end
	end)
end

-- Refresh the status pill from booleans (values never leave Node; these are flags).
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
		table.insert(parts, "COOKIE EXPIRED")
	end
	local color = unlocked and Theme.green or Theme.amber
	self.rcStatusLabel.Text = table.concat(parts, "  ")
	self.rcStatusLabel.TextColor3 = color
	self.rcStatusLabel.BackgroundColor3 = color
	if self.rcStatusStroke then
		self.rcStatusStroke.Color = color
	end
end

function StatusWidget:_setRocreateResult(text: string?)
	if self.rcResultLabel then
		self.rcResultLabel.Text = text or ""
		self.rcResultLabel.Visible = text ~= nil and text ~= ""
	end
end

-- -- activity view ----------------------------------------------------------
function StatusWidget:_buildActivity(view: ScrollingFrame)
	local header = Instance.new("Frame")
	header.Name = "ActivityHeader"
	header.Size = UDim2.new(1, 0, 0, 18)
	header.BackgroundTransparency = 1
	header.LayoutOrder = -1000000 -- stay on top; rows sort newest-first below it
	header.Parent = view
	local _row, badge = cardTitle(header, 0, "Recent commands", "0")
	self.activityHeader = header
	self.activityBadge = badge

	local empty = label(view, "No commands yet. Connect a port and let the agent work.", FONT_BODY, Theme.muted, 11, 9)
	empty.Name = "Empty"
	empty.Size = UDim2.new(1, 0, 0, 40)
	empty.LayoutOrder = -999999
	empty.TextWrapped = true
	empty.TextXAlignment = Enum.TextXAlignment.Center
	self.activityEmpty = empty

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
	self.commandCount += 1
	if entry.ms then
		self.lastMs = entry.ms
	end
	self:_refreshStats()
	if self.activityEmpty then
		self.activityEmpty.Visible = false
	end
	if self.activityBadge then
		self.activityBadge.Text = tostring(self.commandCount)
	end

	local okColor = entry.ok and Theme.green or Theme.red

	local row = Instance.new("Frame")
	row.Size = UDim2.new(1, 0, 0, 34)
	row.BackgroundColor3 = Theme.panel
	row.BorderSizePixel = 0
	-- newest on top: header is LayoutOrder 0, rows use decreasing negative order
	row.LayoutOrder = -self.activitySeq
	corner(row, 9)
	stroke(row, Theme.stroke, 0.25)
	sheen(row, 242)
	padding(row, 0, 8, 0, 10)
	row.Parent = view

	-- left accent rail colored by outcome
	local rail = Instance.new("Frame")
	rail.Size = UDim2.new(0, 3, 1, -12)
	rail.Position = UDim2.new(0, -6, 0.5, 0)
	rail.AnchorPoint = Vector2.new(0, 0.5)
	rail.BackgroundColor3 = okColor
	rail.BorderSizePixel = 0
	corner(rail, 2)
	rail.Parent = row

	local name = label(row, tostring(entry.tool), FONT_MONO, Theme.text, 12, 9)
	name.Size = UDim2.new(1, -70, 0, 16)
	name.Position = UDim2.fromOffset(4, 3)

	local stamp = ""
	pcall(function()
		stamp = os.date("%H:%M:%S", entry.time) :: string
	end)
	local target = label(row, (stamp ~= "" and (stamp .. "  ") or "") .. tostring(entry.target or ""), FONT_BODY, Theme.subtext, 10, 8)
	target.Size = UDim2.new(1, -70, 0, 12)
	target.Position = UDim2.fromOffset(4, 20)

	-- latency chip, tinted by outcome
	local ms = Instance.new("TextLabel")
	ms.AnchorPoint = Vector2.new(1, 0.5)
	ms.Position = UDim2.new(1, 0, 0.5, 0)
	ms.Size = UDim2.fromOffset(0, 18)
	ms.AutomaticSize = Enum.AutomaticSize.X
	ms.BackgroundColor3 = okColor
	ms.BackgroundTransparency = 0.85
	ms.Font = FONT_MONO
	ms.Text = (entry.ms and (tostring(entry.ms) .. " ms")) or (entry.ok and "ok" or "fail")
	ms.TextColor3 = okColor
	ms.TextSize = 10
	corner(ms, 9)
	stroke(ms, okColor, 0.6)
	padding(ms, 0, 7, 0, 7)
	ms.Parent = row

	-- entrance: slide in from slightly above + fade
	row.BackgroundTransparency = 1
	local slide = Instance.new("UIScale")
	slide.Scale = 0.97
	slide.Parent = row
	TweenService:Create(row, TWEEN_SLIDE, { BackgroundTransparency = 0 }):Play()
	TweenService:Create(slide, TWEEN_SLIDE, { Scale = 1 }):Play()

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

-- pulse the status pill on a connection state change: squash + expanding ring
function StatusWidget:_pulse()
	local scale = self.pillScale
	local up = TweenService:Create(scale, TweenInfo.new(0.12, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Scale = 1.08 })
	local down = TweenService:Create(scale, TweenInfo.new(0.18), { Scale = 1 })
	up:Play()
	up.Completed:Once(function()
		down:Play()
	end)
	local ringScale, ringStroke = self.pillRingScale, self.pillRingStroke
	if ringScale and ringStroke then
		ringScale.Scale = 1
		ringStroke.Transparency = 0.2
		TweenService:Create(ringScale, TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { Scale = 3 }):Play()
		TweenService:Create(ringStroke, TweenInfo.new(0.5), { Transparency = 1 }):Play()
	end
end

-- -- public API -------------------------------------------------------------
function StatusWidget:_applyConnectionState(state: string)
	self.connState = state
	local color = STATE_COLOR[state] or Theme.idle
	TweenService:Create(self.pill, TWEEN_FAST, { BackgroundColor3 = color }):Play()
	TweenService:Create(self.pillStroke, TWEEN_FAST, { Color = color }):Play()
	TweenService:Create(self.pillDot, TWEEN_FAST, { BackgroundColor3 = color }):Play()
	if self.pillRingStroke then
		self.pillRingStroke.Color = color
	end
	self.pillWord.Text = WORD[state] or state
	TweenService:Create(self.addrDot, TWEEN_FAST, { BackgroundColor3 = connColor(state) }):Play() -- gray idle / amber / green
	-- Disconnect is offered whenever a connection is up or being attempted.
	local live = state == "Connected" or state == "Connecting"
	if live then
		-- compact, muted secondary: dark chip + red text (destructive, restrained),
		-- centered by the scroller's list layout -- NOT a full-width red block.
		self.primary.Text = "Disconnect"
		self.primary.Size = UDim2.fromOffset(136, 30)
		self.primary.BackgroundColor3 = Theme.panel
		self.primary.TextColor3 = Theme.red
		self.primary:SetAttribute("BaseColor", Theme.panel)
		self.primaryRing.Color = Theme.red
		self.primaryRing.Transparency = 0.7
	else
		-- prominent primary CTA: full-width accent
		self.primary.Text = "Connect"
		self.primary.Size = UDim2.new(1, 0, 0, 38)
		self.primary.BackgroundColor3 = Theme.accent
		self.primary.TextColor3 = Color3.new(1, 1, 1)
		self.primary:SetAttribute("BaseColor", Theme.accent)
		self.primaryRing.Color = Theme.accent2
		self.primaryRing.Transparency = 0.6
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
	paintDot(self.httpDot, self.httpWord, ok, { "online", "offline", "idle" })
end
function StatusWidget:setMcp(ok: boolean?)
	paintDot(self.mcpDot, self.mcpWord, ok, { "linked", "down", "idle" })
end
function StatusWidget:setCommands(ok: boolean?)
	paintDot(self.cmdDot, self.cmdWord, ok, { "proven", "failing", "none yet" })
end

-- "off" | "armed" | "active" | "error" -> gray / amber / green / red
function StatusWidget:setAgentState(state: string)
	local color = AGENT_COLOR[state] or Theme.idle
	self.agentDot.BackgroundColor3 = color
	local halo = self.agentDot:FindFirstChildOfClass("UIStroke")
	if halo then
		halo.Color = color
	end
	if self.agentWord then
		self.agentWord.Text = AGENT_WORD[state] or state
		self.agentWord.TextColor3 = if state == "off" then Theme.muted else color
	end
end

function StatusWidget:setArmed(on: boolean)
	self.armed = on
	if self.setArmSwitch then
		self.setArmSwitch(on)
	end
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
