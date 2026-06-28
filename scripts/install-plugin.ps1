# Build the Studio plugin .rbxmx straight into the local Roblox Plugins folder.
# Requires Rojo: https://rojo.space
$ErrorActionPreference = "Stop"
$pluginsDir = Join-Path $env:LOCALAPPDATA "Roblox\Plugins"
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
rojo build plugin/plugin.project.json -o (Join-Path $pluginsDir "RobloxStudioMCP.rbxmx")
Write-Host "Built -> $pluginsDir\RobloxStudioMCP.rbxmx"
Write-Host "Restart Studio (or reopen the place) to load the 'Studio MCP' toolbar."
