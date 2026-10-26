import type { TokenManager } from "./auth.js";
import type { Config } from "./config.js";
import type { FleetClient } from "./fleet.js";
import type { Env } from "./env.js";
import type { UsageTracker } from "./usage.js";

export type ToolContext = {
  config: Config;
  fleet: FleetClient;
  tokens: TokenManager;
  env: Env;
  usage: UsageTracker;
};

export type ToolArgs = Record<string, unknown>;
