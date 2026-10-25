/**
 * One frozen Config built from env at start. Every value is installer config;
 * nothing is hardcoded except Tesla's documented public endpoints.
 */
import os from "node:os";
import path from "node:path";
import { readEnv, readOptInFlag, type Env } from "./env.js";
import { resolveReadOnly, READ_ONLY_ENV, type ReadOnlyResolution } from "./readonly.js";
import { DEFAULT_RATES, type Rates } from "./usage.js";

/** Documented regional Fleet API base URLs (developer.tesla.com, Regions and Countries). */
export const REGION_BASE_URLS: Record<string, string> = {
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  cn: "https://fleet-api.prd.cn.vn.cloud.tesla.cn",
};

/** Documented token host for /oauth2/v3/token (Third-Party Tokens page). */
export const DEFAULT_AUTH_BASE_URL = "https://fleet-auth.prd.vn.cloud.tesla.com";

export const ENV = {
  CLIENT_ID: "TESLA_CLIENT_ID",
  REFRESH_TOKEN: "TESLA_REFRESH_TOKEN",
  REGION: "TESLA_FLEET_REGION",
  BASE_URL: "TESLA_FLEET_BASE_URL",
  AUTH_BASE_URL: "TESLA_FLEET_AUTH_BASE_URL",
  PROXY_URL: "TESLA_COMMAND_PROXY_URL",
  PROXY_CA_CERT: "TESLA_COMMAND_PROXY_CA_CERT",
  TOKEN_STORE: "TESLA_TOKEN_STORE",
  READ_ONLY: READ_ONLY_ENV,
  ENABLE_LOCATION: "TESLA_FLEET_ENABLE_LOCATION",
  DEFAULT_VIN: "TESLA_DEFAULT_VIN",
  KEY_DOMAIN: "TESLA_FLEET_KEY_DOMAIN",
  RATE_DATA: "TESLA_FLEET_RATE_DATA_PER_USD",
  RATE_COMMANDS: "TESLA_FLEET_RATE_COMMANDS_PER_USD",
  RATE_WAKES: "TESLA_FLEET_RATE_WAKES_PER_USD",
  MONTHLY_DISCOUNT: "TESLA_FLEET_MONTHLY_DISCOUNT_USD",
} as const;

export type Config = {
  clientId?: string;
  refreshTokenSeed?: string;
  region?: string;
  baseUrl?: string;
  authBaseUrl: string;
  proxyUrl?: string;
  proxyCaCertPath?: string;
  tokenStorePath: string;
  readOnly: ReadOnlyResolution;
  locationEnabled: boolean;
  defaultVin?: string;
  keyDomain?: string;
  /** Rates for the local usage estimate (get_api_usage). */
  rates: Rates;
  /** Config problems found at start (no secret values). */
  problems: string[];
  /** Non-fatal warnings for stderr (no secret values). */
  warnings: string[];
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** https always; plain http only for loopback hosts (local proxy / tests). */
export function checkUrl(name: string, value: string): { url?: string; problem?: string; warning?: string } {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { problem: `${name} is not a valid URL` };
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol === "https:") return { url: value.replace(/\/+$/, "") };
  if (u.protocol === "http:" && LOOPBACK.has(host)) {
    return {
      url: value.replace(/\/+$/, ""),
      warning: `${name} uses plain http on a loopback host; use https outside local testing.`,
    };
  }
  return { problem: `${name} must use https (plain http is allowed only for loopback hosts)` };
}

export function defaultTokenStorePath(env: Env = process.env): string {
  const pluginData = readEnv("GROK_PLUGIN_DATA", env);
  if (pluginData) return path.join(pluginData, "tokens.json");
  if (process.platform === "win32") {
    const base = readEnv("LOCALAPPDATA", env) ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "grokbot-vehicle-fleet", "tokens.json");
  }
  const xdg = readEnv("XDG_STATE_HOME", env) ?? path.join(os.homedir(), ".local", "state");
  return path.join(xdg, "grokbot-vehicle-fleet", "tokens.json");
}

/** Positive number (or >= 0 when allowZero) from env; otherwise the default plus a warning. */
function readNumber(name: string, fallback: number, env: Env, warnings: string[], allowZero = false): number {
  const raw = readEnv(name, env);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    warnings.push(`${name} must be a ${allowZero ? "non-negative" : "positive"} number; using the default ${fallback}.`);
    return fallback;
  }
  return n;
}

export function loadRates(env: Env, warnings: string[]): Rates {
  return {
    dataPerUsd: readNumber(ENV.RATE_DATA, DEFAULT_RATES.dataPerUsd, env, warnings),
    commandsPerUsd: readNumber(ENV.RATE_COMMANDS, DEFAULT_RATES.commandsPerUsd, env, warnings),
    wakesPerUsd: readNumber(ENV.RATE_WAKES, DEFAULT_RATES.wakesPerUsd, env, warnings),
    monthlyDiscountUsd: readNumber(ENV.MONTHLY_DISCOUNT, DEFAULT_RATES.monthlyDiscountUsd, env, warnings, true),
  };
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const warnings: string[] = [];
  const readOnly = resolveReadOnly(env[ENV.READ_ONLY]);
  if (readOnly.warning) warnings.push(readOnly.warning);

  let region = readEnv(ENV.REGION, env)?.toLowerCase();
  if (region && !REGION_BASE_URLS[region]) {
    problems.push(`${ENV.REGION} must be one of na, eu, cn`);
    region = undefined;
  }

  let baseUrl: string | undefined;
  const rawBase = readEnv(ENV.BASE_URL, env);
  if (rawBase) {
    const c = checkUrl(ENV.BASE_URL, rawBase);
    if (c.problem) problems.push(c.problem);
    if (c.warning) warnings.push(c.warning);
    baseUrl = c.url;
  } else if (region) {
    baseUrl = REGION_BASE_URLS[region];
  }

  let authBaseUrl = DEFAULT_AUTH_BASE_URL;
  const rawAuth = readEnv(ENV.AUTH_BASE_URL, env);
  if (rawAuth) {
    const c = checkUrl(ENV.AUTH_BASE_URL, rawAuth);
    if (c.problem) problems.push(c.problem);
    if (c.warning) warnings.push(c.warning);
    if (c.url) authBaseUrl = c.url;
  }

  let proxyUrl: string | undefined;
  const rawProxy = readEnv(ENV.PROXY_URL, env);
  if (rawProxy) {
    const c = checkUrl(ENV.PROXY_URL, rawProxy);
    if (c.problem) problems.push(c.problem);
    if (c.warning) warnings.push(c.warning);
    proxyUrl = c.url;
  }

  const rates = Object.freeze(loadRates(env, warnings));

  const clientId = readEnv(ENV.CLIENT_ID, env);
  if (!clientId) problems.push(`${ENV.CLIENT_ID} is not set`);

  return Object.freeze({
    clientId,
    refreshTokenSeed: readEnv(ENV.REFRESH_TOKEN, env),
    region,
    baseUrl,
    authBaseUrl,
    proxyUrl,
    proxyCaCertPath: readEnv(ENV.PROXY_CA_CERT, env),
    tokenStorePath: readEnv(ENV.TOKEN_STORE, env) ?? defaultTokenStorePath(env),
    readOnly,
    locationEnabled: readOptInFlag(ENV.ENABLE_LOCATION, env),
    defaultVin: readEnv(ENV.DEFAULT_VIN, env),
    keyDomain: readEnv(ENV.KEY_DOMAIN, env),
    rates,
    problems,
    warnings,
  });
}

/** set/missing map for describe_boundary. Never values. */
export function configPresence(env: Env = process.env): Record<string, "set" | "missing"> {
  const out: Record<string, "set" | "missing"> = {};
  for (const name of Object.values(ENV)) out[name] = readEnv(name, env) ? "set" : "missing";
  return out;
}
