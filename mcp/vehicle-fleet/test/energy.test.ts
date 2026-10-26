import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHistoryQuery, sumSeries, tzOffset } from "../src/tools/energy.js";
import { BASE, VIN, baseEnv, body, connect, isError, setup } from "./helpers.js";
import type { Route } from "./helpers.js";

const SITE = "1234567890";
const products: Route = () => ({
  status: 200,
  body: { response: [
    { id: 1, vin: VIN, display_name: "Example" },
    { energy_site_id: Number(SITE), site_name: "Example Home", resource_type: "battery", percentage_charged: 55.5, gateway_id: "GW-EXAMPLE", components: { battery: true, solar: true, grid: true } },
  ] },
});
const live: Route = () => ({
  status: 200,
  body: { response: {
    solar_power: 1200, battery_power: -500, load_power: 700, grid_power: 0, percentage_charged: 55.54871654268362,
    island_status: "on_grid", grid_status: "Active", storm_mode_active: false, timestamp: "2026-01-01T12:00:00-05:00",
    wall_connectors: [{ din: "WC-EXAMPLE-0001", vin: VIN, wall_connector_state: 2, wall_connector_fault_state: 2, wall_connector_power: 0, extra_field: "dropped" }],
  } },
});
const info: Route = () => ({
  status: 200,
  body: { response: {
    site_name: "Example Home", backup_reserve_percent: 20, default_real_mode: "self_consumption", battery_count: 2,
    installation_time_zone: "America/New_York", address: "should not be returned",
    user_settings: { storm_mode_enabled: true }, components: { battery: true, solar: true, customer_preferred_export_rule: "pv_only", wall_connectors: [{ din: "x" }] },
  } },
});
const energyRoutes = (over: Record<string, Route> = {}) => ({
  [`GET ${BASE}/api/1/products`]: products,
  [`GET ${BASE}/api/1/energy_sites/${SITE}/live_status`]: live,
  [`GET ${BASE}/api/1/energy_sites/${SITE}/site_info`]: info,
  ...over,
});
const productCalls = (calls: Array<{ url: string }>) => calls.filter((c) => new URL(c.url).pathname === "/api/1/products");

test("energy tools are read tools: listed in read-only mode, nothing energy-write exists", async () => {
  const { ctx } = setup(baseEnv());
  const c = await connect(ctx);
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const n of ["list_energy_sites", "get_energy_live_status", "get_energy_site_info", "get_energy_history"]) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => /backup_reserve|operation_mode|storm|grid_import|export/.test(n)));
});

test("list_energy_sites filters vehicles and drops gateway identifiers", async () => {
  const { ctx } = setup(baseEnv(), energyRoutes());
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "list_energy_sites", arguments: {} }));
  const sites = b.sites as Array<Record<string, unknown>>;
  assert.equal(sites.length, 1);
  assert.equal(sites[0].energy_site_id, SITE);
  assert.equal(sites[0].percentage_charged, 55.5);
  assert.ok(!JSON.stringify(b).includes("GW-EXAMPLE"));
});

test("live status: power flows plus Wall Connector fields; site resolved once from products", async () => {
  const { ctx, calls } = setup(baseEnv(), energyRoutes());
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_energy_live_status", arguments: {} }));
  assert.equal(b.ok, true);
  assert.equal(b.solar_power, 1200);
  assert.equal(b.island_status, "on_grid");
  assert.equal(b.percentage_charged, 55.5, "rounded to one decimal");
  assert.match(String(b.signs), /discharging/);
  const wc = (b.wall_connectors as Array<Record<string, unknown>>)[0];
  assert.equal(wc.wall_connector_state, 2);
  assert.equal(wc.vin, VIN);
  assert.equal(wc.extra_field, undefined);
  await c.callTool({ name: "get_energy_site_info", arguments: {} });
  await c.callTool({ name: "get_energy_live_status", arguments: {} }); // memory cache
  assert.equal(productCalls(calls).length, 1);
  assert.equal(calls.filter((x) => x.url.endsWith("/live_status")).length, 1);
  assert.ok(!calls.some((x) => /wake_up|\/command\//.test(x.url)));
});

test("site info shapes settings and never returns address", async () => {
  const { ctx } = setup(baseEnv({ TESLA_DEFAULT_ENERGY_SITE_ID: SITE }), energyRoutes());
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_energy_site_info", arguments: {} }));
  assert.equal(b.backup_reserve_percent, 20);
  assert.equal(b.default_real_mode, "self_consumption");
  assert.equal((b.user_settings as Record<string, unknown>).storm_mode_enabled, true);
  assert.equal((b.components as Record<string, unknown>).customer_preferred_export_rule, "pv_only");
  assert.equal(b.wallConnectorCount, 1);
  assert.ok(!JSON.stringify(b).includes("should not be returned"));
});

test("default site id skips the products call; bad id refused locally", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_ENERGY_SITE_ID: SITE }), energyRoutes());
  const c = await connect(ctx);
  await c.callTool({ name: "get_energy_live_status", arguments: {} });
  assert.equal(productCalls(calls).length, 0);
  const n = calls.length;
  const res = await c.callTool({ name: "get_energy_live_status", arguments: { energy_site_id: "../etc" } });
  assert.equal(isError(res), true);
  assert.equal(body(res).code, "bad_site_id");
  assert.equal(calls.length, n);
});

test("403 gives a missing-scope hint", async () => {
  const { ctx } = setup(baseEnv({ TESLA_DEFAULT_ENERGY_SITE_ID: SITE }), energyRoutes({
    [`GET ${BASE}/api/1/energy_sites/${SITE}/live_status`]: () => ({ status: 403, body: { error: "unauthorized_missing_scopes" } }),
  }));
  const c = await connect(ctx);
  const res = await c.callTool({ name: "get_energy_live_status", arguments: {} });
  assert.equal(isError(res), true);
  assert.equal(body(res).code, "missing_energy_scope");
  assert.match(String(body(res).hint), /--energy/);
});

test("no energy sites: clear note, no error", async () => {
  const { ctx } = setup(baseEnv(), { [`GET ${BASE}/api/1/products`]: () => ({ status: 200, body: { response: [{ id: 1, vin: VIN }] } }) });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "list_energy_sites", arguments: {} }));
  assert.deepEqual(b.sites, []);
  assert.match(String(b.note), /energy_device_data/);
});

test("history query: defaults, bounded ranges, validation before any call", () => {
  const now = new Date("2026-03-10T15:00:00Z");
  const q = buildHistoryQuery({ time_zone: "America/New_York" }, now);
  assert.equal(q.kind, "energy");
  assert.equal(q.period, "day");
  assert.equal(q.start_date, "2026-03-10T00:00:00-04:00");
  assert.equal(q.end_date, "2026-03-10T23:59:59-04:00");
  assert.equal(buildHistoryQuery({ start_date: "2026-01-05", end_date: "2026-01-05", time_zone: "America/New_York" }, now).start_date, "2026-01-05T00:00:00-05:00");
  assert.equal(buildHistoryQuery({}, now).start_date, "2026-03-10T00:00:00+00:00");
  assert.throws(() => buildHistoryQuery({ start_date: "2026-01-01", end_date: "2026-03-01" }, now), /at most 31 days/);
  assert.doesNotThrow(() => buildHistoryQuery({ period: "month", start_date: "2025-04-01", end_date: "2026-03-01" }, now));
  assert.throws(() => buildHistoryQuery({ start_date: "2026-03-05", end_date: "2026-03-01" }, now), /after/);
  assert.throws(() => buildHistoryQuery({ end_date: "2026-04-01" }, now), /future/);
  assert.throws(() => buildHistoryQuery({ kind: "power" }, now), /kind/);
  assert.throws(() => buildHistoryQuery({ time_zone: "Mars/Base" }, now), /IANA/);
  assert.throws(() => buildHistoryQuery({ start_date: "03/01/2026" }, now), /YYYY-MM-DD/);
  assert.equal(tzOffset("2026-07-01", "UTC"), "+00:00");
});

test("history: energy totals summed; backup events counted; bad range sends nothing", async () => {
  let seen = "";
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_ENERGY_SITE_ID: SITE }), energyRoutes({
    [`GET ${BASE}/api/1/energy_sites/${SITE}/calendar_history`]: (call) => {
      seen = call.url;
      const kind = new URL(call.url).searchParams.get("kind");
      return kind === "backup"
        ? { status: 200, body: { response: { events: [{ timestamp: "2026-01-01T01:00:00-05:00", duration: 60000 }, { timestamp: "2026-01-02T01:00:00-05:00", duration: 120000 }] } } }
        : { status: 200, body: { response: { time_series: [
            { timestamp: "2026-01-01T00:00:00-05:00", solar_energy_exported: 100, grid_energy_imported: 50.5 },
            { timestamp: "2026-01-01T00:15:00-05:00", solar_energy_exported: 200, grid_energy_imported: 0 },
          ] } } };
    },
  }));
  const c = await connect(ctx);
  const e = body(await c.callTool({ name: "get_energy_history", arguments: { start_date: "2026-01-01", end_date: "2026-01-01", time_zone: "America/New_York" } }));
  assert.equal(e.entries, 2);
  assert.deepEqual(e.totals, { solar_energy_exported: 300, grid_energy_imported: 50.5 });
  assert.equal(e.series, undefined);
  const u = new URL(seen);
  assert.equal(u.searchParams.get("period"), "day");
  assert.equal(u.searchParams.get("time_zone"), "America/New_York");
  const bk = body(await c.callTool({ name: "get_energy_history", arguments: { kind: "backup", start_date: "2026-01-01", end_date: "2026-01-02", include_series: true } }));
  assert.equal(bk.total_events, 2);
  assert.equal(bk.totalDurationSec, 180);
  assert.equal((bk.events as unknown[]).length, 2);
  const n = calls.length;
  const bad = await c.callTool({ name: "get_energy_history", arguments: { start_date: "2025-01-01", end_date: "2026-01-01" } });
  assert.equal(isError(bad), true);
  assert.equal(body(bad).code, "bad_history_args");
  assert.equal(calls.length, n);
});

test("sumSeries ignores non-numeric fields", () => {
  assert.deepEqual(sumSeries([{ timestamp: "x", a: 1 }, { a: 2.005, b: "y" }]), { a: 3.01 });
});
