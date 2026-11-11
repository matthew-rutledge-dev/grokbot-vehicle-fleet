/**
 * 0.7.5: follow-ups on the off-grid deadline — refresh can exhaust the budget
 * with nothing sent, the default clock is monotonic, and other call() paths
 * accept an optional deadline without changing their default behaviour.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { OFF_GRID_TOTAL_BUDGET_MS } from "../src/tools/energy-commands.js";
import { ENERGY_COMMAND_TIMEOUT_MS } from "../src/fleet.js";
import { HTTP_DEFAULT_TIMEOUT_MS, type FetchLike } from "../src/http.js";
import { buildContext } from "../src/server.js";
import { AUTH, BASE, VIN, baseEnv, body, connect, fakeFetch, isError, routes } from "./helpers.js";
import type { Call, Route } from "./helpers.js";

const intent = { confirm: true, user_request: "please do it" };
const SITE = "1234567890";
const FIELD = "off_grid_vehicle_charging_reserve_percent";
const TOOL = "set_off_grid_vehicle_charging_reserve";
const INFO = `GET ${BASE}/api/1/energy_sites/${SITE}/site_info`;
const POST = `POST ${BASE}/api/1/energy_sites/${SITE}/off_grid_vehicle_charging_reserve`;
const AUTH_POST = `POST ${AUTH}/oauth2/v3/token`;
const PRODUCTS = `GET ${BASE}/api/1/products`;
const CLIENT_TIMEOUT_MS = 60_000;
const posts = (calls: Call[]) => calls.filter((x) => x.method === "POST" && x.url.endsWith("/off_grid_vehicle_charging_reserve"));
const auths = (calls: Call[]) => calls.filter((x) => x.url.includes("/oauth2/v3/token"));
const rawInfo = (valueJson: string) => ({ status: 200, body: `{"response":{"${FIELD}":${valueJson}}}` });

/**
 * Like the 0.7.4 slow-world harness. `expiresIn` (default 28800) is the token
 * lifetime returned by the fake refresh; 0 makes every later call() refresh again.
 */
function slowWorld(opts: {
  info: (n: number) => { status: number; body: unknown };
  readMs: (n: number) => number;
  postMs: number;
  authMs?: number;
  expiresIn?: number;
  post?: (n: number) => { status: number; body: unknown };
  env?: Record<string, string>;
  products?: boolean;
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
      return { status: 200, body: { access_token: `access-EXAMPLE-${refresh}`, refresh_token: `rotated-EXAMPLE-${refresh}`, expires_in: opts.expiresIn ?? 28800 } };
    },
    [INFO]: (_c, n) => { consume(opts.readMs(n)); return opts.info(n); },
    [POST]: (_c, n) => { consume(opts.postMs); return opts.post ? opts.post(n) : { status: 200, body: {} }; },
  };
  if (opts.products) {
    r[PRODUCTS] = () => ({ status: 200, body: { response: [{ energy_site_id: Number(SITE), site_name: "Example", resource_type: "battery" }] } });
  }
  const f = fakeFetch(routes(r));
  const impl: FetchLike = async (url, init) => {
    if (typeof init.timeoutMs === "number") lastTimeout = init.timeoutMs;
    return f.impl(url, init);
  };
  const ctx = buildContext({
    env: baseEnv(opts.env ?? { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_ENERGY_SITE_ID: SITE }), fetchImpl: impl,
    fleetOptions: { sleep: async (ms) => { now += ms; }, now: () => now },
  });
  return { ctx, calls: f.calls, elapsed: () => now - start };
}

test("off-grid budget: token refresh uses up the budget; nothing is sent", async () => {
  // No default site id, so site lookup and the pre-read are separate call()s.
  // expires_in=0 forces a refresh on each; two 15 s refreshes leave less than
  // the 30 s send timeout, so the tool refuses before any command POST.
  const { ctx, calls, elapsed } = slowWorld({
    info: () => rawInfo("95"),
    readMs: () => 0,
    postMs: ENERGY_COMMAND_TIMEOUT_MS,
    authMs: HTTP_DEFAULT_TIMEOUT_MS,
    expiresIn: 0,
    products: true,
    env: { TESLA_FLEET_READ_ONLY: "false" },
    post: () => { throw new Error("command POST must not run"); },
  });
  const res = await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } });
  assert.equal(isError(res), true);
  assert.equal(body(res).code, "budget_exhausted");
  assert.equal(posts(calls).length, 0, "refresh spent the budget; the command must not be posted");
  assert.ok(auths(calls).length >= 1);
  assert.ok(elapsed() <= OFF_GRID_TOTAL_BUDGET_MS, `took ${elapsed()} ms`);
  assert.ok(elapsed() < CLIENT_TIMEOUT_MS);
});

test("FleetClient.clock() defaults to a monotonic clock", () => {
  const ctx = buildContext({ env: baseEnv() });
  const t = ctx.fleet.clock();
  assert.ok(Math.abs(t - performance.now()) < 50, `clock() was ${t}, performance.now() is ${performance.now()}`);
  assert.ok(Math.abs(t - Date.now()) > 1e9, "default clock must not be Date.now (wall clock)");
});

test("listVehicles and command still work when no deadline is passed", async () => {
  const { ctx } = slowWorld({
    info: () => rawInfo("95"),
    readMs: () => 0,
    postMs: 1,
    env: { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_ENERGY_SITE_ID: SITE },
  });
  const list = await ctx.fleet.listVehicles();
  assert.ok(Array.isArray(list));
  await ctx.fleet.command(VIN, "door_lock", {});
});
