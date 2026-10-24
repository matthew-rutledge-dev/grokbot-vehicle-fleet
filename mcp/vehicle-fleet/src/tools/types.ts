import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolArgs, ToolContext } from "../context.js";

/** read = always listed; location = listed only with TESLA_FLEET_ENABLE_LOCATION on; command = hidden in read-only mode. */
export type ToolKind = "read" | "location" | "command";

export type ToolDef = {
  tool: Tool;
  kind: ToolKind;
  handler: (args: ToolArgs, ctx: ToolContext) => Promise<Record<string, unknown>>;
};
