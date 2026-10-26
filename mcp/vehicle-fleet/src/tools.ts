/**
 * Tool registry for the single vehicle-fleet MCP server.
 * - read tools: always listed
 * - location tools: listed only with TESLA_FLEET_ENABLE_LOCATION on
 * - command tools: listed only when read-only is explicitly off (fail closed)
 * Hidden tools are also refused at call time.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { COMMAND_TOOLS } from "./tools/commands.js";
import { READ_TOOLS } from "./tools/read.js";
import type { ToolDef } from "./tools/types.js";

export const ALL_TOOL_DEFS: ToolDef[] = [...READ_TOOLS, ...COMMAND_TOOLS];

export const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set(COMMAND_TOOLS.map((t) => t.tool.name));
export const LOCATION_TOOL_NAMES: ReadonlySet<string> = new Set(
  READ_TOOLS.filter((t) => t.kind === "location").map((t) => t.tool.name),
);

export type ToolMode = { readOnly: boolean; locationEnabled: boolean };

export function isVisible(def: ToolDef, mode: ToolMode): boolean {
  if (def.kind === "command") return !mode.readOnly;
  if (def.kind === "location") return mode.locationEnabled;
  return true;
}

export function listTools(mode: ToolMode): Tool[] {
  return ALL_TOOL_DEFS.filter((d) => isVisible(d, mode)).map((d) => d.tool);
}

export function findTool(name: string): ToolDef | undefined {
  return ALL_TOOL_DEFS.find((d) => d.tool.name === name);
}
