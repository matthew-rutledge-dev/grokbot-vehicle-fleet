/**
 * vehicle-fleet MCP: one stdio server.
 * Reads: cached-first, never wake the vehicle. Commands: hidden unless
 * TESLA_FLEET_READ_ONLY is explicitly off; each needs confirm=true (dry-run
 * otherwise) and is signed by the installer's own tesla-http-proxy.
 * Credentials come only from env / the local token store; nothing is hardcoded.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AuditLog } from "./audit.js";
import { TokenManager } from "./auth.js";
import { KeepFresh, type Scheduler } from "./tokenexport.js";
import { ENV, loadConfig, type Config } from "./config.js";
import type { ToolContext } from "./context.js";
import { readEnv, type Env } from "./env.js";
import { FleetApiError, LocalRefusal } from "./errors.js";
import { FleetClient, type FleetClientOptions } from "./fleet.js";
import { Http, type FetchLike } from "./http.js";
import { RateLimiter } from "./ratelimit.js";
import { READ_ONLY_ENV } from "./readonly.js";
import { redactSecrets, redactShortSecrets } from "./redact.js";
import { redactableValetPin } from "./tools/valet.js";
import { jsonResult } from "./result.js";
import { TokenStore } from "./tokenstore.js";
import { findTool, isVisible, listTools, optInOn } from "./tools.js";
import { ENV_LOCATION_NAME } from "./tools/names.js";
import { UsageTracker, usagePathFor } from "./usage.js";
import { SERVER_NAME, VERSION } from "./version.js";

export type ServerDeps = {
  env?: Env;
  config?: Config;
  fetchImpl?: FetchLike;
  fleetOptions?: FleetClientOptions;
  /** Clock for the usage counter (tests). */
  now?: () => number;
};

export function buildContext(deps: ServerDeps = {}): ToolContext {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig(env);
  const usage = new UsageTracker(usagePathFor(config.tokenStorePath), deps.now);
  const http = new Http(deps.fetchImpl, usage);
  const limiter = new RateLimiter();
  const tokens = new TokenManager(config, new TokenStore(config.tokenStorePath), http, limiter);
  const fleet = new FleetClient(config, http, tokens, limiter, deps.fleetOptions);
  return { config, fleet, tokens, env, usage, audit: new AuditLog(config.auditLogPath, deps.now) };
}

/**
 * Opt-in export: keep the exported access token fresh while this process runs (no-op when
 * TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE is unset). The timer is unref'd.
 */
export function startTokenKeepFresh(ctx: ToolContext, deps: { now?: () => number; scheduler?: Scheduler; warn?: (m: string) => void } = {}): KeepFresh | undefined {
  if (!ctx.tokens.exportEnabled) return undefined;
  const k = new KeepFresh(ctx.tokens, deps.now, deps.scheduler, deps.warn);
  void k.start();
  return k;
}

export function createServer(ctx: ToolContext): Server {
  const mode = {
    readOnly: ctx.config.readOnly.readOnly, locationEnabled: ctx.config.locationEnabled, nhtsaEnabled: ctx.config.nhtsaEnabled,
    valetEnabled: ctx.config.valetEnabled, experimentalEnabled: ctx.config.experimentalEnabled,
  };
  // TESLA_FLEET_VALET_PIN is read at call time (never stored); it is short, so it also goes
  // through redactShortSecrets. A command's request can be echoed back by the proxy (400 body,
  // result:false reason), so every command result and every error body is scrubbed.
  const valetPin = () => readEnv(ENV.VALET_PIN, ctx.env);
  const secrets = () => [ctx.config.refreshTokenSeed, ...ctx.tokens.secretValues(), valetPin()];
  // Only a well-formed 4-digit PIN is registered as a short secret (a malformed one is never sent).
  const scrub = (body: unknown) =>
    redactShortSecrets(JSON.parse(redactSecrets(JSON.stringify(body), secrets())), [redactableValetPin(valetPin())]);
  const server = new Server({ name: SERVER_NAME, version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools(mode) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const def = findTool(name);
    if (!def) return jsonResult({ ok: false, error: `Unknown tool: ${name}` }, true);
    if (!isVisible(def, mode)) {
      if (def.kind === "command" && !mode.readOnly && !optInOn(def, mode)) {
        const flag = def.optIn === "valet" ? "TESLA_FLEET_ENABLE_VALET" : "TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS";
        return jsonResult({
          ok: false, optInRequired: flag, sent: false,
          error: `Refused: ${name} is an opt-in command and ${flag} is not on. Nothing was sent.`,
        }, true);
      }
      if (def.kind === "command") {
        return jsonResult({
          ok: false, readOnly: true, sent: false,
          error: `Refused: ${name} is a command tool and the server is read-only (${READ_ONLY_ENV} not explicitly off). Nothing was sent.`,
        }, true);
      }
      if (def.nhtsa) {
        return jsonResult({
          ok: false, nhtsaEnabled: false, sent: false,
          error: `Refused: ${name} is turned off (TESLA_FLEET_DISABLE_NHTSA is on or an unrecognised value). Nothing was sent.`,
        }, true);
      }
      return jsonResult({
        ok: false, locationEnabled: false,
        error: `Refused: ${name} is turned off (${ENV_LOCATION_NAME} is set to off or an unrecognised value). Nothing was read.`,
      }, true);
    }
    try {
      const out = await def.handler(args, ctx);
      return jsonResult(def.kind === "command" ? scrub(out) : out);
    } catch (err) {
      let body: Record<string, unknown>;
      if (err instanceof LocalRefusal) {
        body = { ok: false, sent: false, code: err.code, error: err.message, hint: err.hint, ...(err.extra ?? {}) };
      } else if (err instanceof FleetApiError) {
        body = { ok: false, ...err.info, error: err.info.message };
      } else {
        body = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      return { ...jsonResult(scrub(body), true) };
    }
  });

  return server;
}

