#!/usr/bin/env node
/** vehicle-fleet MCP entry point (stdio). See server.ts. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildContext, createServer } from "./server.js";

async function main() {
  const ctx = buildContext();
  for (const w of ctx.config.warnings) console.error(w);
  await createServer(ctx).connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
