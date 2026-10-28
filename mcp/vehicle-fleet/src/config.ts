/**
 * One frozen Config built from env at start. Every value is installer config;
 * nothing is hardcoded except Tesla's documented public endpoints.
 */
import os from "node:os";
import path from "node:path";
import { resolveExportPath } from "./tokenexport.js";
import { OFF_VALUES, ON_VALUES, readEnv, readOptInFlag, type Env } from "./env.js";
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
  CLIENT_ID_ALIAS: "TESLA_FLEET_CLIENT_ID",
  REFRESH_TOKEN: "TESLA_REFRESH_TOKEN",
  REGION: "TESLA_FLEET_REGION",
  BASE_URL: "TESLA_FLEET_BASE_URL",
  AUTH_BASE_URL: "TESLA_FLEET_AUTH_BASE_URL",
  PROXY_URL: "TESLA_COMMAND_PROXY_URL",
  PROXY_URL_ALIAS: "TESLA_FLEET_PROXY_URL",
  PROXY_CA_CERT: "TESLA_COMMAND_PROXY_CA_CERT",
  PROXY_CA_CERT_ALIAS: "TESLA_FLEET_PROXY_CA_FILE",
  TOKEN_STORE: "TESLA_TOKEN_STORE",
  ACCESS_TOKEN_EXPORT_FILE: "TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE",
  READ_ONLY: READ_ONLY_ENV,
  ENABLE_LOCATION: "TESLA_FLEET_ENABLE_LOCATION",
  DISABLE_NHTSA: "TESLA_FLEET_DISABLE_NHTSA",
  LOCATION_PRECISION: "TESLA_FLEET_DEFAULT_LOCATION_PRECISION",
  DEFAULT_VIN: "TESLA_DEFAULT_VIN",
  DEFAULT_ENERGY_SITE: "TESLA_DEFAULT_ENERGY_SITE_ID",
  DRY_RUN: "TESLA_FLEET_DRY_RUN",
  CLIMATE_TEMP_C: "TESLA_FLEET_DEFAULT_CLIMATE_TEMP_C",
  CLIMATE_SEAT_LEVEL: "TESLA_FLEET_DEFAULT_SEAT_HEAT_LEVEL",
  CLIMATE_SEATS: "TESLA_FLEET_DEFAULT_HEATED_SEATS",
  CLIMATE_COLD_BELOW_C: "TESLA_FLEET_COLD_OUTSIDE_BELOW_C",
  CLIMATE_DEFROST_BELOW_C: "TESLA_FLEET_DEFROST_OUTSIDE_BELOW_C",
  CLIMATE_WHEEL_WHEN_COLD: "TESLA_FLEET_STEERING_WHEEL_HEAT_WHEN_COLD",
  KEY_DOMAIN: "TESLA_FLEET_KEY_DOMAIN",
  RATE_DATA: "TESLA_FLEET_RATE_DATA_PER_USD",
  RATE_COMMANDS: "TESLA_FLEET_RATE_COMMANDS_PER_USD",
  RATE_WAKES: "TESLA_FLEET_RATE_WAKES_PER_USD",
  MONTHLY_DISCOUNT: "TESLA_FLEET_MONTHLY_DISCOUNT_USD",
} as const;

/** Defaults for the climate_warm_up preset (all overridable per call). */
export type ClimateDefaults = {
  tempC: number;
  /** Seat heater level 0-3 used when it is cold outside. */
  seatLevel: number;
  /** Which seats get heat when cold. */
  seats: "driver" | "front" | "none";
  /** Outside temperature (C) below which seats / wheel heat are added. */
  coldBelowC: number;
  /** Outside temperature (C) below which max defrost is turned on. */
  defrostBelowC: number;
  wheelWhenCold: boolean;
};

export const DEFAULT_CLIMATE: ClimateDefaults = Object.freeze({
  tempC: 21, seatLevel: 2, seats: "driver", coldBelowC: 5, defrostBelowC: -2, wheelWhenCold: true,
});

/**
 * Location is on by default (the server runs for its owner). Unset = on; on values = on;
 * off values = off. An unrecognised value = OFF with a warning: setting the variable at all
 * signals an intent to change the default (most likely an opt-out such as "disabled"),
 * and a wrong guess toward "on" would expose location, while "off" only hides one read.
 */
function resolveLocation(env: Env, warnings: string[]): boolean {
  const v = readEnv(ENV.ENABLE_LOCATION, env);
  if (v === undefined) return true;
  const l = v.toLowerCase();
  if (ON_VALUES.includes(l)) return true;
  if (OFF_VALUES.includes(l)) return false;
  warnings.push(`${ENV.ENABLE_LOCATION} has an unrecognised value; location is OFF. Use 1/true/on or 0/false/off.`);
  return false;
}

/** NHTSA is on by default; 1/true/yes/on disables it. An unrecognised value disables it too (fails closed). */
function resolveNhtsa(env: Env, warnings: string[]): boolean {
  const v = readEnv(ENV.DISABLE_NHTSA, env);
  if (v === undefined) return true;
  const l = v.toLowerCase();
  if (ON_VALUES.includes(l)) return false;
  if (OFF_VALUES.includes(l)) return true;
  warnings.push(`${ENV.DISABLE_NHTSA} has an unrecognised value; NHTSA recalls (get_recalls) are OFF. Use 1/true/on to disable or 0/false/off to keep them.`);
  return false;
}

function resolveLocationPrecision(env: Env, warnings: string[]): "coarse" | "precise" {
  const v = readEnv(ENV.LOCATION_PRECISION, env)?.toLowerCase();
  if (v === undefined || v === "coarse") return "coarse";
  if (v === "precise") return "precise";
  warnings.push(`${ENV.LOCATION_PRECISION} must be coarse or precise; using coarse.`);
  return "coarse";
}

/** TESLA_FLEET_DRY_RUN fails closed: unset/off values = off, on values = on, anything else = on + warning. */
function resolveDryRun(env: Env, warnings: string[]): boolean {
  const v = readEnv(ENV.DRY_RUN, env);
  if (v === undefined) return false;
  const l = v.toLowerCase();
  if (OFF_VALUES.includes(l)) return false;
  if (ON_VALUES.includes(l)) return true;
  warnings.push(`${ENV.DRY_RUN} has an unrecognised value; dry-run mode is ON (nothing will be sent). Use 1/true/on or 0/false/off.`);
  return true;
}

function loadClimate(env: Env, warnings: string[]): ClimateDefaults {
  const n = (name: string, fallback: number, min: number, max: number, int = false): number => {
    const raw = readEnv(name, env);
    if (raw === undefined) return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
      warnings.push(`${name} must be ${int ? "an integer" : "a number"} from ${min} to ${max}; using the default ${fallback}.`);
      return fallback;
    }
    return v;
  };
  const seatsRaw = readEnv(ENV.CLIMATE_SEATS, env)?.toLowerCase();
  let seats = DEFAULT_CLIMATE.seats;
  if (seatsRaw !== undefined) {
    if (seatsRaw === "driver" || seatsRaw === "front" || seatsRaw === "none") seats = seatsRaw;
    else warnings.push(`${ENV.CLIMATE_SEATS} must be driver, front or none; using the default ${seats}.`);
  }
  const wheelRaw = readEnv(ENV.CLIMATE_WHEEL_WHEN_COLD, env);
  return Object.freeze({
    tempC: n(ENV.CLIMATE_TEMP_C, DEFAULT_CLIMATE.tempC, 15, 28),
    seatLevel: n(ENV.CLIMATE_SEAT_LEVEL, DEFAULT_CLIMATE.seatLevel, 0, 3, true),
    seats,
    coldBelowC: n(ENV.CLIMATE_COLD_BELOW_C, DEFAULT_CLIMATE.coldBelowC, -40, 30),
    defrostBelowC: n(ENV.CLIMATE_DEFROST_BELOW_C, DEFAULT_CLIMATE.defrostBelowC, -40, 30),
    wheelWhenCold: wheelRaw === undefined ? DEFAULT_CLIMATE.wheelWhenCold : readOptInFlag(ENV.CLIMATE_WHEEL_WHEN_COLD, env),
  });
}

export type Config = {
  clientId?: string;
  refreshTokenSeed?: string;
  region?: string;
  baseUrl?: string;
  authBaseUrl: string;
  proxyUrl?: string;
  proxyCaCertPath?: string;
  tokenStorePath: string;
  /** Opt-in: file the current access token is exported to (absolute; undefined = off). */
  accessTokenExportPath?: string;
  readOnly: ReadOnlyResolution;
  /** get_location listed: on unless TESLA_FLEET_ENABLE_LOCATION is off (or unrecognised). */
  locationEnabled: boolean;
  /** get_recalls (public NHTSA API) listed: on unless TESLA_FLEET_DISABLE_NHTSA is on (or unrecognised). */
  nhtsaEnabled: boolean;
  /** get_location precision when the call does not pass one (default coarse). */
  locationPrecision: "coarse" | "precise";
  defaultVin?: string;
  /** Optional default energy_site_id for energy reads. */
  defaultEnergySiteId?: string;
  /** TESLA_FLEET_DRY_RUN on: confirmed commands are validated and returned, never sent. */
  dryRun: boolean;
  climate: ClimateDefaults;
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

/**
 * Primary name wins; the alias is read only when the primary is unset.
 * Aliases let an existing env loader (TESLA_FLEET_*) feed the plugin unchanged.
 */
export function readEnvWithAlias(primary: string, alias: string, env: Env = process.env): string | undefined {
  return readEnv(primary, env) ?? readEnv(alias, env);
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
  const rawProxy = readEnvWithAlias(ENV.PROXY_URL, ENV.PROXY_URL_ALIAS, env);
  if (rawProxy) {
    const c = checkUrl(ENV.PROXY_URL, rawProxy);
    if (c.problem) problems.push(c.problem);
    if (c.warning) warnings.push(c.warning);
    proxyUrl = c.url;
  }

  const rates = Object.freeze(loadRates(env, warnings));

  const tokenStorePath = readEnv(ENV.TOKEN_STORE, env) ?? defaultTokenStorePath(env);
  const tokenExport = resolveExportPath(readEnv(ENV.ACCESS_TOKEN_EXPORT_FILE, env), tokenStorePath);
  if (tokenExport.warning) warnings.push(tokenExport.warning);

  const clientId = readEnvWithAlias(ENV.CLIENT_ID, ENV.CLIENT_ID_ALIAS, env);
  if (!clientId) problems.push(`${ENV.CLIENT_ID} (or ${ENV.CLIENT_ID_ALIAS}) is not set`);

  return Object.freeze({
    clientId,
    refreshTokenSeed: readEnv(ENV.REFRESH_TOKEN, env),
    region,
    baseUrl,
    authBaseUrl,
    proxyUrl,
    proxyCaCertPath: readEnvWithAlias(ENV.PROXY_CA_CERT, ENV.PROXY_CA_CERT_ALIAS, env),
    tokenStorePath,
    accessTokenExportPath: tokenExport.path,
    readOnly,
    locationEnabled: resolveLocation(env, warnings),
    locationPrecision: resolveLocationPrecision(env, warnings),
    nhtsaEnabled: resolveNhtsa(env, warnings),
    defaultVin: readEnv(ENV.DEFAULT_VIN, env),
    defaultEnergySiteId: readEnv(ENV.DEFAULT_ENERGY_SITE, env),
    dryRun: resolveDryRun(env, warnings),
    climate: loadClimate(env, warnings),
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
