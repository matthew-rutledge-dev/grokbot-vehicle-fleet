#!/usr/bin/env node
/** vehicle-fleet MCP entry point (stdio). See server.ts. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolContext } from "./context.js";
import { redactSecrets } from "./redact.js";
import { buildContext, createServer, startTokenKeepFresh } from "./server.js";

let ctx: ToolContext | undefined;

/** Every secret known at this point; ctx may be unset if startup failed early. */
function secrets(): Array<string | undefined> {
  const out: Array<string | undefined> = [
    process.env.TESLA_REFRESH_TOKEN, process.env.TESLA_CLIENT_SECRET, process.env.TESLA_FLEET_CLIENT_SECRET,
  ];
  if (ctx) out.push(ctx.config.refreshTokenSeed, ...ctx.tokens.secretValues());
  return out;
}

function logErr(text: string): void {
  console.error(redactSecrets(text, secrets()));
}

async function main() {
  ctx = buildContext();
  for (const w of ctx.config.warnings) logErr(w);
  await createServer(ctx).connect(new StdioServerTransport());
  // Opt-in access-token export only; nothing is scheduled when it is off.
  startTokenKeepFresh(ctx, { warn: logErr });
}

main().catch((err) => {
  logErr(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
