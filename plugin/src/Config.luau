--!strict
-- Keep DEFAULT_PORT in sync with the Node default (src/config.ts).
local Config = {}

Config.DEFAULT_PORT = 58741 -- boshyxd robloxstudio-mcp's port (drop-in replacement)
-- The Node bridge auto-binds the first free port in [DEFAULT_PORT, +PORT_RANGE)
-- so each terminal gets its own bridge. Seed the chip list with that whole range
-- so the user can connect to each terminal. Default seed only; the edit plugin
-- persists the live list per-user (plugin:SetSetting) so add/remove survives restarts.
Config.PORT_RANGE = 20
Config.CANDIDATE_PORTS = {}
for i = 0, Config.PORT_RANGE - 1 do
	table.insert(Config.CANDIDATE_PORTS, Config.DEFAULT_PORT + i)
end

-- Poll cadence while connected (seconds). Merged short-poll (no held requests):
-- one /poll per cycle carrying status + any command.
Config.POLL_INTERVAL = 0.25 -- legacy (runtime agent uses its own constant)
Config.POLL_IDLE = 0.5 -- normal cadence per connection
Config.POLL_ACTIVE = 0.2 -- faster for ~2s after a command, then back to idle
Config.ACTIVE_WINDOW = 2.0 -- seconds to stay on POLL_ACTIVE after a command
Config.HEARTBEAT_INTERVAL = 1.0

-- Reconnect backoff (seconds). Climb the steps, then hold at the cap
-- until a probe succeeds; reset to POLL_INTERVAL on connect.
Config.BACKOFF_STEPS = { 0.25, 0.5, 1, 2 }
Config.BACKOFF_CAP = 5

return Config
