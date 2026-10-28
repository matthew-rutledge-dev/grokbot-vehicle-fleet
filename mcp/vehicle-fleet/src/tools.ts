/**
 * Tool registry for the single vehicle-fleet MCP server.
 * - read tools: always listed
 * - location tools: listed unless TESLA_FLEET_ENABLE_LOCATION is off (default on)
 * - command tools: listed only when read-only is explicitly off (fail closed)
 * - NHTSA tools (get_recalls): listed unless TESLA_FLEET_DISABLE_NHTSA is on
 * Hidden tools are also refused at call time.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { VEHICLE_COMMAND_TOOLS } from "./tools/commands.js";
import { ENERGY_COMMAND_TOOLS } from "./tools/energy-commands.js";
import { ENERGY_TOOLS } from "./tools/energy.js";
import { OWNERSHIP_TOOLS } from "./tools/ownership.js";
import { READ_TOOLS } from "./tools/read.js";
import { PLAY_VIDEO } from "./tools/video.js";
import type { ToolDef } from "./tools/types.js";

export const COMMAND_TOOLS: ToolDef[] = [...VEHICLE_COMMAND_TOOLS, ...ENERGY_COMMAND_TOOLS, PLAY_VIDEO];
export const ALL_TOOL_DEFS: ToolDef[] = [...READ_TOOLS, ...OWNERSHIP_TOOLS, ...ENERGY_TOOLS, ...COMMAND_TOOLS];

export const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set(COMMAND_TOOLS.map((t) => t.tool.name));
export const LOCATION_TOOL_NAMES: ReadonlySet<string> = new Set(
  READ_TOOLS.filter((t) => t.kind === "location").map((t) => t.tool.name),
);

export type ToolMode = { readOnly: boolean; locationEnabled: boolean; nhtsaEnabled?: boolean };

export function isVisible(def: ToolDef, mode: ToolMode): boolean {
  if (def.nhtsa && mode.nhtsaEnabled === false) return false;
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
