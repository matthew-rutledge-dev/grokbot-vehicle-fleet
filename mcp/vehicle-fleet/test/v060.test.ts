/**
 * 0.6.0 tools: navigation by coordinates, HomeLink, window control, media, cabin overheat
 * temperature, climate keeper, auto seat climate, valet (opt-in, PIN from env only),
 * experimental signed extras (opt-in), and the new reads. All HTTP goes to the fake fetch.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { encodeBoomboxAction, encodeDashcamSaveClipAction } from "../src/signed/messages.js";
import { parkCheck } from "../src/tools/commands.js";
import { dropLocation } from "../src/tools/energy.js";
import { redactShortSecrets } from "../src/redact.js";
import { daysOf, hhmm } from "../src/tools/extract.js";
import { FakeVehicle } from "./fake-vehicle.js";
import {
  BASE, OPT_IN_EXPERIMENTAL_COMMANDS, PROXY, VALET_COMMANDS, VIN, baseEnv, body, connect, fixtureData, isError, setup,
  tmpDir, type Call, type Route,
} from "./helpers.js";

const ON = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_VIN: VIN };
const intent = { confirm: true, user_request: "please do it" };
const ok: Route = () => ({ status: 200, body: { response: { result: true, reason: "" } } });
const cmd = (n: string, r: Route = ok) => ({ [`POST ${PROXY}/api/1/vehicles/${VIN}/command/${n}`]: r });
const cmdCalls = (calls: Call[]) => calls.filter((x) => x.url.includes("/command/"));
const sentBody = (c: Call) => JSON.parse(c.body ?? "{}");
const dataCalls = (calls: Call[]) => calls.filter((x) => new URL(x.url).pathname.endsWith("/vehicle_data"));
const liveData = (extra: Record<string, unknown>): Route => () => ({ status: 200, body: { response: { ...fixtureData(), ...extra } } });

// ---------- simple proxy commands: exact endpoint + body ----------

const CASES: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
  ["media_toggle_playback", {}, "media_toggle_playback", {}],
  ["media_next_track", {}, "media_next_track", {}],
  ["media_prev_track", {}, "media_prev_track", {}],
  ["media_next_fav", {}, "media_next_fav", {}],
  ["media_prev_fav", {}, "media_prev_fav", {}],
  ["media_volume_up", {}, "media_volume_up", {}],
  ["media_volume_down", {}, "media_volume_down", {}],
  ["adjust_volume", { volume: 0 }, "adjust_volume", { volume: 0 }],
  ["adjust_volume", { volume: 6.5 }, "adjust_volume", { volume: 6.5 }],
  ["adjust_volume", { volume: 10 }, "adjust_volume", { volume: 10 }],
  ["set_climate_keeper_mode", { mode: "off" }, "set_climate_keeper_mode", { climate_keeper_mode: 0 }],
  ["set_climate_keeper_mode", { mode: "on" }, "set_climate_keeper_mode", { climate_keeper_mode: 1 }],
  ["set_climate_keeper_mode", { mode: "dog" }, "set_climate_keeper_mode", { climate_keeper_mode: 2 }],
  ["set_climate_keeper_mode", { mode: "camp" }, "set_climate_keeper_mode", { climate_keeper_mode: 3 }],
  ["set_auto_seat_climate", { seat: "driver", on: true }, "remote_auto_seat_climate_request", { auto_seat_position: 1, auto_climate_on: true }],
  ["set_auto_seat_climate", { seat: "passenger", on: false }, "remote_auto_seat_climate_request", { auto_seat_position: 2, auto_climate_on: false }],
  ["set_cop_temp", { level: "low" }, "set_cop_temp", { cop_temp: 1 }],
  ["set_cop_temp", { level: "medium" }, "set_cop_temp", { cop_temp: 2 }],
  ["set_cop_temp", { level: "high" }, "set_cop_temp", { cop_temp: 3 }],
  ["window_control", { command: "close", vin: VIN }, "window_control", { command: "close" }],
];

test("0.6.0 commands: exact endpoint + body via the proxy, never direct, never wakes", async () => {
  for (const [tool, args, endpoint, expected] of CASES) {
    const { ctx, calls } = setup(baseEnv(ON), cmd(endpoint));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: tool, arguments: { ...args, ...intent } }));
    assert.equal(b.ok, true, `${tool} ${JSON.stringify(args)}`);
    const sent = cmdCalls(calls);
    assert.equal(sent.length, 1, tool);
    assert.equal(sent[0].url, `${PROXY}/api/1/vehicles/${VIN}/command/${endpoint}`);
    assert.deepEqual(sentBody(sent[0]), expected, `${tool} ${JSON.stringify(args)}`);
    assert.ok(!calls.some((x) => x.url.startsWith(BASE) && x.url.includes("/command/")), `${tool} never direct`);
    assert.ok(!calls.some((x) => x.url.includes("wake_up")), `${tool} no wake`);
  }
});

test("0.6.0 commands: out-of-range / bad values refused before any network call (with and without confirm)", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  const bad: Array<[string, Record<string, unknown>]> = [
    ["adjust_volume", { volume: -1 }], ["adjust_volume", { volume: 10.01 }], ["adjust_volume", { volume: 11 }],
    ["adjust_volume", { volume: "5" }], ["adjust_volume", {}], ["adjust_volume", { volume: Number.NaN }],
    ["set_cop_temp", { level: 0 }], ["set_cop_temp", { level: "max" }], ["set_cop_temp", {}],
    ["set_climate_keeper_mode", { mode: "eco" }], ["set_climate_keeper_mode", { mode: 2 }], ["set_climate_keeper_mode", { mode: "constructor" }],
    ["set_auto_seat_climate", { seat: "rear_left", on: true }], ["set_auto_seat_climate", { seat: "driver", on: "yes" }],
    ["window_control", { command: "open", vin: VIN }], ["window_control", { vin: VIN }],
    ["trigger_homelink", { lat: 91, lon: 0 }], ["trigger_homelink", { lat: 10 }], ["trigger_homelink", { lat: "1", lon: "2" }],
    ["share_navigation", { lat: 100, lon: 0 }], ["share_navigation", { lon: 5 }], ["share_navigation", {}],
  ];
  for (const [n, a] of bad) {
    for (const extra of [{}, intent]) {
      const res = await c.callTool({ name: n, arguments: { ...a, ...extra } });
      assert.equal(isError(res), true, `${n} ${JSON.stringify(a)}`);
      assert.equal(body(res).code, "invalid_arguments", `${n} ${JSON.stringify(a)}`);
    }
  }
  assert.equal(calls.length, 0);
});

test("0.6.0 commands: confirm without user_request is refused, nothing sent", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  for (const [n, a] of [["media_next_track", {}], ["adjust_volume", { volume: 3 }], ["set_climate_keeper_mode", { mode: "dog" }], ["trigger_homelink", {}]] as const) {
    const b = body(await c.callTool({ name: n, arguments: { ...a, confirm: true } }));
    assert.equal(b.code, "user_request_required", n);
  }
  assert.equal(calls.length, 0);
});

// ---------- navigation by coordinates ----------

test("share_navigation lat/lon: navigation_request (REST-only, straight to the Fleet API), text lat,lon, no order, coordinates never echoed", async () => {
  const { ctx, calls } = setup(baseEnv(ON), { [`POST ${BASE}/api/1/vehicles/${VIN}/command/navigation_request`]: ok });
  const c = await connect(ctx);
  const pre = body(await c.callTool({ name: "share_navigation", arguments: { lat: 12.3456789, lon: -45.6789012 } }));
  assert.equal(pre.endpoint, "POST /api/1/vehicles/{vin}/command/navigation_request");
  assert.ok(!JSON.stringify(pre).includes("12.34"), "preview hides coordinates");
  const b = body(await c.callTool({ name: "share_navigation", arguments: { lat: 12.3456789, lon: -45.6789012, ...intent } }));
  assert.equal(b.ok, true);
  assert.ok(!JSON.stringify(b).includes("12.34"));
  const sent = cmdCalls(calls);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].url.endsWith("/command/navigation_request"));
  const sb = sentBody(sent[0]);
  assert.equal(sb.type, "share_ext_content_raw");
  assert.deepEqual(sb.value, { "android.intent.extra.TEXT": "12.345679,-45.678901" });
  assert.equal("order" in sb, false);
  assert.ok(!calls.some((x) => x.url.includes("navigation_gps_request")));
});

test("share_navigation: destination and lat/lon together are refused (no silent preference), nothing sent", async () => {
  const { ctx, calls } = setup(baseEnv(ON), cmd("navigation_request"));
  const c = await connect(ctx);
  for (const extra of [{ lat: 1.5, lon: 2.5 }, { lat: 1.5 }, { lon: 2.5 }]) {
    const b = body(await c.callTool({ name: "share_navigation", arguments: { destination: "Example Place", ...extra, ...intent } }));
    assert.equal(b.code, "invalid_arguments", JSON.stringify(extra));
    assert.ok(!JSON.stringify(b).includes("Example Place"));
  }
  assert.equal(calls.length, 0);
});

// ---------- window vent gear check ----------

test("parkCheck: parked only for P, or explicit null gear with speed 0/null and drive_state present", () => {
  // allowed
  assert.equal(parkCheck({ drive_state: { shift_state: "P" } }), "parked");
  assert.equal(parkCheck({ drive_state: { shift_state: "P", speed: null } }), "parked");
  assert.equal(parkCheck({ drive_state: { shift_state: null, speed: 0 } }), "parked");
  assert.equal(parkCheck({ drive_state: { shift_state: null, speed: null } }), "parked");
  // the six fail-open cases from review: all gear_unknown now
  assert.equal(parkCheck({}), "gear_unknown", "response {}");
  assert.equal(parkCheck(null), "gear_unknown", "response null");
  assert.equal(parkCheck({ state: "online" }), "gear_unknown", "drive_state missing");
  assert.equal(parkCheck({ drive_state: {} }), "gear_unknown", "drive_state {}");
  assert.equal(parkCheck({ drive_state: null }), "gear_unknown", "drive_state null");
  assert.equal(parkCheck({ drive_state: { shift_state: null } }), "gear_unknown", "null gear, no speed");
  // other unknowns
  assert.equal(parkCheck({ drive_state: { speed: 0 } }), "gear_unknown", "no shift_state key");
  assert.equal(parkCheck({ drive_state: { shift_state: "" } }), "gear_unknown");
  assert.equal(parkCheck({ drive_state: { shift_state: null, speed: "0" } }), "gear_unknown");
  assert.equal(parkCheck({ drive_state: [] }), "gear_unknown");
  assert.equal(parkCheck([]), "gear_unknown");
  // moving / in gear
  assert.equal(parkCheck({ drive_state: { shift_state: null, speed: 12 } }), "not_parked");
  for (const g of ["D", "R", "N", "SNA", "Invalid"]) assert.equal(parkCheck({ drive_state: { shift_state: g } }), "not_parked", g);
});

test("window_control vent: sent only when parked; refused (nothing sent) when driving or the gear can't be read", async () => {
  const run = async (data: Route) => {
    const { ctx, calls } = setup(baseEnv(ON), { ...cmd("window_control"), [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data`]: data });
    const c = await connect(ctx);
    return { b: body(await c.callTool({ name: "window_control", arguments: { command: "vent", vin: VIN, ...intent } })), calls };
  };
  const p = await run(liveData({ drive_state: { shift_state: "P" } }));
  assert.equal(p.b.ok, true);
  assert.deepEqual(sentBody(cmdCalls(p.calls)[0]), { command: "vent" });
  assert.equal(new URL(dataCalls(p.calls)[0].url).searchParams.get("endpoints"), "drive_state");
  const parkedNull = await run(liveData({ drive_state: { shift_state: null, speed: null } }));
  assert.equal(parkedNull.b.ok, true);
  for (const ds of [{ shift_state: "D", speed: 30 }, { shift_state: "R" }, { shift_state: null, speed: 5 }]) {
    const r = await run(liveData({ drive_state: ds }));
    assert.equal(r.b.code, "not_parked", JSON.stringify(ds));
    assert.equal(cmdCalls(r.calls).length, 0);
  }
  const parkedZero = await run(liveData({ drive_state: { shift_state: null, speed: 0 } }));
  assert.equal(parkedZero.b.ok, true);
  const err = await run(() => ({ status: 500, body: { error: "boom" } }));
  assert.equal(err.b.code, "gear_unknown");
  assert.equal(cmdCalls(err.calls).length, 0);
  // fail closed: no usable gear in the live read -> gear_unknown, nothing sent
  const raw = (response: unknown): Route => () => ({ status: 200, body: { response } });
  const unknowns: Array<[string, Route]> = [
    ["drive_state missing", raw({ state: "online" })],
    ["drive_state {}", raw({ state: "online", drive_state: {} })],
    ["drive_state null", raw({ state: "online", drive_state: null })],
    ["shift_state null, no speed", raw({ state: "online", drive_state: { shift_state: null } })],
    ["response {}", raw({})],
    ["response null", raw(null)],
  ];
  for (const [label, route] of unknowns) {
    const r = await run(route);
    assert.equal(r.b.ok, false, label);
    assert.equal(r.b.code, "gear_unknown", label);
    assert.equal(cmdCalls(r.calls).length, 0, label);
  }
  // vent without an explicit vin is refused
  const { ctx } = setup(baseEnv(ON));
  const nv = body(await (await connect(ctx)).callTool({ name: "window_control", arguments: { command: "vent", ...intent } }));
  assert.equal(nv.ok, false);
});

test("window_control preview lists the gear check; close sends without any data read", async () => {
  const { ctx, calls } = setup(baseEnv(ON), cmd("window_control"));
  const c = await connect(ctx);
  const pre = body(await c.callTool({ name: "window_control", arguments: { command: "vent", vin: VIN } }));
  assert.match(JSON.stringify(pre.checksBeforeSend), /shift_state/);
  assert.equal(calls.length, 0);
  await c.callTool({ name: "window_control", arguments: { command: "close", vin: VIN, ...intent } });
  assert.equal(dataCalls(calls).length, 0);
});

// ---------- HomeLink ----------

test("trigger_homelink: needs homelink_nearby=true; coordinates from args or the car; never echoed", async () => {
  const run = async (data: Route, args: Record<string, unknown>, envx: Record<string, string> = {}) => {
    const { ctx, calls } = setup(baseEnv({ ...ON, ...envx }), { ...cmd("trigger_homelink"), [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data`]: data });
    const c = await connect(ctx);
    return { b: body(await c.callTool({ name: "trigger_homelink", arguments: { ...args, ...intent } })), calls };
  };
  const near = liveData({ vehicle_state: { homelink_nearby: true }, drive_state: { latitude: 37.123456, longitude: -122.654321 } });
  const a = await run(near, { lat: 40.5, lon: -74.25 });
  assert.equal(a.b.ok, true);
  assert.deepEqual(sentBody(cmdCalls(a.calls)[0]), { lat: 40.5, lon: -74.25 });
  assert.equal(new URL(dataCalls(a.calls)[0].url).searchParams.get("endpoints"), "vehicle_state");
  assert.ok(!JSON.stringify(a.b).includes("40.5"));
  const car = await run(near, {});
  assert.deepEqual(sentBody(cmdCalls(car.calls)[0]), { lat: 37.123456, lon: -122.654321 });
  assert.equal(new URL(dataCalls(car.calls)[0].url).searchParams.get("endpoints"), "vehicle_state;location_data;drive_state");
  assert.ok(!JSON.stringify(car.b).includes("37.12"));
  for (const vs of [{ homelink_nearby: false }, {}]) {
    const r = await run(liveData({ vehicle_state: vs }), { lat: 1, lon: 2 });
    assert.equal(r.b.code, "homelink_not_nearby");
    assert.equal(cmdCalls(r.calls).length, 0);
  }
  const off = await run(near, {}, { TESLA_FLEET_ENABLE_LOCATION: "0" });
  assert.equal(off.b.code, "location_required");
  assert.equal(off.calls.filter((x) => x.url.includes("/command/") || x.url.includes("vehicle_data")).length, 0);
  const err = await run(() => ({ status: 500, body: {} }), { lat: 1, lon: 2 });
  assert.equal(err.b.code, "homelink_state_unknown");
  assert.equal(cmdCalls(err.calls).length, 0);
  const noLoc = await run(liveData({ vehicle_state: { homelink_nearby: true }, drive_state: {} }), {});
  assert.equal(noLoc.b.code, "location_unavailable");
});

test("trigger_homelink: preview and TESLA_FLEET_DRY_RUN make no call and hide coordinates; description forbids automation", async () => {
  const { ctx, calls } = setup(baseEnv({ ...ON, TESLA_FLEET_DRY_RUN: "1" }));
  const c = await connect(ctx);
  const d = body(await c.callTool({ name: "trigger_homelink", arguments: { lat: 40.5, lon: -74.25, ...intent } }));
  assert.equal(d.dryRunMode, "TESLA_FLEET_DRY_RUN");
  assert.ok(!JSON.stringify(d).includes("40.5"));
  assert.match(JSON.stringify(d.wouldCheckFirst), /homelink_nearby/);
  assert.equal(calls.length, 0);
  const t = (await c.listTools()).tools.find((x) => x.name === "trigger_homelink");
  assert.match(String(t?.description), /never from a routine, schedule, geofence/);
});

// ---------- cabin overheat temperature mapping ----------

test("set_cop_temp: signed cars get the proxy enum (1/2/3); unsigned cars the docs' 0/1/2; unknown is refused", async () => {
  const fsRoute = (required: boolean | undefined): Route => () => ({ status: 200, body: { response: {
    key_paired_vins: [VIN], unpaired_vins: [],
    vehicle_info: { [VIN]: required === undefined ? {} : { vehicle_command_protocol_required: required } },
  } } });
  for (const [req, expected] of [[true, 1], [false, 0]] as const) {
    const { ctx, calls } = setup(baseEnv(ON), { ...cmd("set_cop_temp"), [`POST ${BASE}/api/1/vehicles/fleet_status`]: fsRoute(req) });
    const b = body(await (await connect(ctx)).callTool({ name: "set_cop_temp", arguments: { level: "low", ...intent } }));
    assert.equal(b.ok, true);
    assert.deepEqual(sentBody(cmdCalls(calls)[0]), { cop_temp: expected });
  }
  const { ctx, calls } = setup(baseEnv(ON), { ...cmd("set_cop_temp"), [`POST ${BASE}/api/1/vehicles/fleet_status`]: fsRoute(undefined) });
  const c = await connect(ctx);
  const u = body(await c.callTool({ name: "set_cop_temp", arguments: { level: "high", ...intent } }));
  assert.equal(u.code, "cop_mapping_unknown");
  assert.equal(cmdCalls(calls).length, 0);
  const pre = body(await c.callTool({ name: "set_cop_temp", arguments: { level: "medium" } }));
  assert.deepEqual(pre.body, { cop_temp: 2 });
  assert.match(JSON.stringify(pre.notes), /low 0, medium 1, high 2/);
});

// ---------- valet (opt-in; PIN from env only) ----------

const PIN = "7391";
const VALET_ON = { ...ON, TESLA_FLEET_ENABLE_VALET: "1", TESLA_FLEET_VALET_PIN: PIN };

test("valet tools: hidden unless read-only is off AND TESLA_FLEET_ENABLE_VALET is on; refused when hidden", async () => {
  for (const [envx, code] of [[{}, "readOnly"], [{ TESLA_FLEET_READ_ONLY: "false" }, "optInRequired"], [{ TESLA_FLEET_READ_ONLY: "false", TESLA_FLEET_ENABLE_VALET: "maybe" }, "optInRequired"], [{ TESLA_FLEET_ENABLE_VALET: "1" }, "readOnly"]] as const) {
    const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN, TESLA_FLEET_VALET_PIN: PIN, ...envx }));
    const c = await connect(ctx);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of VALET_COMMANDS) {
      assert.ok(!names.includes(n), `${n} hidden ${JSON.stringify(envx)}`);
      const res = await c.callTool({ name: n, arguments: { on: true, vin: VIN, ...intent } });
      assert.equal(isError(res), true);
      assert.ok(code in body(res), `${n} ${code}`);
      assert.ok(!JSON.stringify(body(res)).includes(PIN));
    }
    assert.equal(calls.length, 0);
  }
  const { ctx } = setup(baseEnv(VALET_ON));
  const names = (await (await connect(ctx)).listTools()).tools.map((t) => t.name);
  assert.ok(VALET_COMMANDS.every((n) => names.includes(n)));
});

test("set_valet_mode on: PIN from TESLA_FLEET_VALET_PIN reaches only the proxy body; never in preview, dry-run, result, describe_boundary", async () => {
  const { ctx, calls } = setup(baseEnv(VALET_ON), cmd("set_valet_mode"));
  const c = await connect(ctx);
  const outputs: unknown[] = [];
  const pre = body(await c.callTool({ name: "set_valet_mode", arguments: { on: true, vin: VIN } }));
  outputs.push(pre);
  assert.deepEqual(pre.body, { on: true, password: "[from TESLA_FLEET_VALET_PIN, never shown]" });
  const sent = body(await c.callTool({ name: "set_valet_mode", arguments: { on: true, vin: VIN, ...intent } }));
  outputs.push(sent);
  assert.equal(sent.ok, true);
  const s = cmdCalls(calls);
  assert.equal(s.length, 1);
  assert.deepEqual(sentBody(s[0]), { on: true, password: PIN });
  const db = body(await c.callTool({ name: "describe_boundary", arguments: {} }));
  outputs.push(db);
  assert.equal((db.valet as Record<string, unknown>).pinConfigured, true);
  outputs.push((await c.listTools()).tools);
  for (const o of outputs) assert.ok(!JSON.stringify(o).includes(PIN), "PIN never in output");
  const { ctx: dctx, calls: dcalls } = setup(baseEnv({ ...VALET_ON, TESLA_FLEET_DRY_RUN: "1" }));
  const dry = body(await (await connect(dctx)).callTool({ name: "set_valet_mode", arguments: { on: true, vin: VIN, ...intent } }));
  assert.equal(dry.dryRunMode, "TESLA_FLEET_DRY_RUN");
  assert.ok(!JSON.stringify(dry).includes(PIN));
  assert.equal(dcalls.length, 0);
});

test("set_valet_mode: rejection and error replies never carry the PIN; off sends no PIN; reset sends {}", async () => {
  const rej: Route = () => ({ status: 200, body: { response: { result: false, reason: "not_in_park" } } });
  const { ctx, calls } = setup(baseEnv(VALET_ON), { ...cmd("set_valet_mode", rej), ...cmd("reset_valet_pin") });
  const c = await connect(ctx);
  const r = body(await c.callTool({ name: "set_valet_mode", arguments: { on: true, vin: VIN, ...intent } }));
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(PIN));
  await c.callTool({ name: "set_valet_mode", arguments: { on: false, vin: VIN, ...intent } });
  assert.deepEqual(sentBody(cmdCalls(calls)[1]), { on: false });
  const z = body(await c.callTool({ name: "reset_valet_pin", arguments: { vin: VIN, ...intent } }));
  assert.equal(z.ok, true);
  assert.deepEqual(sentBody(cmdCalls(calls)[2]), {});
  const { ctx: ectx } = setup(baseEnv(VALET_ON), cmd("set_valet_mode", () => ({ status: 500, body: { error: "internal" } })));
  const e = await (await connect(ectx)).callTool({ name: "set_valet_mode", arguments: { on: true, vin: VIN, ...intent } });
  assert.ok(!JSON.stringify(body(e)).includes(PIN));
});

test("set_valet_mode: an upstream 400 body or a result:false reason that echoes the request never leaks the PIN", async () => {
  const echoes: Array<[string, Route]> = [
    ["400 echo", (call) => ({ status: 400, body: { error: `invalid request: ${call.body}`, error_description: `password ${PIN} rejected`, pin: Number(PIN) } })],
    ["result:false echo", (call) => ({ status: 200, body: { response: { result: false, reason: `bad password ${PIN}; request was ${call.body}` } } })],
    ["result:false bare", () => ({ status: 200, body: { response: { result: false, reason: PIN } } })],
    ["422 echo", () => ({ status: 422, body: { error: `password=${PIN}` } })],
  ];
  for (const [label, route] of echoes) {
    const { ctx, calls } = setup(baseEnv(VALET_ON), cmd("set_valet_mode", route));
    const res = await (await connect(ctx)).callTool({ name: "set_valet_mode", arguments: { on: true, vin: VIN, ...intent } });
    const b = body(res);
    assert.equal(b.ok, false, label);
    assert.equal(cmdCalls(calls).length, 1, `${label}: sent once`);
    assert.deepEqual(sentBody(cmdCalls(calls)[0]), { on: true, password: PIN });
    assert.ok(!JSON.stringify(res).includes(PIN), `${label}: PIN not in result: ${JSON.stringify(res)}`);
    assert.match(JSON.stringify(b), /\[redacted\]/, label);
  }
});

test("redactShortSecrets: only digit-bounded matches, numbers equal to the secret, keys; JSON-safe", () => {
  const out = redactShortSecrets({ a: "pin 7391 x", b: 7391, c: "173910 and 73911", d: [{ "7391": "ok" }], e: 7392, f: true }, ["7391"]);
  assert.deepEqual(out, { a: "pin [redacted] x", b: "[redacted]", c: "173910 and 73911", d: [{ "[redacted]": "ok" }], e: 7392, f: true });
  assert.deepEqual(redactShortSecrets({ a: "7391" }, [undefined]), { a: "7391" });
});

test("set_valet_mode: PIN never accepted as an argument; missing or malformed env PIN refused without echo; explicit vin required", async () => {
  {
    const { ctx, calls } = setup(baseEnv(VALET_ON));
    const c = await connect(ctx);
    for (const k of ["pin", "password", "valet_pin", "PIN", "Password", "PASSWORD", "valetPin", "Valet-Pin", "passcode"]) {
      const b = body(await c.callTool({ name: "set_valet_mode", arguments: { on: true, vin: VIN, [k]: "1234", ...intent } }));
      assert.equal(b.code, "invalid_arguments", k);
      assert.ok(!JSON.stringify(b).includes("1234"));
    }
    assert.equal(cmdCalls(calls).length, 0);
    const nv = body(await c.callTool({ name: "set_valet_mode", arguments: { on: true, ...intent } }));
    assert.equal(nv.ok, false);
    assert.equal(cmdCalls(calls).length, 0);
  }
  for (const [pin, code] of [[undefined, "valet_pin_not_configured"], ["12345", "valet_pin_invalid"], ["12a4", "valet_pin_invalid"]] as const) {
    const envx: Record<string, string> = { ...ON, TESLA_FLEET_ENABLE_VALET: "on" };
    if (pin) envx.TESLA_FLEET_VALET_PIN = pin;
    const { ctx, calls } = setup(baseEnv(envx), cmd("set_valet_mode"));
    const b = body(await (await connect(ctx)).callTool({ name: "set_valet_mode", arguments: { on: true, vin: VIN, ...intent } }));
    assert.equal(b.code, code);
    if (pin) assert.ok(!JSON.stringify(b).includes(pin));
    assert.equal(cmdCalls(calls).length, 0);
  }
});

// ---------- experimental signed extras (opt-in) ----------

function keyFile(): string {
  const p = path.join(tmpDir(), "command-key.pem");
  const pem = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "sec1" }) as string;
  fs.writeFileSync(p, pem, { mode: 0o600 });
  return p;
}

const expEnv = (extra: Record<string, string> = {}) => baseEnv({
  ...ON, TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS: "1", TESLA_FLEET_COMMAND_KEY_FILE: keyFile(),
  TESLA_FLEET_AUDIT_LOG: path.join(tmpDir(), "audit.jsonl"), ...extra,
});

const signedRoute = (v: FakeVehicle): Record<string, Route> => ({
  [`POST ${BASE}/api/1/vehicles/${VIN}/signed_command`]: async (call) => ({ status: 200, body: { response: await v.handle(VIN, JSON.parse(call.body!).routable_message as string) } }),
});

test("experimental extras: hidden unless read-only off AND TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS; titled experimental", async () => {
  for (const envx of [{ TESLA_FLEET_READ_ONLY: "false" }, { TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS: "1" }] as Array<Record<string, string>>) {
    const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN, ...envx }));
    const c = await connect(ctx);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of OPT_IN_EXPERIMENTAL_COMMANDS) {
      assert.ok(!names.includes(n));
      assert.equal(isError(await c.callTool({ name: n, arguments: { sound: "locate_ping", ...intent } })), true);
    }
    assert.equal(calls.length, 0);
  }
  const { ctx } = setup(expEnv());
  const tools = (await (await connect(ctx)).listTools()).tools.filter((t) => OPT_IN_EXPERIMENTAL_COMMANDS.includes(t.name));
  assert.equal(tools.length, 2);
  for (const t of tools) {
    assert.match(String(t.description), /^EXPERIMENTAL, OPT-IN/);
    assert.match(String(t.title), /experimental/);
  }
});

test("remote_boombox: only fart (0) or locate_ping (2000); preview makes no call", async () => {
  const { ctx, calls } = setup(expEnv());
  const c = await connect(ctx);
  for (const sound of [1, "2000", "horn", 2000, undefined]) {
    const b = body(await c.callTool({ name: "remote_boombox", arguments: { sound, ...intent } }));
    assert.equal(b.code, "invalid_arguments", String(sound));
  }
  const pre = body(await c.callTool({ name: "remote_boombox", arguments: { sound: "locate_ping" } }));
  assert.equal(pre.dryRun, true);
  assert.equal(pre.soundId, 2000);
  assert.deepEqual(pre.action, { vehicleAction: 64, name: "boomboxAction", payloadBytes: encodeBoomboxAction(2000).length });
  assert.equal(calls.length, 0);
});

test("remote_boombox + dashcam_save_clip: signed send carries exactly the expected CarServer action; audited", async () => {
  for (const [tool, args, action] of [
    ["remote_boombox", { sound: "locate_ping" }, encodeBoomboxAction(2000)],
    ["remote_boombox", { sound: "fart" }, encodeBoomboxAction(0)],
    ["dashcam_save_clip", {}, encodeDashcamSaveClipAction()],
  ] as const) {
    const v = new FakeVehicle({ vin: VIN });
    const e = expEnv();
    const { ctx, calls } = setup(e, signedRoute(v));
    const b = body(await (await connect(ctx)).callTool({ name: tool, arguments: { ...args, ...intent } }));
    assert.equal(b.ok, true, tool);
    assert.equal(b.authenticatedResponse, true);
    const cmds = v.received.filter((r) => r.kind === "command");
    assert.equal(cmds.length, 1);
    assert.ok(cmds[0].action!.equals(action), `${tool} action bytes`);
    assert.ok(!calls.some((x) => x.url.startsWith(PROXY)), "never via the proxy");
    const lines = fs.readFileSync(e.TESLA_FLEET_AUDIT_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.event), ["attempt", "result"]);
    assert.ok(lines.every((l) => l.tool === tool && l.experimental === true));
  }
});

test("remote_boombox: the car's robotaxi-only locate ping refusal = locate_ping_robotaxi_only with a fart hint; not retried (0.7.1)", async () => {
  for (const [reason, code] of [
    ["RemoteBoombox locate ping only allowed in robotaxi mode under 10 mph", "locate_ping_robotaxi_only"],
    // Phrase match (0.7.2 docs): other wording around the phrase, any case, still maps.
    ["vehicle error: LOCATE PING ONLY ALLOWED IN ROBOTAXI MODE (speed check)", "locate_ping_robotaxi_only"],
    ["not_supported", "vehicle_rejected"],
  ] as const) {
    const v = new FakeVehicle({ vin: VIN, answer: "error", reason });
    const { ctx } = setup(expEnv(), signedRoute(v));
    const b = body(await (await connect(ctx)).callTool({ name: "remote_boombox", arguments: { sound: "locate_ping", ...intent } }));
    assert.equal(b.ok, false);
    assert.equal(b.sent, true);
    assert.equal(b.code, code);
    assert.equal(b.reason, reason);
    if (code === "locate_ping_robotaxi_only") assert.match(String(b.hint), /fart/);
    else assert.equal(b.hint, undefined);
    assert.equal(v.received.filter((r) => r.kind === "command").length, 1, "no retry");
  }
});

test("encodeBoomboxAction: Action.vehicleAction(2) > boomboxAction(64, tag 0x82 0x04) > sound(1) varint; sound 0 = empty inner message", () => {
  assert.equal(encodeBoomboxAction(2000).toString("hex"), "120682040308d00f");
  assert.equal(encodeBoomboxAction(0).toString("hex"), "1203820400");
});

test("experimental extras honour TESLA_FLEET_DRY_RUN and the missing-key refusal", async () => {
  const { ctx, calls } = setup(expEnv({ TESLA_FLEET_DRY_RUN: "1" }));
  const d = body(await (await connect(ctx)).callTool({ name: "dashcam_save_clip", arguments: intent }));
  assert.equal(d.dryRunMode, "TESLA_FLEET_DRY_RUN");
  assert.equal(calls.length, 0);
  const e = expEnv();
  delete (e as Record<string, string>).TESLA_FLEET_COMMAND_KEY_FILE;
  const { ctx: k, calls: kc } = setup(e);
  const r = body(await (await connect(k)).callTool({ name: "remote_boombox", arguments: { sound: "fart", ...intent } }));
  assert.equal(r.code, "command_key_not_configured");
  assert.equal(kc.length, 0);
});

// ---------- reads ----------

test("get_climate / get_battery_charge include the new fields; get_security_status reads valet, speed limit, HomeLink", async () => {
  const cached: Route = () => ({ status: 200, body: { response: {
    ...fixtureData(),
    climate_state: { timestamp: 1, steering_wheel_heat_level: 1, auto_steering_wheel_heat: true, auto_seat_climate_left: true, auto_seat_climate_right: false, cop_activation_temperature: "Medium", climate_keeper_mode: "dog" },
    charge_state: { timestamp: 1, charge_current_request_max: 48 },
    vehicle_state: { timestamp: 1, valet_mode: false, valet_pin_needed: true, homelink_nearby: true, homelink_device_count: 1,
      speed_limit_mode: { active: false, current_limit_mph: 85, max_limit_mph: 120, min_limit_mph: 50, pin_code_set: true, extra: "x" } },
  } } });
  const { ctx } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), { [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data_cached`]: cached });
  const c = await connect(ctx);
  const cl = body(await c.callTool({ name: "get_climate", arguments: {} })).climate as Record<string, unknown>;
  for (const k of ["steering_wheel_heat_level", "auto_steering_wheel_heat", "auto_seat_climate_left", "auto_seat_climate_right", "cop_activation_temperature"]) assert.ok(k in cl, k);
  const ch = body(await c.callTool({ name: "get_battery_charge", arguments: {} })).charge as Record<string, unknown>;
  assert.equal(ch.charge_current_request_max, 48);
  const sec = body(await c.callTool({ name: "get_security_status", arguments: {} })).security as Record<string, unknown>;
  assert.equal(sec.valetMode, false);
  assert.equal(sec.valetPinNeeded, true);
  assert.equal(sec.homelinkNearby, true);
  assert.deepEqual(sec.speedLimitMode, { active: false, current_limit_mph: 85, max_limit_mph: 120, min_limit_mph: 50, pin_code_set: true });
});

test("get_media_state: live only (needs online), vehicle_state.media_info; refused when asleep with no data call", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), {
    [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data`]: liveData({ vehicle_state: { media_info: { audio_volume: 4.3, audio_volume_max: 11, now_playing_title: "Example Song", media_playback_status: "Playing", secret: "no" }, media_state: { remote_control_enabled: true } } }),
  });
  const b = body(await (await connect(ctx)).callTool({ name: "get_media_state", arguments: {} }));
  assert.deepEqual(b.media, { audio_volume: 4.3, audio_volume_max: 11, now_playing_title: "Example Song", media_playback_status: "Playing" });
  assert.equal(b.remoteControlEnabled, true);
  assert.equal(new URL(dataCalls(calls)[0].url).searchParams.get("endpoints"), "vehicle_state");
  const { ctx: a, calls: ac } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), { [`GET ${BASE}/api/1/vehicles/${VIN}`]: () => ({ status: 200, body: { response: { vin: VIN, state: "asleep" } } }) });
  const r = body(await (await connect(a)).callTool({ name: "get_media_state", arguments: {} }));
  assert.equal(r.code, "vehicle_not_online");
  assert.equal(dataCalls(ac).length, 0);
});

test("get_schedules: days and HH:MM decoded; schedule locations dropped", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), {
    [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data`]: liveData({
      charge_schedule_data: { charge_schedules: [{ id: 1, name: "Night", days_of_week: 62, start_enabled: true, start_time: 90, end_enabled: false, end_time: 0, one_time: false, enabled: true, latitude: 37.1, longitude: -122.2 }] },
      preconditioning_schedule_data: { precondition_schedules: [{ id: 2, name: "Work", days_of_week: 127, precondition_time: 450, one_time: false, enabled: true, latitude: 37.1, longitude: -122.2 }] },
    }),
  });
  const b = body(await (await connect(ctx)).callTool({ name: "get_schedules", arguments: {} }));
  const cs = (b.chargeSchedules as Array<Record<string, unknown>>)[0];
  assert.deepEqual(cs.days, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  assert.equal(cs.start, "01:30");
  assert.equal(cs.end, undefined);
  const ps = (b.preconditionSchedules as Array<Record<string, unknown>>)[0];
  assert.equal(ps.departure, "07:30");
  assert.equal(ps.days && (ps.days as string[]).length, 7);
  assert.ok(!JSON.stringify(b).includes("37.1"), "no schedule location");
  assert.equal(new URL(dataCalls(calls)[0].url).searchParams.get("endpoints"), "charge_schedule_data;preconditioning_schedule_data");
});

test("daysOf / hhmm reject junk", () => {
  assert.equal(daysOf(-1), undefined);
  assert.equal(daysOf("62"), undefined);
  assert.deepEqual(daysOf(65), ["Sun", "Sat"]);
  assert.equal(hhmm(1440), undefined);
  assert.equal(hhmm(0), "00:00");
});

test("dropLocation strips location keys at every depth (objects and arrays)", () => {
  const out = dropLocation({
    energy_added_wh: 1, latitude: 1.1, site: { name: "x", location: { lat: 2.2, lon: 3.3 }, gps_lat: 4.4, nested: [{ longitude: 5.5, ok: 1 }] },
    list: [{ lat: 6.6, v: 2 }], vehicle: { last_location: "y", coordinates: [7.7, 8.8], vin_hash: "z" },
  });
  const j = JSON.stringify(out);
  for (const v of ["1.1", "2.2", "3.3", "4.4", "5.5", "6.6", "7.7", "8.8", "last_location", "coordinates"]) assert.ok(!j.includes(v), v);
  assert.deepEqual(out, { energy_added_wh: 1, site: { name: "x", nested: [{ ok: 1 }] }, list: [{ v: 2 }], vehicle: { vin_hash: "z" } });
});

test("get_wall_connector_charge_history: telemetry_history kind=charge, bounded range, location fields dropped", async () => {
  const SITE = "1234567890";
  let seen = "";
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_ENERGY_SITE_ID: SITE }), {
    [`GET ${BASE}/api/1/energy_sites/${SITE}/telemetry_history`]: (call) => {
      seen = call.url;
      return { status: 200, body: { response: { charge_history: [
        { charging_start_time: { seconds: 1 }, energy_added_wh: 5000, latitude: 1.23456 },
        { charging_start_time: { seconds: 2 }, energy_added_wh: 2500.4, gps_location: "x", vehicle: { location: { latitude: 9.87654 } } },
      ] } } };
    },
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_wall_connector_charge_history", arguments: { start_date: "2026-01-01", end_date: "2026-01-31", time_zone: "America/New_York", include_sessions: true } }));
  assert.equal(b.sessions, 2);
  assert.equal(b.totalEnergyAddedWh, 7500);
  assert.ok(!JSON.stringify(b).includes("1.23456"));
  assert.ok(!JSON.stringify(b).includes("gps_location"));
  assert.ok(!JSON.stringify(b).includes("9.87654"), "nested location dropped");
  const u = new URL(seen);
  assert.equal(u.searchParams.get("kind"), "charge");
  assert.equal(u.searchParams.get("period"), null);
  assert.equal(u.searchParams.get("time_zone"), "America/New_York");
  const n = calls.length;
  const bad = await c.callTool({ name: "get_wall_connector_charge_history", arguments: { start_date: "2026-01-01", end_date: "2026-03-01" } });
  assert.equal(body(bad).code, "bad_history_args");
  assert.equal(calls.length, n);
});
