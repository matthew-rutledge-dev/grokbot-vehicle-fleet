import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENERGY_COMMANDS, SEED, baseEnv, body, connect, isError, setup } from "./helpers.js";
import type { Call, Route } from "./helpers.js";

const SITE = "1234567890";
const ON = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_ENERGY_SITE_ID: SITE };
const intent = { confirm: true, user_request: "set it please" };
const updated: Route = () => ({ status: 200, body: { response: { code: 201, message: "Updated" } } });
const routesFor = (paths: string[], r: Route = updated) =>
  Object.fromEntries(paths.map((p) => [`POST ${BASE}/api/1/energy_sites/${SITE}/${p}`, r]));
const energyCalls = (calls: Call[]) => calls.filter((x) => x.url.includes("/energy_sites/"));

const CASES: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
  ["set_backup_reserve", { backup_reserve_percent: 15 }, "backup", { backup_reserve_percent: 15 }],
  ["set_operation_mode", { default_real_mode: "autonomous" }, "operation", { default_real_mode: "autonomous" }],
  ["set_storm_mode", { enabled: false }, "storm_mode", { enabled: false }],
  ["set_grid_import_export", { customer_preferred_export_rule: "pv_only" }, "grid_import_export", { customer_preferred_export_rule: "pv_only" }],
  ["set_grid_import_export", { disallow_charge_from_grid_with_solar_installed: true, customer_preferred_export_rule: "battery_ok" }, "grid_import_export",
    { disallow_charge_from_grid_with_solar_installed: true, customer_preferred_export_rule: "battery_ok" }],
];

test("energy commands: exact path + body direct to the Fleet API (not the proxy), bearer auth", async () => {
  for (const [tool, args, path, expected] of CASES) {
    const { ctx, calls } = setup(baseEnv(ON), routesFor([path]));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: tool, arguments: { ...args, ...intent } }));
    assert.equal(b.ok, true, tool);
    const sent = energyCalls(calls);
    assert.equal(sent.length, 1, tool);
    assert.equal(sent[0].url, `${BASE}/api/1/energy_sites/${SITE}/${path}`);
    assert.equal(sent[0].method, "POST");
    assert.deepEqual(JSON.parse(sent[0].body ?? "{}"), expected, tool);
    assert.match(sent[0].headers.Authorization, /^Bearer access-EXAMPLE-/);
    assert.equal(sent[0].dispatcher, undefined, "not via the vehicle proxy");
  }
});

test("energy commands: preview without confirm, hidden + refused in read-only, zero network", async () => {
  {
    const { ctx, calls } = setup(baseEnv(ON));
    const c = await connect(ctx);
    for (const [tool, args] of CASES) {
      const b = body(await c.callTool({ name: tool, arguments: args }));
      assert.equal(b.dryRun, true, tool);
    }
    assert.equal(calls.length, 0);
  }
  for (const ro of [undefined, "true", "maybe"]) {
    const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_ENERGY_SITE_ID: SITE, ...(ro ? { TESLA_FLEET_READ_ONLY: ro } : {}) }));
    const c = await connect(ctx);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ENERGY_COMMANDS) {
      assert.ok(!names.includes(n), n);
      const res = await c.callTool({ name: n, arguments: { ...intent, backup_reserve_percent: 15 } });
      assert.equal(isError(res), true);
      assert.equal(body(res).readOnly, true);
    }
    assert.equal(calls.length, 0);
  }
});

test("energy commands: invalid params and site ids refused before any network call", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["set_backup_reserve", { backup_reserve_percent: 101 }, "invalid_arguments"],
    ["set_backup_reserve", { backup_reserve_percent: -1 }, "invalid_arguments"],
    ["set_backup_reserve", { backup_reserve_percent: 15.5 }, "invalid_arguments"],
    ["set_operation_mode", { default_real_mode: "backup" }, "invalid_arguments"],
    ["set_storm_mode", { enabled: "on" }, "invalid_arguments"],
    ["set_grid_import_export", {}, "invalid_arguments"],
    ["set_grid_import_export", { customer_preferred_export_rule: "always" }, "invalid_arguments"],
    ["set_backup_reserve", { backup_reserve_percent: 15, energy_site_id: 1234567890 }, "bad_site_id"],
  ];
  for (const [n, a, code] of bad) {
    const res = await c.callTool({ name: n, arguments: { ...a, ...intent } });
    assert.equal(isError(res), true, n);
    assert.equal(body(res).code, code, `${n} ${JSON.stringify(a)}`);
  }
  assert.equal(body(await c.callTool({ name: "set_backup_reserve", arguments: { backup_reserve_percent: 15, confirm: true } })).code, "user_request_required");
  assert.equal(calls.length, 0);
});

test("energy dry-run mode returns the exact request; missing scope names energy_cmds; no leaks", async () => {
  {
    const { ctx, calls } = setup(baseEnv({ ...ON, TESLA_FLEET_DRY_RUN: "on" }));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: "set_backup_reserve", arguments: { backup_reserve_percent: 15, ...intent } }));
    assert.deepEqual(b.wouldSend, [{ method: "POST", url: `<fleet base>/api/1/energy_sites/${SITE}/backup`, body: { backup_reserve_percent: 15 } }]);
    assert.equal(calls.length, 0);
  }
  {
    const { ctx } = setup(baseEnv(ON), routesFor(["storm_mode"], () => ({ status: 403, body: { error: "unauthorized_missing_scopes", error_description: `missing scopes ${SEED}` } })));
    const c = await connect(ctx);
    const res = await c.callTool({ name: "set_storm_mode", arguments: { enabled: true, ...intent } });
    const b = body(res);
    assert.equal(b.code, "missing_energy_cmds_scope");
    assert.match(String(b.hint), /energy_cmds/);
    assert.match(String(b.hint), /--energy-commands/);
    assert.ok(!JSON.stringify(b).includes(SEED));
  }
});

test("energy commands: 5xx or reset mid-request = state_unknown; refused connection = not sent", async () => {
  const cases: Array<[Route, string, unknown]> = [
    [() => ({ status: 502, body: {} }), "state_unknown", "unknown"],
    [() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }); }, "state_unknown", "unknown"],
    [() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }, "fleet_api_unreachable", false],
  ];
  for (const [route, code, sent] of cases) {
    const { ctx, calls } = setup(baseEnv(ON), routesFor(["backup"], route));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: "set_backup_reserve", arguments: { backup_reserve_percent: 15, ...intent } }));
    assert.equal(b.code, code);
    assert.equal(b.sent, sent);
    assert.equal(energyCalls(calls).length, 1, "not retried");
  }
});
