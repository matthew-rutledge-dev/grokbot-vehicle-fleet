/**
 * 0.7.4: the off-grid reserve 55 s budget also covers token refresh and the one
 * 401 retry, so a confirmed call cannot run past a 60 s MCP client timeout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { OFF_GRID_TOTAL_BUDGET_MS } from "../src/tools/energy-commands.js";
import { ENERGY_COMMAND_TIMEOUT_MS } from "../src/fleet.js";
import { HTTP_DEFAULT_TIMEOUT_MS, type FetchLike } from "../src/http.js";
import { buildContext } from "../src/server.js";
import { AUTH, BASE, baseEnv, body, connect, fakeFetch, isError, routes } from "./helpers.js";
import type { Call, Route } from "./helpers.js";

const intent = { confirm: true, user_request: "please do it" };
const SITE = "1234567890";
const FIELD = "off_grid_vehicle_charging_reserve_percent";
const TOOL = "set_off_grid_vehicle_charging_reserve";
const INFO = `GET ${BASE}/api/1/energy_sites/${SITE}/site_info`;
const POST = `POST ${BASE}/api/1/energy_sites/${SITE}/off_grid_vehicle_charging_reserve`;
const AUTH_POST = `POST ${AUTH}/oauth2/v3/token`;
const EON = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_ENERGY_SITE_ID: SITE };
const CLIENT_TIMEOUT_MS = 60_000;
const posts = (calls: Call[]) => calls.filter((x) => x.method === "POST" && x.url.endsWith("/off_grid_vehicle_charging_reserve"));
const auths = (calls: Call[]) => calls.filter((x) => x.url.includes("/oauth2/v3/token"));
const rawInfo = (valueJson: string) => ({ status: 200, body: `{"response":{"${FIELD}":${valueJson}}}` });

/**
 * Like the 0.7.3 slow-world harness, plus a timed token refresh and an optional
 * POST sequence. Every fake HTTP step honours the timeoutMs the server passed
 * (the same cap AbortSignal.timeout would apply).
 */
function slowWorld(opts: {
  info: (n: number) => { status: number; body: unknown };
  readMs: (n: number) => number;
  postMs: number;
  authMs?: number;
  post?: (n: number) => { status: number; body: unknown };
  env?: Record<string, string>;
}) {
  let now = 1_000_000;
  const start = now;
  let lastTimeout: number | undefined;
  const consume = (ms: number) => {
    now += Math.min(ms, lastTimeout ?? HTTP_DEFAULT_TIMEOUT_MS);
  };
  let refresh = 0;
  const r: Record<string, Route> = {
    [AUTH_POST]: () => {
      consume(opts.authMs ?? 0);
      refresh++;
      return { status: 200, body: { access_token: `access-EXAMPLE-${refresh}`, refresh_token: `rotated-EXAMPLE-${refresh}`, expires_in: 28800 } };
    },
    [INFO]: (_c, n) => { consume(opts.readMs(n)); return opts.info(n); },
    [POST]: (_c, n) => { consume(opts.postMs); return opts.post ? opts.post(n) : { status: 200, body: {} }; },
  };
  const f = fakeFetch(routes(r));
  const impl: FetchLike = async (url, init) => {
    if (typeof init.timeoutMs === "number") lastTimeout = init.timeoutMs;
    return f.impl(url, init);
  };
  const ctx = buildContext({
    env: baseEnv(opts.env ?? EON), fetchImpl: impl,
    fleetOptions: { sleep: async (ms) => { now += ms; }, now: () => now },
  });
  return { ctx, calls: f.calls, elapsed: () => now - start };
}

test("off-grid budget: a slow token refresh and a 401 retry would have exceeded 60 s; the deadline skips the retry", async () => {
  const { ctx, calls, elapsed } = slowWorld({
    info: () => rawInfo("95"),
    readMs: () => 60_000,
    postMs: ENERGY_COMMAND_TIMEOUT_MS,
    authMs: HTTP_DEFAULT_TIMEOUT_MS,
    post: (n) => (n === 1 ? { status: 401, body: {} } : { status: 200, body: {} }),
  });
  const res = await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } });
  assert.equal(isError(res), true);
  assert.equal(body(res).code, "unauthorized");
  assert.equal(posts(calls).length, 1, "401 retry must not start once the budget is spent");
  assert.equal(auths(calls).length, 1, "no second refresh for a retry that was not started");
  assert.ok(elapsed() <= OFF_GRID_TOTAL_BUDGET_MS, `took ${elapsed()} ms`);
  assert.ok(elapsed() < CLIENT_TIMEOUT_MS);
});

test("off-grid budget: a 401 retry still runs when time remains, and the whole call stays inside the budget", async () => {
  const { ctx, calls, elapsed } = slowWorld({
    info: () => rawInfo("95"),
    readMs: () => 200,
    postMs: 3_000,
    authMs: 2_000,
    post: (n) => (n === 1 ? { status: 401, body: {} } : { status: 200, body: {} }),
  });
  const res = await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } });
  assert.equal(isError(res), false);
  const b = body(res);
  assert.equal(b.ok, true);
  assert.equal(b.sent, true);
  assert.equal(posts(calls).length, 2);
  assert.equal(auths(calls).length, 2);
  assert.ok(elapsed() <= OFF_GRID_TOTAL_BUDGET_MS, `took ${elapsed()} ms`);
});
