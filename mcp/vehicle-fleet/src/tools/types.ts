import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolArgs, ToolContext } from "../context.js";

/** read = always listed; location = listed unless TESLA_FLEET_ENABLE_LOCATION is off; command = hidden in read-only mode. */
export type ToolKind = "read" | "location" | "command";

export type ToolDef = {
  tool: Tool;
  kind: ToolKind;
  /** Calls the public NHTSA API: hidden and refused when TESLA_FLEET_DISABLE_NHTSA is on. */
  nhtsa?: boolean;
  handler: (args: ToolArgs, ctx: ToolContext) => Promise<Record<string, unknown>>;
};
