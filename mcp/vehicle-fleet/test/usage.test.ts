import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildContext } from "../src/server.js";
import { listTools } from "../src/tools.js";
import { DEFAULT_RATES, UsageTracker, estimate, emptyBucket, monthKey, previousMonthKey, usagePathFor } from "../src/usage.js";
import { loadConfig } from "../src/config.js";
import { AUTH, BASE, PROXY, VIN, baseEnv, body, connect, fakeFetch, routes, tmpDir } from "./helpers.js";

const MAR_31 = Date.UTC(2026, 2, 31, 23, 59, 0);
const APR_1 = Date.UTC(2026, 3, 1, 0, 1, 0);

type Counts = Record<string, { billable: number; notBilled: number; noResponse: number }>;

function setupAt(clock: { t: number }, extraEnv: Record<string, string> = {}, over = {}) {
  const env = baseEnv({ TESLA_DEFAULT_VIN: VIN, TESLA_FLEET_READ_ONLY: "off", ...extraEnv });
  const f = fakeFetch(routes(over));
  const ctx = buildContext({ env, fetchImpl: f.impl, now: () => clock.t, fleetOptions: { sleep: async () => {}, wakePollMs: 5000, wakeTimeoutMs: 15000 } });
  return { ctx, env, calls: f.calls };
}

test("month keys are UTC calendar months", () => {
  assert.equal(monthKey(MAR_31), "2026-03");
  assert.equal(monthKey(APR_1), "2026-04");
  assert.equal(previousMonthKey(APR_1), "2026-03");
  assert.equal(previousMonthKey(Date.UTC(2026, 0, 15)), "2025-12");
});

test("usage file lives next to the token store", () => {
  assert.equal(usagePathFor(path.join("x", "y", "tokens.json")), path.join("x", "y", "usage.json"));
});

test("counts by category: data, command, wake, other, auth (via the MCP tools)", async () => {
  const clock = { t: MAR_31 };
  const { ctx } = setupAt(clock, {}, {
    [`GET ${BASE}/api/1/vehicles/${VIN}`]: (_c: unknown, n: number) => ({ status: 200, body: { response: { vin: VIN, state: n === 1 ? "asleep" : "online" } } }),
    [`POST ${BASE}/api/1/vehicles/${VIN}/wake_up`]: () => ({ status: 200, body: { response: { vin: VIN, state: "online" } } }),
  });
  const c = await connect(ctx);
  await c.callTool({ name: "get_battery_charge", arguments: {} }); // auth + cached data
  const w = body(await c.callTool({ name: "wake_vehicle", arguments: { confirm: true, user_request: "wake it" } })); // state (other) + wake
  assert.equal(w.sent, true);
  await c.callTool({ name: "get_climate", arguments: { live: true } }); // state (other) + live data
  await c.callTool({ name: "door_lock", arguments: { confirm: true, user_request: "lock my car" } }); // state + fleet_status + command
  const u = body(await c.callTool({ name: "get_api_usage", arguments: {} }));
  const counts = (u.thisMonth as { counts: Counts }).counts;
  assert.equal((u.thisMonth as { month: string }).month, "2026-03");
  assert.equal(counts.auth.billable, 1, "one token refresh");
  assert.equal(counts.data.billable, 2);
  assert.equal(counts.command.billable, 1);
  assert.equal(counts.wake.billable, 1);
  assert.ok(counts.other.billable >= 3, "vehicle state + fleet_status counted as other");
  const est = (u.thisMonth as { estimate: Record<string, unknown> }).estimate;
  // 2/500 + 1/1000 + 1/50 = 0.004 + 0.001 + 0.02 = 0.025 -> 0.03 (rounded); after $10 discount = 0
  assert.equal(est.beforeDiscountUsd, 0.03);
  assert.equal(est.afterDiscountUsd, 0);
  assert.equal(u.localEstimate, true);
  assert.match(String(u.note), /source of truth/);
  assert.match(String(u.note), /not Home Assistant/);
});

test("< 500 is billable, >= 500 is not billed, network errors are noResponse", async () => {
  const clock = { t: MAR_31 };
  let n = 0;
  const { ctx } = setupAt(clock, {}, {
    [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data_cached`]: () => {
      n++;
      if (n === 1) return { status: 404, body: { error: "not_found" } };
      if (n === 2) return { status: 503, body: { error: "unavailable" } };
      throw new Error("ECONNRESET");
    },
  });
  const c = await connect(ctx);
  for (let i = 0; i < 3; i++) {
    ctx.fleet.cache.deletePrefix("cached:");
    await c.callTool({ name: "get_tires", arguments: {} });
  }
  const counts = (body(await c.callTool({ name: "get_api_usage", arguments: {} })).thisMonth as { counts: Counts }).counts;
  assert.deepEqual(counts.data, { billable: 1, notBilled: 1, noResponse: 1 });
});

test("month rollover: March calls land in lastMonth on April 1 (UTC)", async () => {
  const clock = { t: MAR_31 };
  const { ctx } = setupAt(clock);
  const c = await connect(ctx);
  await c.callTool({ name: "get_battery_charge", arguments: {} });
  clock.t = APR_1;
  ctx.fleet.cache.deletePrefix("cached:");
  await c.callTool({ name: "get_battery_charge", arguments: {} });
  await c.callTool({ name: "get_battery_charge", arguments: { live: true } });
  const u = body(await c.callTool({ name: "get_api_usage", arguments: {} }));
  const tm = u.thisMonth as { month: string; counts: Counts };
  const lm = u.lastMonth as { month: string; counts: Counts };
  assert.equal(tm.month, "2026-04");
  assert.equal(lm.month, "2026-03");
  assert.equal(lm.counts.data.billable, 1);
  assert.equal(tm.counts.data.billable, 2);
});

test("persists across restart; atomic write leaves no temp/lock files; no secrets or VINs", async () => {
  const clock = { t: MAR_31 };
  const { ctx, env } = setupAt(clock);
  const c = await connect(ctx);
  await c.callTool({ name: "get_battery_charge", arguments: {} });
  await c.callTool({ name: "door_lock", arguments: { confirm: true, user_request: "lock" } });
  await ctx.usage.flush();
  const file = ctx.usage.filePath;
  const dir = path.dirname(file);
  assert.equal(path.basename(file), "usage.json");
  assert.equal(path.dirname(env.TESLA_TOKEN_STORE), dir);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock")), []);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(file, "utf8");
  for (const bad of [VIN, VIN.slice(-4), "access-EXAMPLE", "rotated-EXAMPLE", "seed-refresh", BASE, AUTH, PROXY]) {
    assert.ok(!raw.includes(bad), `usage file must not contain ${bad}`);
  }
  // "restart": a fresh tracker on the same file sees the same counts
  const again = new UsageTracker(file, () => clock.t);
  const r = again.report(DEFAULT_RATES) as { thisMonth: { counts: Counts } };
  assert.equal(r.thisMonth.counts.data.billable, 1);
  assert.equal(r.thisMonth.counts.command.billable, 1);
  // and keeps counting on top
  await again.record("wake", 200);
  assert.equal((again.report(DEFAULT_RATES) as { thisMonth: { counts: Counts } }).thisMonth.counts.wake.billable, 1);
});

test("concurrent records from two trackers on one file are not lost", async () => {
  const file = path.join(tmpDir(), "usage.json");
  const a = new UsageTracker(file, () => MAR_31);
  const b = new UsageTracker(file, () => MAR_31);
  await Promise.all([...Array(10)].map((_, i) => (i % 2 ? a : b).record("data", 200)));
  await Promise.all([a.flush(), b.flush()]);
  assert.equal(a.read().months["2026-03"].data.billable, 10);
});

test("corrupt usage file never breaks a tool call and is rebuilt", async () => {
  const file = path.join(tmpDir(), "usage.json");
  fs.writeFileSync(file, "{not json");
  const t = new UsageTracker(file, () => MAR_31, () => {});
  assert.match(String((t.report(DEFAULT_RATES) as { usageFile: { status: string } }).usageFile.status), /unreadable/);
  await t.record("data", 200);
  assert.equal(t.read().months["2026-03"].data.billable, 1);
});

test("estimate: published rates, discount floor, other not priced", () => {
  const b = emptyBucket();
  b.data.billable = 5000; // $10
  b.command.billable = 2000; // $2
  b.wake.billable = 100; // $2
  b.data.notBilled = 999; // ignored
  b.other.billable = 500; // $1 if billed as data
  const e = estimate(b, DEFAULT_RATES);
  assert.deepEqual(e.byCategoryUsd, { data: 10, command: 2, wake: 2 });
  assert.equal(e.beforeDiscountUsd, 14);
  assert.equal(e.afterDiscountUsd, 4);
  assert.equal(e.otherNotPriced.ifBilledAsDataUsd, 1);
  assert.equal(e.otherNotPriced.afterDiscountIfBilledAsDataUsd, 5);
});

test("rates are overridable via env; invalid values fall back with a warning", () => {
  const ok = loadConfig({
    TESLA_CLIENT_ID: "x", TESLA_FLEET_RATE_DATA_PER_USD: "250", TESLA_FLEET_RATE_COMMANDS_PER_USD: "2000",
    TESLA_FLEET_RATE_WAKES_PER_USD: "25", TESLA_FLEET_MONTHLY_DISCOUNT_USD: "0",
  });
  assert.deepEqual(ok.rates, { dataPerUsd: 250, commandsPerUsd: 2000, wakesPerUsd: 25, monthlyDiscountUsd: 0 });
  const bad = loadConfig({ TESLA_CLIENT_ID: "x", TESLA_FLEET_RATE_DATA_PER_USD: "0", TESLA_FLEET_RATE_WAKES_PER_USD: "abc" });
  assert.deepEqual(bad.rates, DEFAULT_RATES);
  assert.equal(bad.warnings.filter((w) => /RATE_/.test(w)).length, 2);
  const unset = loadConfig({ TESLA_CLIENT_ID: "x", TESLA_FLEET_RATE_DATA_PER_USD: "${TESLA_FLEET_RATE_DATA_PER_USD}" });
  assert.deepEqual(unset.rates, DEFAULT_RATES);
});

test("get_api_usage is a read tool: listed in read-only mode, makes no network call, zeros when empty", async () => {
  assert.ok(listTools({ readOnly: true, locationEnabled: false }).some((t) => t.name === "get_api_usage"));
  const clock = { t: APR_1 };
  const env = baseEnv();
  const f = fakeFetch({});
  const ctx = buildContext({ env, fetchImpl: f.impl, now: () => clock.t });
  const c = await connect(ctx);
  const u = body(await c.callTool({ name: "get_api_usage", arguments: {} }));
  assert.equal(f.calls.length, 0);
  assert.equal(u.ok, true);
  assert.deepEqual(u.rates, DEFAULT_RATES);
  for (const k of ["thisMonth", "lastMonth"] as const) {
    const m = u[k] as { counts: Counts; estimate: { beforeDiscountUsd: number; afterDiscountUsd: number } };
    for (const cat of ["data", "command", "wake", "other", "auth"]) assert.deepEqual(m.counts[cat], { billable: 0, notBilled: 0, noResponse: 0 });
    assert.equal(m.estimate.beforeDiscountUsd, 0);
    assert.equal(m.estimate.afterDiscountUsd, 0);
  }
  assert.equal((u.usageFile as { status: string }).status, "no calls recorded yet");
  assert.equal(fs.existsSync(ctx.usage.filePath), false, "reading usage does not create the file");
});
