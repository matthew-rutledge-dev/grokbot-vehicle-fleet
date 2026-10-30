/**
 * 0.7.0: set_off_grid_vehicle_charging_reserve (energy command) and site_info exposure of the current value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, baseEnv, body, connect, isError, setup } from "./helpers.js";
import type { Call, Route } from "./helpers.js";
import { ALL_TOOL_DEFS } from "../src/tools.js";

const SITE = "1234567890";
const ON = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_ENERGY_SITE_ID: SITE };
const TOOL = "set_off_grid_vehicle_charging_reserve";
const FIELD = "off_grid_vehicle_charging_reserve_percent";
const intent = { confirm: true, user_request: "set the off-grid car charging reserve" };
const POST = `POST ${BASE}/api/1/energy_sites/${SITE}/off_grid_vehicle_charging_reserve`;
const INFO = `GET ${BASE}/api/1/energy_sites/${SITE}/site_info`;
const updated: Route = () => ({ status: 200, body: { response: { code: 201, message: "Updated" } } });
const info = (resp: Record<string, unknown>): Route => () => ({ status: 200, body: { response: resp } });
const posts = (calls: Call[]) => calls.filter((x) => x.method === "POST" && x.url.includes("/off_grid_vehicle_charging_reserve"));
const infoReads = (calls: Call[]) => calls.filter((x) => x.url.endsWith("/site_info"));

test("off-grid reserve: confirmed send reads site_info fresh, then posts the exact body direct to the Fleet API", async () => {
  const { ctx, calls } = setup(baseEnv(ON), {
    // Pre-read 10, then the site reports the new 25 (0.7.2 read-back confirms on its first read).
    [INFO]: (_c, n) => ({ status: 200, body: { response: { [FIELD]: n === 1 ? 10 : 25, components: { off_grid_vehicle_charging_reserve_supported: true } } } }),
    [POST]: updated,
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: TOOL, arguments: { [FIELD]: 25, ...intent } }));
  assert.equal(b.ok, true);
  assert.equal(b.sent, true);
  assert.equal(b.previous, 10);
  assert.equal(b.precheck, "ok");
  const p = posts(calls);
  assert.equal(p.length, 1);
  assert.equal(p[0].url, `${BASE}/api/1/energy_sites/${SITE}/off_grid_vehicle_charging_reserve`);
  assert.deepEqual(JSON.parse(p[0].body ?? "{}"), { [FIELD]: 25 });
  assert.equal(p[0].dispatcher, undefined, "not via the vehicle proxy");
  assert.equal(b.readBack, "confirmed");
  assert.equal(infoReads(calls).length, 2, "1 pre-read + 1 read-back");
  // The pre-read bypasses the 10-minute site_info cache: a second confirmed send reads again.
  await c.callTool({ name: TOOL, arguments: { [FIELD]: 30, ...intent } });
  assert.equal(infoReads(calls).length, 6, "1 pre-read + 3 read-backs (site still shows 25)");
});

test("off-grid reserve: already set = no-op, nothing posted", async () => {
  const { ctx, calls } = setup(baseEnv(ON), { [INFO]: info({ [FIELD]: 20 }), [POST]: updated });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: TOOL, arguments: { [FIELD]: 20, ...intent } }));
  assert.equal(b.ok, true);
  assert.equal(b.noop, true);
  assert.equal(b.sent, false);
  assert.equal(b[FIELD], 20);
  assert.equal(posts(calls).length, 0);
});

test("off-grid reserve: site reports unsupported = refused, nothing posted", async () => {
  const { ctx, calls } = setup(baseEnv(ON), {
    [INFO]: info({ components: { off_grid_vehicle_charging_reserve_supported: false } }),
    [POST]: updated,
  });
  const c = await connect(ctx);
  const res = await c.callTool({ name: TOOL, arguments: { [FIELD]: 20, ...intent } });
  assert.equal(isError(res), true);
  assert.equal(body(res).code, "not_supported");
  assert.equal(posts(calls).length, 0);
});

test("off-grid reserve: value absent or pre-read failing = sent once, precheck unavailable, never retried", async () => {
  const cases: Array<[Route, string]> = [
    [info({ backup_reserve_percent: 20 }), "value_absent"],
    [info({ [FIELD]: "20" }), "value_absent"],
    [() => ({ status: 500, body: {} }), "read_failed"],
    [() => ({ status: 403, body: { error: "unauthorized_missing_scopes", error_description: "missing scopes" } }), "read_failed"],
  ];
  for (const [r, reason] of cases) {
    const { ctx, calls } = setup(baseEnv(ON), { [INFO]: r, [POST]: updated });
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: TOOL, arguments: { [FIELD]: 20, ...intent } }));
    assert.equal(b.ok, true);
    assert.equal(b.precheck, "unavailable");
    assert.equal(b.precheckReason, reason);
    assert.equal(posts(calls).length, 1);
  }
  {
    const { ctx, calls } = setup(baseEnv(ON), { [INFO]: info({ [FIELD]: 5 }), [POST]: () => ({ status: 502, body: {} }) });
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: TOOL, arguments: { [FIELD]: 20, ...intent } }));
    assert.equal(b.code, "state_unknown");
    assert.equal(posts(calls).length, 1, "not retried");
  }
});

test("off-grid reserve: strict integer 10-95 (0.7.1); bad values refused before any network call", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  for (const v of [-1, 0, 9, 96, 100, 101, 20.5, "20", null, true, 1e309, Number.NaN]) {
    const res = await c.callTool({ name: TOOL, arguments: { [FIELD]: v, ...intent } });
    assert.equal(isError(res), true, String(v));
    assert.equal(body(res).code, "invalid_arguments", String(v));
  }
  {
    const res = await c.callTool({ name: TOOL, arguments: { ...intent } });
    assert.equal(body(res).code, "invalid_arguments");
  }
  assert.equal(body(await c.callTool({ name: TOOL, arguments: { [FIELD]: 20, confirm: true } })).code, "user_request_required");
  for (const v of [10, 95]) {
    const b = body(await c.callTool({ name: TOOL, arguments: { [FIELD]: v } }));
    assert.equal(b.dryRun, true, String(v));
    assert.deepEqual(b.body, { [FIELD]: v });
  }
  assert.equal(calls.length, 0);
});

test("off-grid reserve: preview and TESLA_FLEET_DRY_RUN make zero network calls (no pre-read either)", async () => {
  {
    const { ctx, calls } = setup(baseEnv(ON));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: TOOL, arguments: { [FIELD]: 20 } }));
    assert.equal(b.dryRun, true);
    assert.equal(b.sent, false);
    assert.equal(b.endpoint, "POST /api/1/energy_sites/{energy_site_id}/off_grid_vehicle_charging_reserve");
    assert.match(String(b.estimatedBillableCalls), /1 site_info read/);
    assert.equal(calls.length, 0);
  }
  {
    const { ctx, calls } = setup(baseEnv({ ...ON, TESLA_FLEET_DRY_RUN: "on" }));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: TOOL, arguments: { [FIELD]: 20, ...intent } }));
    assert.deepEqual(b.wouldSend, [{ method: "POST", url: `<fleet base>/api/1/energy_sites/${SITE}/off_grid_vehicle_charging_reserve`, body: { [FIELD]: 20 } }]);
    assert.equal(calls.length, 0);
  }
});

test("off-grid reserve: hidden and refused unless read-only is explicitly off (fails closed), zero network", async () => {
  for (const ro of [undefined, "true", "maybe", "${TESLA_FLEET_READ_ONLY}"]) {
    const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_ENERGY_SITE_ID: SITE, TESLA_FLEET_ENABLE_VALET: "1", TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS: "1", ...(ro ? { TESLA_FLEET_READ_ONLY: ro } : {}) }));
    const c = await connect(ctx);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes(TOOL), String(ro));
    assert.equal(names.length, 26, `exactly the 26 read tools with both opt-ins on, read-only ${String(ro)}`);
    const res = await c.callTool({ name: TOOL, arguments: { [FIELD]: 20, ...intent } });
    assert.equal(isError(res), true);
    assert.equal(body(res).readOnly, true);
    assert.equal(calls.length, 0);
  }
});

test("get_energy_site_info exposes off_grid_vehicle_charging_reserve_percent when the site returns it", async () => {
  const { ctx } = setup(baseEnv({ TESLA_DEFAULT_ENERGY_SITE_ID: SITE }), {
    [INFO]: info({ backup_reserve_percent: 20, [FIELD]: 15, components: { off_grid_vehicle_charging_reserve_supported: true } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_energy_site_info", arguments: {} }));
  assert.equal(b[FIELD], 15);
  assert.equal((b.components as Record<string, unknown>).off_grid_vehicle_charging_reserve_supported, true);
});

test("steering wheel heat level is not a tool (no stock proxy handler, no published proto action)", () => {
  const names = ALL_TOOL_DEFS.map((d) => d.tool.name);
  assert.ok(!names.some((n) => /steering_wheel_heat_level|wheel_heat_level/.test(n)));
  assert.ok(!JSON.stringify(ALL_TOOL_DEFS.map((d) => d.tool)).includes("remote_steering_wheel_heat_level_request"));
});

test("location filter: relocation/dislocation/colocation are dropped on purpose (documented safe default); allocation kept", async () => {
  const { isLocationKey } = await import("../src/tools/energy.js");
  for (const k of ["relocation", "dislocation", "colocation", "relocation_count"]) assert.ok(isLocationKey(k), k);
  assert.ok(!isLocationKey("allocation"));
});

test("off-grid reserve: pre-read failing with login_required = that error, nothing sent", async () => {
  const { ctx, calls } = setup(baseEnv(ON), {
    [INFO]: () => ({ status: 401, body: { error: "invalid_token", error_description: "login_required" } }),
    [POST]: updated,
  });
  const c = await connect(ctx);
  const res = await c.callTool({ name: TOOL, arguments: { [FIELD]: 20, ...intent } });
  assert.equal(isError(res), true);
  assert.equal(body(res).code, "login_required");
  assert.equal(posts(calls).length, 0);
});

test("every energy command: a read-back after a 502 / dropped connection hits the network (no stale cached site_info)", async () => {
  const sends: Array<[string, string, Record<string, unknown>]> = [
    ["set_backup_reserve", "backup", { backup_reserve_percent: 15 }],
    ["set_operation_mode", "operation", { default_real_mode: "autonomous" }],
    ["set_storm_mode", "storm_mode", { enabled: true }],
    ["set_grid_import_export", "grid_import_export", { customer_preferred_export_rule: "pv_only" }],
    [TOOL, "off_grid_vehicle_charging_reserve", { [FIELD]: 25 }],
  ];
  const failures: Route[] = [
    () => ({ status: 502, body: {} }),
    () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }); },
  ];
  for (const [tool, path, args] of sends) {
    for (const fail of failures) {
      const { ctx, calls } = setup(baseEnv(ON), {
        [INFO]: info({ backup_reserve_percent: 20, [FIELD]: 10 }),
        [`GET ${BASE}/api/1/energy_sites/${SITE}/live_status`]: () => ({ status: 200, body: { response: { percentage_charged: 50 } } }),
        [`POST ${BASE}/api/1/energy_sites/${SITE}/${path}`]: fail,
      });
      const c = await connect(ctx);
      await c.callTool({ name: "get_energy_site_info", arguments: {} }); // warm the cache
      await c.callTool({ name: "get_energy_live_status", arguments: {} });
      const b = body(await c.callTool({ name: tool, arguments: { ...args, ...intent } }));
      assert.equal(b.code, "state_unknown", tool);
      const infoBefore = infoReads(calls).length;
      const liveBefore = calls.filter((x) => x.url.endsWith("/live_status")).length;
      const r = body(await c.callTool({ name: "get_energy_site_info", arguments: {} }));
      assert.equal(infoReads(calls).length, infoBefore + 1, `${tool}: site_info read-back reached the network`);
      assert.equal(r.servedFromMemorySec, 0, tool);
      await c.callTool({ name: "get_energy_live_status", arguments: {} });
      assert.equal(calls.filter((x) => x.url.endsWith("/live_status")).length, liveBefore + 1, `${tool}: live_status read-back reached the network`);
    }
  }
});

test("get_energy_site_info omits off_grid_vehicle_charging_reserve_percent when the site does not return it", async () => {
  const { ctx } = setup(baseEnv({ TESLA_DEFAULT_ENERGY_SITE_ID: SITE }), {
    [INFO]: info({ backup_reserve_percent: 20, components: { battery: true } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_energy_site_info", arguments: {} }));
  assert.equal(b.ok, true);
  assert.equal(b.backup_reserve_percent, 20);
  assert.ok(!(FIELD in b), "absent, not null or undefined-valued");
  assert.ok(!JSON.stringify(b).includes(FIELD));
});
