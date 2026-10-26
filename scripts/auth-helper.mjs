#!/usr/bin/env node
/**
 * Optional, operator-run OAuth helper (never run by the MCP server or an agent).
 * Gets the FIRST refresh token for YOUR developer app and writes it to the
 * plugin's token store (mode 0600). Prints no secret values.
 *
 *   1) node scripts/auth-helper.mjs url
 *        Prints the authorize URL (auth.tesla.com) and saves a random state.
 *        Open it, sign in, approve the scopes, and copy the full redirect URL.
 *   2) node scripts/auth-helper.mjs exchange "<full redirect URL or code>"
 *        Exchanges the code at fleet-auth.prd.vn.cloud.tesla.com and saves
 *        the refresh token to the token store.
 *
 * Env (your own values; never commit them):
 *   TESLA_CLIENT_ID       required (alias: TESLA_FLEET_CLIENT_ID; primary wins)
 *   TESLA_CLIENT_SECRET   required for `exchange` (alias: TESLA_FLEET_CLIENT_SECRET)
 *   TESLA_REDIRECT_URI    required; must match a redirect URI on your app
 *   TESLA_AUTH_SCOPES     optional; default read-only:
 *                         "openid offline_access vehicle_device_data"
 *                         add vehicle_location / vehicle_cmds / vehicle_charging_cmds only if needed
 *   TESLA_FLEET_REGION    optional na|eu|cn (token audience); default na
 *   TESLA_FLEET_BASE_URL  optional explicit audience / base URL
 *   TESLA_TOKEN_STORE     optional; same default as the MCP server
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AUTHORIZE_URL = "https://auth.tesla.com/oauth2/v3/authorize";
const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const REGION_BASE_URLS = {
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  cn: "https://fleet-api.prd.cn.vn.cloud.tesla.cn",
};
const DEFAULT_SCOPES = "openid offline_access vehicle_device_data";

const unset = (v) => typeof v !== "string" || v.trim() === "" || /^\$\{[^}]*\}$/.test(v.trim());
const env = (k) => (unset(process.env[k]) ? undefined : process.env[k].trim());
const die = (msg) => {
  console.error(`auth-helper: ${msg}`);
  process.exit(1);
};
const envAlias = (k, alias) => env(k) ?? env(alias);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function storePath() {
  if (env("TESLA_TOKEN_STORE")) return env("TESLA_TOKEN_STORE");
  if (env("GROK_PLUGIN_DATA")) return path.join(env("GROK_PLUGIN_DATA"), "tokens.json");
  if (process.platform === "win32") {
    return path.join(env("LOCALAPPDATA") ?? path.join(os.homedir(), "AppData", "Local"), "grokbot-vehicle-fleet", "tokens.json");
  }
  return path.join(env("XDG_STATE_HOME") ?? path.join(os.homedir(), ".local", "state"), "grokbot-vehicle-fleet", "tokens.json");
}

function writeJson0600(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function audience() {
  const base = env("TESLA_FLEET_BASE_URL");
  if (base) return base.replace(/\/+$/, "");
  const region = (env("TESLA_FLEET_REGION") ?? "na").toLowerCase();
  if (!REGION_BASE_URLS[region]) die("TESLA_FLEET_REGION must be na, eu or cn");
  return REGION_BASE_URLS[region];
}

const statePath = () => path.join(path.dirname(storePath()), "auth-state.json");

async function cmdUrl() {
  const clientId = envAlias("TESLA_CLIENT_ID", "TESLA_FLEET_CLIENT_ID") ?? die("TESLA_CLIENT_ID (or TESLA_FLEET_CLIENT_ID) is not set");
  const redirect = env("TESLA_REDIRECT_URI") ?? die("TESLA_REDIRECT_URI is not set");
  const state = randomBytes(16).toString("hex");
  writeJson0600(statePath(), { state, created_at: new Date().toISOString() });
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("scope", env("TESLA_AUTH_SCOPES") ?? DEFAULT_SCOPES);
  u.searchParams.set("state", state);
  u.searchParams.set("prompt_missing_scopes", "true");
  console.log("Open this URL, sign in, approve, then copy the full redirect URL:\n");
  console.log(u.toString());
  console.log("\nThen run: node scripts/auth-helper.mjs exchange \"<redirect URL>\"");
}

async function cmdExchange(input) {
  if (!input) die("pass the full redirect URL (or the code)");
  const clientId = envAlias("TESLA_CLIENT_ID", "TESLA_FLEET_CLIENT_ID") ?? die("TESLA_CLIENT_ID (or TESLA_FLEET_CLIENT_ID) is not set");
  const secret = envAlias("TESLA_CLIENT_SECRET", "TESLA_FLEET_CLIENT_SECRET") ?? die("TESLA_CLIENT_SECRET (or TESLA_FLEET_CLIENT_SECRET) is not set");
  const redirect = env("TESLA_REDIRECT_URI") ?? die("TESLA_REDIRECT_URI is not set");
  let code = input.trim();
  if (/^https?:\/\//.test(code)) {
    const u = new URL(code);
    const got = u.searchParams.get("state");
    let want;
    try {
      want = JSON.parse(fs.readFileSync(statePath(), "utf8")).state;
    } catch {
      die("no saved state; run `url` first");
    }
    if (!got || got !== want) die("state mismatch; run `url` again");
    code = u.searchParams.get("code") ?? die("redirect URL has no code");
  }
  const aud = audience();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "grokbot-vehicle-fleet-auth-helper" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: secret, code, audience: aud, redirect_uri: redirect }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    die(`token exchange failed (HTTP ${res.status}${body.error ? `, ${body.error}` : ""}); an invalid_auth_code usually means the code expired`);
  }
  const file = storePath();
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const seen = new Set(prev.seen_seed_sha256 ?? []);
  if (env("TESLA_REFRESH_TOKEN")) seen.add(sha256(env("TESLA_REFRESH_TOKEN"))); // older env seed must not override this token
  if (prev.refresh_token) seen.add(sha256(prev.refresh_token));
  writeJson0600(file, {
    ...prev,
    version: 1,
    refresh_token: body.refresh_token,
    refresh_issued_at: new Date().toISOString(),
    seen_seed_sha256: [...seen].slice(-20),
    base_url: aud,
    needs_reauth: false,
    updated_at: new Date().toISOString(),
  });
  fs.rmSync(statePath(), { force: true });
  console.log(`Saved a new refresh token to ${file} (mode 0600; value not printed).`);
  console.log("You can leave TESLA_REFRESH_TOKEN unset. Reload the MCP server to use it.");
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "url") await cmdUrl();
else if (cmd === "exchange") await cmdExchange(arg);
else {
  console.log("usage: node scripts/auth-helper.mjs url | exchange \"<redirect URL or code>\"");
  process.exit(cmd ? 1 : 0);
}
