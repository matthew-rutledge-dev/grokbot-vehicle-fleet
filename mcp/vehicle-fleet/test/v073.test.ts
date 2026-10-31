/**
 * 0.7.3: review nits from 0.7.2. Off-grid reserve time budget (the whole call stays inside a 60 s
 * client timeout; out of time = pending, never resent), finite-number-only read-back, and the
 * proxy-path cache invalidation `finally` on success and on error.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OFF_GRID_MIN_READ_MS, OFF_GRID_PRECHECK_TIMEOUT_MS, OFF_GRID_READBACK_DELAY_MS, OFF_GRID_READBACK_TIMEOUT_MS,
  OFF_GRID_READBACK_TRIES, OFF_GRID_TOTAL_BUDGET_MS,
} from "../src/tools/energy-commands.js";
import { ENERGY_COMMAND_TIMEOUT_MS } from "../src/fleet.js";
import { buildContext } from "../src/server.js";
import { BASE, PROXY, VIN, baseEnv, body, connect, fakeFetch, isError, routes } from "./helpers.js";
import type { Call, Route } from "./helpers.js";

const intent = { confirm: true, user_request: "please do it" };
const SITE = "1234567890";
const FIELD = "off_grid_vehicle_charging_reserve_percent";
const TOOL = "set_off_grid_vehicle_charging_reserve";
const INFO = `GET ${BASE}/api/1/energy_sites/${SITE}/site_info`;
const POST = `POST ${BASE}/api/1/energy_sites/${SITE}/off_grid_vehicle_charging_reserve`;
const PRODUCTS = `GET ${BASE}/api/1/products`;
const EON = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_ENERGY_SITE_ID: SITE };
const CLIENT_TIMEOUT_MS = 60_000;
const posts = (calls: Call[]) => calls.filter((x) => x.method === "POST" && x.url.endsWith("/off_grid_vehicle_charging_reserve"));
const reads = (calls: Call[]) => calls.filter((x) => x.url.endsWith("/site_info"));
/** A raw JSON site_info body (so non-JSON-safe numbers such as 1e999 = Infinity can be sent). */
const rawInfo = (valueJson: string) => ({ status: 200, body: `{"response":{"${FIELD}":${valueJson}}}` });

/**
 * Off-grid harness with a fake clock: sleeps advance it, and every site_info read takes `readMs(n)`
 * (capped at the timeout the server asked for, like a real abort), the POST takes `postMs`.
 */
function slowWorld(opts: { info: (n: number) => { status: number; body: unknown }; readMs: (n: number) => number; postMs: number; productsMs?: number; env?: Record<string, string> }) {
  let now = 1_000_000;
  const start = now;
  const timeouts: Array<number | undefined> = [];
  let lastTimeout: number | undefined;
  const r: Record<string, Route> = {
    [INFO]: (_c, n) => { now += Math.min(opts.readMs(n), lastTimeout ?? 15_000); return opts.info(n); },
    [POST]: () => { now += opts.postMs; return { status: 200, body: {} }; },
    [PRODUCTS]: () => { now += opts.productsMs ?? 0; return { status: 200, body: { response: [{ energy_site_id: Number(SITE), resource_type: "battery" }] } }; },
  };
  const f = fakeFetch(routes(r));
  const ctx = buildContext({
    env: baseEnv(opts.env ?? EON), fetchImpl: f.impl,
    fleetOptions: { sleep: async (ms) => { now += ms; }, now: () => now },
  });
  const orig = ctx.fleet.energySiteInfo.bind(ctx.fleet);
  ctx.fleet.energySiteInfo = (siteId: string, fresh?: boolean, timeoutMs?: number) => {
    timeouts.push(timeoutMs);
    lastTimeout = timeoutMs;
    return orig(siteId, fresh, timeoutMs);
  };
  return { ctx, calls: f.calls, timeouts, elapsed: () => now - start };
}

// --- (1) time budget ---------------------------------------------------------------------------

test("off-grid budget: constants keep the worst case inside a 60 s client timeout", () => {
  assert.ok(OFF_GRID_TOTAL_BUDGET_MS < CLIENT_TIMEOUT_MS);
  // Site lookup (HTTP default 15 s) + capped pre-read + send fits the budget before any read-back.
  assert.ok(15_000 + OFF_GRID_PRECHECK_TIMEOUT_MS + ENERGY_COMMAND_TIMEOUT_MS <= OFF_GRID_TOTAL_BUDGET_MS);
  assert.equal(OFF_GRID_READBACK_TRIES, 3);
  assert.equal(OFF_GRID_READBACK_DELAY_MS, 5_000);
  assert.ok(OFF_GRID_READBACK_TIMEOUT_MS <= 5_000);
  assert.ok(OFF_GRID_MIN_READ_MS > 0);
});

test("off-grid budget: fast site = every read gets a bounded timeout, all 3 read-backs fit", async () => {
  const { ctx, calls, timeouts, elapsed } = slowWorld({ info: (n) => rawInfo(n === 1 ? "95" : "95"), readMs: () => 200, postMs: 500 });
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
  assert.equal(b.ok, true);
  assert.equal(b.readBack, "pending");
  assert.equal(b.readBackReason, undefined);
  assert.equal(b.readBackReads, 3);
  assert.deepEqual(timeouts, [OFF_GRID_PRECHECK_TIMEOUT_MS, OFF_GRID_READBACK_TIMEOUT_MS, OFF_GRID_READBACK_TIMEOUT_MS, OFF_GRID_READBACK_TIMEOUT_MS]);
  assert.equal(posts(calls).length, 1);
  assert.ok(elapsed() < OFF_GRID_TOTAL_BUDGET_MS);
});

test("off-grid budget: every request as slow as allowed = finishes inside the budget, pending (time_budget), never resent", async () => {
  const { ctx, calls, elapsed } = slowWorld({ info: () => rawInfo("95"), readMs: () => 60_000, postMs: ENERGY_COMMAND_TIMEOUT_MS });
  const res = await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } });
  assert.equal(isError(res), false);
  const b = body(res);
  assert.equal(b.ok, true);
  assert.equal(b.sent, true);
  assert.equal(b.readBack, "pending");
  assert.equal(b.readBackReason, "time_budget");
  assert.ok(Number(b.readBackReads) < OFF_GRID_READBACK_TRIES);
  assert.match(String(b.readBackMessage), /Not resent/);
  assert.equal(posts(calls).length, 1);
  assert.ok(elapsed() <= OFF_GRID_TOTAL_BUDGET_MS, `took ${elapsed()} ms`);
});

test("off-grid budget: slow site lookup + pre-read leave no room for the send = budget_exhausted, nothing sent", async () => {
  const env = { TESLA_FLEET_READ_ONLY: "false" };
  const { ctx, calls, elapsed } = slowWorld({ env, info: () => rawInfo("95"), readMs: () => 60_000, postMs: 0, productsMs: 26_000 });
  const res = await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } });
  assert.equal(isError(res), true);
  assert.equal(body(res).code, "budget_exhausted");
  assert.match(String(body(res).message ?? body(res).error), /Nothing was sent/);
  assert.equal(posts(calls).length, 0);
  assert.ok(elapsed() <= OFF_GRID_TOTAL_BUDGET_MS);
});

test("off-grid budget: a slow lookup shortens the pre-read timeout so the send still fits", async () => {
  const env = { TESLA_FLEET_READ_ONLY: "false" };
  const { ctx, calls, timeouts, elapsed } = slowWorld({ env, info: () => rawInfo("95"), readMs: () => 60_000, postMs: ENERGY_COMMAND_TIMEOUT_MS, productsMs: 20_000 });
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
  assert.equal(timeouts[0], OFF_GRID_TOTAL_BUDGET_MS - 20_000 - ENERGY_COMMAND_TIMEOUT_MS);
  assert.equal(b.ok, true);
  assert.equal(b.readBack, "pending");
  assert.equal(b.readBackReason, "time_budget");
  assert.equal(b.readBackReads, 0);
  assert.equal(posts(calls).length, 1);
  assert.equal(reads(calls).length, 1);
  assert.ok(elapsed() <= OFF_GRID_TOTAL_BUDGET_MS);
});

// --- (2) finite numbers only -------------------------------------------------------------------

const fast = (info: (n: number) => { status: number; body: unknown }) => slowWorld({ info, readMs: () => 10, postMs: 10 });

test("off-grid read-back: non-numeric, NaN-like or Infinity values = unavailable, never echoed", async () => {
  for (const bad of [`"90"`, `"NaN"`, `"Infinity"`, `1e999`, `-1e999`, `{"v":90}`, `[90]`, `true`]) {
    const { ctx, calls } = fast((n) => rawInfo(n === 1 ? "95" : bad));
    const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
    assert.equal(b.ok, true, bad);
    assert.equal(b.readBack, "unavailable", bad);
    assert.equal(b.readBackValue, undefined, bad);
    assert.equal(b.readBackReads, 3, bad);
    assert.match(String(b.readBackMessage), /no usable number/, bad);
    assert.doesNotMatch(JSON.stringify(b), /Infinity|NaN|"v"/, bad);
    assert.equal(posts(calls).length, 1, bad);
  }
});

test("off-grid read-back: Infinity is not a mismatch; a later finite value still confirms", async () => {
  const { ctx } = fast((n) => rawInfo(n === 1 ? "95" : n === 2 ? "1e999" : "90"));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
  assert.equal(b.readBack, "confirmed");
  assert.equal(b.readBackValue, 90);
  assert.equal(b.readBackReads, 2);
});

test("off-grid read-back: unusable then the old value = pending with the last finite value only", async () => {
  const { ctx } = fast((n) => rawInfo(n === 1 ? "95" : n === 2 ? `"junk"` : "95"));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
  assert.equal(b.readBack, "pending");
  assert.equal(b.readBackValue, 95);
  assert.doesNotMatch(String(b.readBackMessage), /junk/);
});

test("off-grid pre-read: Infinity is not a usable previous value (value_absent), so no false mismatch", async () => {
  const { ctx } = fast((n) => rawInfo(n === 1 ? "1e999" : "50"));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
  assert.equal(b.precheck, "unavailable");
  assert.equal(b.precheckReason, "value_absent");
  assert.equal(b.previous, undefined);
  assert.equal(b.readBack, "pending");
  assert.equal(b.readBackValue, 50);
});

// --- (3) proxy-path finally --------------------------------------------------------------------

test("proxied command clears cached vehicle data on success and on every kind of failure", async () => {
  const LOCK = `POST ${PROXY}/api/1/vehicles/${VIN}/command/door_lock`;
  const cases: Array<[string, Route, boolean]> = [
    ["success", () => ({ status: 200, body: { response: { result: true, reason: "" } } }), true],
    ["car refused", () => ({ status: 200, body: { response: { result: false, reason: "busy" } } }), true],
    ["http 500", () => ({ status: 500, body: {} }), false],
    ["dropped connection", () => { throw new Error("socket hang up"); }, false],
  ];
  for (const [label, route, resolves] of cases) {
    const f = fakeFetch(routes({ [LOCK]: route }));
    const ctx = buildContext({ env: baseEnv({ TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_VIN: VIN }), fetchImpl: f.impl, fleetOptions: { sleep: async () => {} } });
    ctx.fleet.cache.set(`live:${VIN}`, { stale: true });
    ctx.fleet.cache.set(`cached:${VIN}`, { stale: true });
    const p = ctx.fleet.command(VIN, "door_lock", {});
    if (resolves) await p; else await assert.rejects(p, label);
    const sent = f.calls.filter((x) => x.url.endsWith("/command/door_lock"));
    assert.equal(sent.length, 1, label);
    assert.ok(sent[0].url.startsWith(PROXY), `${label}: sent via the proxy`);
    assert.equal(ctx.fleet.cache.get(`live:${VIN}`, 60_000), undefined, label);
    assert.equal(ctx.fleet.cache.get(`cached:${VIN}`, 60_000), undefined, label);
  }
});
