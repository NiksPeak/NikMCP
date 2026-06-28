// Shared types across the MCP server, queue, and bridge.

export type Context = "edit" | "server";

export interface Command {
  id: string;
  type: string; // "run_luau" | "get_instance_tree" | ...
  context: Context;
  payload: unknown;
}

export interface CommandResult {
  id: string;
  ok: boolean;
  output?: string;
  result?: unknown;
  error?: string;
}
