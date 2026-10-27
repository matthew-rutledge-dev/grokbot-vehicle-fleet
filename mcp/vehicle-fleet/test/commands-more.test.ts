import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, PROXY, SEED, VIN, VEHICLE_COMMANDS, baseEnv, body, connect, fixtureData, isError, setup } from "./helpers.js";
import type { Call, Route } from "./helpers.js";

const ON = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_VIN: VIN };
const intent = { confirm: true, user_request: "please do it" };
const ok: Route = () => ({ status: 200, body: { response: { result: true, reason: "" } } });
const cmdRoutes = (names: string[], r: Route = ok) =>
  Object.fromEntries(names.map((n) => [`POST ${PROXY}/api/1/vehicles/${VIN}/command/${n}`, r]));
const cmdCalls = (calls: Call[]) => calls.filter((x) => x.url.includes("/command/"));
const sentBody = (c: Call) => JSON.parse(c.body ?? "{}");

/** tool -> [args, endpoint, exact body] (request shape per Fleet API vehicle command docs). */
const CASES: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
  ["door_lock", {}, "door_lock", {}],
  ["climate_start", {}, "auto_conditioning_start", {}],
  ["climate_stop", {}, "auto_conditioning_stop", {}],
  ["set_temps", { driver_temp: 21, passenger_temp: 22 }, "set_temps", { driver_temp: 21, passenger_temp: 22 }],
  ["set_seat_heater", { seat: "driver", level: 3 }, "remote_seat_heater_request", { seat_position: 0, seat_heater_level: 3, heater: 0, level: 3 }],
  ["set_seat_heater", { seat: "rear_center", level: 1 }, "remote_seat_heater_request", { seat_position: 4, seat_heater_level: 1, heater: 4, level: 1 }],
  ["set_steering_wheel_heater", { on: true }, "remote_steering_wheel_heater_request", { on: true }],
  ["set_cabin_overheat_protection", { on: true, fan_only: true }, "set_cabin_overheat_protection", { on: true, fan_only: true }],
  ["set_defrost_max", { on: false }, "set_preconditioning_max", { on: false }],
  ["set_sentry_mode", { on: true }, "set_sentry_mode", { on: true }],
  ["flash_lights", {}, "flash_lights", {}],
  ["honk_horn", {}, "honk_horn", {}],
  ["charge_start", {}, "charge_start", {}],
  ["charge_stop", {}, "charge_stop", {}],
  ["set_charge_limit", { percent: 80 }, "set_charge_limit", { percent: 80 }],
  ["set_charging_amps", { charging_amps: 16 }, "set_charging_amps", { charging_amps: 16 }],
  ["charge_port_door_open", {}, "charge_port_door_open", {}],
  ["charge_port_door_close", {}, "charge_port_door_close", {}],
];

test("every command: exact endpoint + body via the proxy, bearer auth, never direct, never wakes", async () => {
  for (const [tool, args, endpoint, expected] of CASES) {
    const { ctx, calls } = setup(baseEnv(ON), cmdRoutes([endpoint]));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: tool, arguments: { ...args, ...intent } }));
    assert.equal(b.ok, true, tool);
    const sent = cmdCalls(calls);
    assert.equal(sent.length, 1, tool);
    assert.equal(sent[0].url, `${PROXY}/api/1/vehicles/${VIN}/command/${endpoint}`, tool);
    assert.equal(sent[0].method, "POST");
    assert.deepEqual(sentBody(sent[0]), expected, tool);
    assert.match(sent[0].headers.Authorization, /^Bearer access-EXAMPLE-/);
    assert.ok(!calls.some((x) => x.url.startsWith(BASE) && x.url.includes("/command/")), `${tool} never direct`);
    assert.ok(!calls.some((x) => x.url.includes("wake_up")), `${tool} no wake`);
  }
});

test("every vehicle command: without confirm = preview with zero network; read-only hides and refuses", async () => {
  const argsFor = (n: string) => CASES.find((c) => c[0] === n)?.[1] ?? (n === "actuate_trunk" ? { which_trunk: "rear" } : n === "share_navigation" ? { destination: "1 Example Street" } : {});
  {
    const { ctx, calls } = setup(baseEnv(ON));
    const c = await connect(ctx);
    for (const n of VEHICLE_COMMANDS) {
      const b = body(await c.callTool({ name: n, arguments: argsFor(n) }));
      assert.equal(b.dryRun, true, n);
      assert.equal(b.sent, false, n);
    }
    assert.equal(calls.length, 0);
  }
  for (const ro of [undefined, "1", "maybe"]) {
    const env = baseEnv({ TESLA_DEFAULT_VIN: VIN, ...(ro ? { TESLA_FLEET_READ_ONLY: ro } : {}) });
    const { ctx, calls } = setup(env);
    const c = await connect(ctx);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of VEHICLE_COMMANDS) {
      assert.ok(!names.includes(n), `${n} hidden (${ro})`);
      const res = await c.callTool({ name: n, arguments: { ...argsFor(n), ...intent } });
      assert.equal(isError(res), true, n);
      assert.equal(body(res).readOnly, true, n);
    }
    assert.equal(calls.length, 0);
  }
});

test("invalid parameters are refused before any network call", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  const badCases: Array<[string, Record<string, unknown>]> = [
    ["set_charging_amps", { charging_amps: 0 }], ["set_charging_amps", { charging_amps: 49 }], ["set_charging_amps", { charging_amps: 10.5 }],
    ["set_charging_amps", { charging_amps: "16" }], ["set_seat_heater", { seat: "roof", level: 1 }], ["set_seat_heater", { seat: "driver", level: 4 }],
    ["set_seat_heater", { seat: "driver", level: -1 }], ["set_steering_wheel_heater", { on: "yes" }], ["set_sentry_mode", {}],
    ["set_defrost_max", { on: 1 }], ["set_cabin_overheat_protection", { on: true, fan_only: "no" }], ["set_charge_limit", { percent: 101 }],
    ["climate_warm_up", { seat_heat: 5 }], ["climate_warm_up", { defrost: "maybe" }], ["climate_warm_up", { seats: "all" }], ["climate_warm_up", { temp: "warm" }],
  ];
  for (const [n, a] of badCases) {
    for (const extra of [{}, intent]) {
      const res = await c.callTool({ name: n, arguments: { ...a, ...extra } });
      assert.equal(isError(res), true, `${n} ${JSON.stringify(a)}`);
      assert.equal(body(res).code, "invalid_arguments", `${n} ${JSON.stringify(a)}`);
    }
  }
  assert.equal(calls.length, 0);
});

test("TESLA_FLEET_DRY_RUN: confirmed command returns the exact request, zero network", async () => {
  const { ctx, calls } = setup(baseEnv({ ...ON, TESLA_FLEET_DRY_RUN: "1" }));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "set_charging_amps", arguments: { charging_amps: 16, ...intent } }));
  assert.equal(b.dryRunMode, "TESLA_FLEET_DRY_RUN");
  assert.equal(b.sent, false);
  assert.deepEqual(b.wouldSend, [{ method: "POST", url: `${PROXY}/api/1/vehicles/***${VIN.slice(-4)}/command/set_charging_amps`, body: { charging_amps: 16 } }]);
  assert.ok(!JSON.stringify(b).includes(VIN), "full VIN masked in dry-run output");
  const w = body(await c.callTool({ name: "wake_vehicle", arguments: intent }));
  assert.equal(w.dryRunMode, "TESLA_FLEET_DRY_RUN");
  assert.ok(!JSON.stringify(w).includes(VIN), "wake dry-run masks the VIN");
  assert.match(JSON.stringify(w.wouldSend), /\*\*\*MPLE\/wake_up/);
  const needsIntent = body(await c.callTool({ name: "flash_lights", arguments: { confirm: true } }));
  assert.equal(needsIntent.code, "user_request_required", "dry-run still needs user_request");
  const unlock = body(await c.callTool({ name: "door_unlock", arguments: intent }));
  assert.equal(unlock.code, "vin_required", "dry-run keeps the explicit-vin rule");
  assert.equal(calls.length, 0);
});

test("climate_warm_up defaults: plain call works with no args; extras only when cold", async () => {
  const cold = fixtureData();
  (cold.climate_state as Record<string, unknown>).outside_temp = -5;
  const steps = ["auto_conditioning_start", "set_temps", "remote_seat_heater_request", "remote_steering_wheel_heater_request", "set_preconditioning_max"];
  {
    const { ctx, calls } = setup(baseEnv(ON), {
      ...cmdRoutes(steps),
      [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data_cached`]: () => ({ status: 200, body: { response: cold } }),
    });
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: "climate_warm_up", arguments: { user_request: "turn on the heat", confirm: true } }));
    assert.equal(b.ok, true);
    const sent = cmdCalls(calls);
    assert.deepEqual(sent.map((x) => x.url.split("/command/")[1]), steps, "order: start, temps, seat, wheel, defrost");
    assert.deepEqual(sentBody(sent[1]), { driver_temp: 21, passenger_temp: 21 });
    assert.deepEqual(sentBody(sent[2]), { seat_position: 0, seat_heater_level: 2, heater: 0, level: 2 });
  }
  {
    const { ctx, calls } = setup(baseEnv(ON), cmdRoutes(steps)); // fixture outside_temp = 12 C: mild
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: "climate_warm_up", arguments: { user_request: "warm up the car", confirm: true } }));
    assert.equal(b.ok, true);
    assert.deepEqual(cmdCalls(calls).map((x) => x.url.split("/command/")[1]), ["auto_conditioning_start", "set_temps"]);
  }
});

test("climate_warm_up: env defaults and per-call overrides", async () => {
  const env = baseEnv({
    ...ON, TESLA_FLEET_DEFAULT_CLIMATE_TEMP_C: "22.5", TESLA_FLEET_DEFAULT_SEAT_HEAT_LEVEL: "3",
    TESLA_FLEET_DEFAULT_HEATED_SEATS: "front", TESLA_FLEET_STEERING_WHEEL_HEAT_WHEN_COLD: "off",
  });
  const { ctx, calls } = setup(env);
  const c = await connect(ctx);
  const p = body(await c.callTool({ name: "climate_warm_up", arguments: {} }));
  assert.equal(p.dryRun, true);
  const st = p.steps as Array<{ endpoint: string; body: Record<string, unknown> }>;
  assert.deepEqual(st[1].body, { driver_temp: 22.5, passenger_temp: 22.5 });
  const cond = p.conditionalSteps as Array<{ endpoint: string; when: string }>;
  assert.deepEqual(cond.map((s) => s.endpoint), ["remote_seat_heater_request", "remote_seat_heater_request", "set_preconditioning_max"]);
  const forced = body(await c.callTool({ name: "climate_warm_up", arguments: { temp: 70, unit: "F", seat_heat: 1, seats: "driver", defrost: false } }));
  const fs2 = forced.steps as Array<{ endpoint: string; body: Record<string, unknown> }>;
  assert.deepEqual(fs2.map((s) => s.endpoint), ["auto_conditioning_start", "set_temps", "remote_seat_heater_request"]);
  assert.deepEqual(fs2[1].body, { driver_temp: 21, passenger_temp: 21 });
  assert.equal(forced.conditionalSteps, undefined);
  assert.equal(calls.length, 0);
});

test("climate_warm_up: a mid-sequence rejection stops and reports completed steps", async () => {
  const { ctx, calls } = setup(baseEnv(ON), {
    ...cmdRoutes(["auto_conditioning_start"]),
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/set_temps`]: () => ({ status: 200, body: { response: { result: false, reason: "user_present" } } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "climate_warm_up", arguments: { ...intent, seat_heat: "off", defrost: false } }));
  assert.equal(b.ok, false);
  assert.equal(b.failedStep, "set_temps");
  assert.deepEqual((b.completedSteps as Array<{ endpoint: string }>).map((s) => s.endpoint), ["auto_conditioning_start"]);
  assert.equal(b.sent, "partial");
  assert.equal(b.failedStepSent, true);
  assert.equal(cmdCalls(calls).length, 2);
});

test("proxy down: connection refused = not sent, clear code; TLS failure too", async () => {
  for (const [code, want] of [["ECONNREFUSED", "proxy_unreachable"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "proxy_tls_error"]]) {
    const { ctx, calls } = setup(baseEnv(ON), {
      [`POST ${PROXY}/api/1/vehicles/${VIN}/command/flash_lights`]: () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
      },
    });
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: "flash_lights", arguments: intent }));
    assert.equal(b.code, want);
    assert.equal(b.sent, false);
    assert.equal(cmdCalls(calls).length, 1, "not retried");
  }
});

test("missing scope on a command names the scope and the auth-helper flag", async () => {
  const { ctx } = setup(baseEnv(ON), {
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/set_charging_amps`]: () => ({ status: 403, body: { error: "unauthorized_missing_scopes", error_description: "missing scopes" } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "set_charging_amps", arguments: { charging_amps: 16, ...intent } }));
  assert.equal(b.code, "missing_scope");
  assert.match(String(b.hint), /vehicle_charging_cmds/);
  assert.match(String(b.hint), /--commands/);
});

test("no token or secret leaks in command output", async () => {
  const { ctx } = setup(baseEnv(ON), {
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/honk_horn`]: (call) => ({ status: 400, body: { error: `bad ${call.headers.Authorization} ${SEED}` } }),
  });
  const c = await connect(ctx);
  const res = await c.callTool({ name: "honk_horn", arguments: intent });
  const text = JSON.stringify(body(res));
  assert.equal(isError(res), true);
  assert.ok(!text.includes(SEED));
  assert.ok(!/access-EXAMPLE-\d/.test(text), "access token redacted");
});

test("dry-run output masks the VIN and never echoes a navigation destination", async () => {
  const { ctx, calls } = setup(baseEnv({ ...ON, TESLA_FLEET_DRY_RUN: "1" }));
  const c = await connect(ctx);
  const nav = body(await c.callTool({ name: "share_navigation", arguments: { destination: "1 Example Street, Example City", ...intent } }));
  const text = JSON.stringify(nav);
  assert.ok(!text.includes("Example Street"), "destination not echoed");
  assert.ok(!text.includes(VIN));
  assert.match(text, /\*\*\*MPLE/);
  const gps = JSON.stringify(body(await c.callTool({ name: "share_navigation", arguments: { lat: 37.1234, lon: -122.5678, ...intent } })));
  assert.ok(!gps.includes("37.1234") && !gps.includes("122.5678"), "coordinates not echoed");
  const warm = JSON.stringify(body(await c.callTool({ name: "climate_warm_up", arguments: intent })));
  assert.ok(!warm.includes(VIN));
  assert.equal(calls.length, 0);
});

test("mid-request network errors and proxy 5xx = state_unknown, sent unknown, not retried", async () => {
  const failures: Array<[string, Route]> = [
    ["ECONNRESET", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }],
    ["UND_ERR_SOCKET", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }); }],
    ["no code", () => { throw new TypeError("fetch failed"); }],
    ["500", () => ({ status: 500, body: { error: "internal" } })],
    ["503", () => ({ status: 503, body: { error: "unavailable" } })],
  ];
  for (const [label, route] of failures) {
    const { ctx, calls } = setup(baseEnv(ON), { [`POST ${PROXY}/api/1/vehicles/${VIN}/command/flash_lights`]: route });
    const c = await connect(ctx);
    const res = await c.callTool({ name: "flash_lights", arguments: intent });
    const b = body(res);
    assert.equal(b.code, "state_unknown", label);
    assert.equal(b.sent, "unknown", label);
    assert.doesNotMatch(String(b.hint), /try again|retry/i, label);
    assert.equal(cmdCalls(calls).length, 1, `${label}: not retried`);
  }
});

test("failure before the command request (token refresh) is not reported as maybe-sent", async () => {
  let tokenCalls = 0;
  const { ctx, calls } = setup(baseEnv(ON), {
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/flash_lights`]: () => ({ status: 401, body: {} }),
    [`POST https://fleet-auth.example.test/oauth2/v3/token`]: () => {
      tokenCalls++;
      if (tokenCalls > 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return { status: 200, body: { access_token: "access-EXAMPLE-1", refresh_token: "rotated-EXAMPLE-1", expires_in: 28800 } };
    },
  });
  const c = await connect(ctx);
  const res = await c.callTool({ name: "flash_lights", arguments: intent });
  assert.equal(isError(res), true);
  assert.notEqual(body(res).code, "state_unknown");
  assert.equal(cmdCalls(calls).length, 1);
});

test("climate_warm_up: unknown outcome mid-sequence = sent partial, failed step unknown", async () => {
  const { ctx, calls } = setup(baseEnv(ON), {
    ...cmdRoutes(["auto_conditioning_start"]),
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/set_temps`]: () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); },
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "climate_warm_up", arguments: { ...intent, seat_heat: "off", defrost: false } }));
  assert.equal(b.sent, "partial");
  assert.equal(b.failedStepSent, "unknown");
  assert.equal(b.code, "state_unknown");
  assert.equal(b.failedStep, "set_temps");
  assert.equal(cmdCalls(calls).length, 2);
});

test("climate_warm_up: proxy down on the first step = sent false (not partial)", async () => {
  const { ctx } = setup(baseEnv(ON), {
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/auto_conditioning_start`]: () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); },
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "climate_warm_up", arguments: { ...intent, seat_heat: "off", defrost: false } }));
  assert.equal(b.sent, false);
  assert.equal(b.code, "proxy_unreachable");
});

test("proxy_not_configured hint names the variable and its alias", async () => {
  const env = baseEnv(ON);
  delete (env as Record<string, string | undefined>).TESLA_COMMAND_PROXY_URL;
  const { ctx } = setup(env);
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "flash_lights", arguments: intent }));
  assert.equal(b.code, "proxy_not_configured");
  assert.match(String(b.hint), /TESLA_COMMAND_PROXY_URL/);
  assert.match(String(b.hint), /TESLA_FLEET_PROXY_URL/);
});

const P = "car could not execute command: ";

async function sendWithReason(tool: string, endpoint: string, args: Record<string, unknown>, raw: string) {
  const { ctx } = setup(baseEnv(ON), {
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/${endpoint}`]: () => ({ status: 200, body: { response: { result: false, reason: raw } } }),
  });
  const c = await connect(ctx);
  return body(await c.callTool({ name: tool, arguments: { ...args, ...intent } }));
}

test("scoped no-op reasons are accepted on their own command (proxy-prefixed and bare); raw kept", async () => {
  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ["set_charge_limit", "set_charge_limit", { percent: 80 }, "already_set"],
    ["set_charging_amps", "set_charging_amps", { charging_amps: 16 }, "already_set"],
    ["charge_start", "charge_start", {}, "is_charging"],
    ["charge_start", "charge_start", {}, "complete"],
    ["charge_start", "charge_start", {}, "requested"],
    ["charge_stop", "charge_stop", {}, "not_charging"],
    ["charge_port_door_close", "charge_port_door_close", {}, "already closed"],
  ];
  for (const [tool, endpoint, args, reason] of cases) {
    for (const raw of [`${P}${reason}`, reason, `  Car Could Not Execute Command:  ${reason.toUpperCase()} `]) {
      const b = await sendWithReason(tool, endpoint, args, raw);
      assert.equal(b.ok, true, `${tool} ${raw}`);
      assert.equal(b.noChange, true, `${tool} ${raw}`);
      assert.equal(b.reason, reason);
      assert.equal(b.rawReason, raw, "raw reason kept");
    }
  }
});

test("charge_start with disconnected / no_power is a rejection with friendly text (prefixed and bare)", async () => {
  for (const [reason, text] of [["disconnected", /No charger is connected/], ["no_power", /not providing power/]] as const) {
    for (const raw of [`${P}${reason}`, reason]) {
      const b = await sendWithReason("charge_start", "charge_start", {}, raw);
      assert.equal(b.ok, false, raw);
      assert.equal(b.sent, true);
      assert.equal(b.noChange, undefined);
      assert.equal(b.reason, reason);
      assert.equal(b.rawReason, raw);
      assert.match(String(b.message), /Vehicle rejected the command/);
      assert.match(String(b.message), text);
    }
  }
});

test("a valid no-op reason on the wrong command is a rejection", async () => {
  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ["charge_stop", "charge_stop", {}, "is_charging"],
    ["charge_start", "charge_start", {}, "not_charging"],
    ["charge_start", "charge_start", {}, "already_set"],
    ["set_charge_limit", "set_charge_limit", { percent: 80 }, "complete"],
    ["climate_start", "auto_conditioning_start", {}, "already_set"],
    ["door_lock", "door_lock", {}, "already_started"],
    ["charge_port_door_open", "charge_port_door_open", {}, "already closed"],
  ];
  for (const [tool, endpoint, args, reason] of cases) {
    for (const raw of [`${P}${reason}`, reason]) {
      const b = await sendWithReason(tool, endpoint, args, raw);
      assert.equal(b.ok, false, `${tool} ${raw}`);
      assert.match(String(b.message), /Vehicle rejected the command/);
    }
  }
});

test("unrelated, look-alike and vcsec-prefixed reasons stay rejected", async () => {
  for (const raw of [`${P}user_present`, `${P}already_set_but_not_really`, `${P}constructor`, "vcsec could not execute command: already_set", "vcsec could not execute command: is_charging"]) {
    const tool = raw.includes("is_charging") ? "charge_start" : "set_charge_limit";
    const b = await sendWithReason(tool, tool, tool === "set_charge_limit" ? { percent: 80 } : {}, raw);
    assert.equal(b.ok, false, raw);
    assert.equal(b.rawReason, raw);
  }
});

test("energy command TLS failure points at the Fleet API, not the proxy CA variable", async () => {
  const SITE = "1234567890";
  const { ctx } = setup(baseEnv({ TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_ENERGY_SITE_ID: SITE }), {
    [`POST ${BASE}/api/1/energy_sites/${SITE}/storm_mode`]: () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }); },
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "set_storm_mode", arguments: { enabled: true, ...intent } }));
  assert.equal(b.code, "fleet_api_tls_error");
  assert.equal(b.sent, false);
  const text = JSON.stringify(b);
  assert.ok(!/PROXY_CA|command proxy|PROXY_CA_FILE/i.test(text), text);
  assert.match(String(b.error), /Fleet API/);
});

test("climate_warm_up: a proxy-wrapped rejection after completed steps returns sent 'partial'", async () => {
  const cold = fixtureData();
  (cold.climate_state as Record<string, unknown>).outside_temp = 1; // cold, not defrost-cold
  const { ctx, calls } = setup(baseEnv(ON), {
    ...cmdRoutes(["auto_conditioning_start", "set_temps"]),
    [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data_cached`]: () => ({ status: 200, body: { response: cold } }),
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/remote_seat_heater_request`]: () => ({ status: 200, body: { response: { result: false, reason: "car could not execute command: user_present" } } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "climate_warm_up", arguments: intent }));
  assert.equal(b.ok, false);
  assert.equal(b.sent, "partial");
  assert.equal(b.failedStepSent, true);
  assert.equal(b.failedStep, "remote_seat_heater_request");
  assert.equal(b.reason, "user_present");
  assert.equal(b.rawReason, "car could not execute command: user_present");
  assert.deepEqual((b.completedSteps as Array<{ endpoint: string }>).map((s) => s.endpoint), ["auto_conditioning_start", "set_temps"]);
  assert.equal(cmdCalls(calls).length, 3, "stopped at the rejection; steering wheel step not sent");
});
