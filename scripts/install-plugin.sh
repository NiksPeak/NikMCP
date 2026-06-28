#!/usr/bin/env bash
# Build the Studio plugin .rbxmx straight into the local Roblox Plugins folder.
# Requires Rojo: https://rojo.space
set -euo pipefail

PLUGINS_DIR="$HOME/Documents/Roblox/Plugins"
mkdir -p "$PLUGINS_DIR"
rojo build plugin/plugin.project.json -o "$PLUGINS_DIR/RobloxStudioMCP.rbxmx"
echo "Built -> $PLUGINS_DIR/RobloxStudioMCP.rbxmx"
echo "Restart Studio (or reopen the place) to load the 'Studio MCP' toolbar."
