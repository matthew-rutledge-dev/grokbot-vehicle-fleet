import assert from "node:assert/strict";
import { test } from "node:test";
import { toCelsius } from "../src/tools/commands.js";
import { BASE, PROXY, SEED, VIN, baseEnv, body, connect, isError, setup } from "./helpers.js";

const ON = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_VIN: VIN };
const intent = { confirm: true, user_request: "please lock my car" };

test("read-only (default) hides and refuses commands; nothing sent", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }));
  const c = await connect(ctx);
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes("door_lock") && !names.includes("wake_vehicle"));
  const res = await c.callTool({ name: "door_lock", arguments: intent });
  assert.equal(isError(res), true);
  assert.equal(body(res).readOnly, true);
  assert.equal(calls.length, 0);
});

test("without confirm: dry-run, zero network", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "set_charge_limit", arguments: { percent: 80 } }));
  assert.equal(b.dryRun, true);
  assert.equal(b.sent, false);
  assert.deepEqual(b.body, { percent: 80 });
  assert.equal(calls.length, 0);
});

test("confirm without user_request is refused (no routine/autonomous sends)", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  const res = await c.callTool({ name: "door_lock", arguments: { confirm: true } });
  assert.equal(body(res).code, "user_request_required");
  assert.equal(calls.length, 0);
});

test("happy path: online check, fleet_status, signed via proxy with bearer", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "door_lock", arguments: intent }));
  assert.equal(b.ok, true);
  assert.equal(b.sent, true);
  const cmd = calls.find((x) => x.url === `${PROXY}/api/1/vehicles/${VIN}/command/door_lock`)!;
  assert.ok(cmd, "sent to proxy, VIN in path");
  assert.match(cmd.headers.Authorization, /^Bearer access-EXAMPLE-/);
  assert.ok(!calls.some((x) => x.url.startsWith(BASE) && x.url.includes("/command/")), "never direct to Fleet API");
  assert.equal(calls.filter((x) => x.url.includes("wake_up")).length, 0);
});

test("asleep vehicle: command refused, no auto-wake", async () => {
  const { ctx, calls } = setup(baseEnv(ON), {
    [`GET ${BASE}/api/1/vehicles/${VIN}`]: () => ({ status: 200, body: { response: { vin: VIN, state: "asleep" } } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "door_lock", arguments: intent }));
  assert.equal(b.code, "vehicle_not_online");
  assert.ok(!calls.some((x) => x.url.includes("/command/") || x.url.includes("wake_up")));
});

test("unpaired key: refused before a billed command", async () => {
  const { ctx, calls } = setup(baseEnv({ ...ON, TESLA_FLEET_KEY_DOMAIN: "keys.example.com" }), {
    [`POST ${BASE}/api/1/vehicles/fleet_status`]: () => ({ status: 200, body: { response: { key_paired_vins: [], unpaired_vins: [VIN] } } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "door_lock", arguments: intent }));
  assert.equal(b.code, "virtual_key_missing");
  assert.match(String(b.hint), /_ak\/keys\.example\.com/);
  assert.ok(!calls.some((x) => x.url.includes("/command/")));
});

test("unlock + trunk need an explicit vin even with a default", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "door_unlock", arguments: { confirm: true, user_request: "unlock it" } }));
  assert.equal(b.code, "vin_required");
  const t = body(await c.callTool({ name: "actuate_trunk", arguments: { which_trunk: "rear" } }));
  assert.equal(t.vinLast4, "(explicit vin required)");
  assert.equal(calls.length, 0);
});

test("408 on command: state unknown, NOT retried", async () => {
  const { ctx, calls } = setup(baseEnv(ON), {
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/charge_start`]: () => ({ status: 408, body: { error: "vehicle unavailable" } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "charge_start", arguments: { ...intent, user_request: "start charging" } }));
  assert.equal(b.code, "state_unknown");
  assert.equal(calls.filter((x) => x.url.includes("/command/charge_start")).length, 1);
});

test("benign reasons are success with noChange", async () => {
  const { ctx } = setup(baseEnv(ON), {
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/set_charge_limit`]: () => ({ status: 200, body: { response: { result: false, reason: "already_set" } } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "set_charge_limit", arguments: { ...intent, percent: 80 } }));
  assert.equal(b.ok, true);
  assert.equal(b.noChange, true);
});

test("argument validation and temperature conversion", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "set_charge_limit", arguments: { ...intent, percent: 30 } }));
  assert.equal(b.code, "invalid_arguments");
  assert.equal(calls.length, 0);
  assert.equal(toCelsius(70, "F"), 21);
  assert.equal(toCelsius(100, "C"), 28);
  const nav = body(await c.callTool({ name: "share_navigation", arguments: { destination: "1 Example Street" } }));
  assert.ok(!JSON.stringify(nav).includes("Example Street"), "destination not echoed");
});

test("no proxy configured: refused, nothing sent", async () => {
  const env = baseEnv(ON);
  delete (env as Record<string, string | undefined>).TESLA_COMMAND_PROXY_URL;
  const { ctx, calls } = setup(env);
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "door_lock", arguments: intent }));
  assert.equal(b.code, "proxy_not_configured");
  assert.equal(calls.length, 0);
});

test("wake_vehicle: dry-run without confirm; skip if online; polls when asleep", async () => {
  let n = 0;
  const { ctx, calls } = setup(baseEnv(ON), {
    [`GET ${BASE}/api/1/vehicles/${VIN}`]: () => ({ status: 200, body: { response: { vin: VIN, state: ++n >= 3 ? "online" : "asleep" } } }),
    [`POST ${BASE}/api/1/vehicles/${VIN}/wake_up`]: () => ({ status: 200, body: { response: { vin: VIN, state: "asleep" } } }),
  });
  const c = await connect(ctx);
  assert.equal(body(await c.callTool({ name: "wake_vehicle", arguments: {} })).dryRun, true);
  assert.equal(calls.length, 0);
  const b = body(await c.callTool({ name: "wake_vehicle", arguments: { confirm: true, user_request: "wake the car" } }));
  assert.equal(b.state, "online");
  assert.equal(calls.filter((x) => x.url.includes("wake_up")).length, 1);
  const again = body(await c.callTool({ name: "wake_vehicle", arguments: { confirm: true, user_request: "wake the car" } }));
  assert.equal(again.sent, false, "already online: no second wake");
});

test("proxy CA: dispatcher built from the configured CA file (TLS never disabled)", async () => {
  const { buildProxyDispatcher } = await import("../src/fleet.js");
  assert.equal(buildProxyDispatcher(undefined), undefined);
  assert.throws(() => buildProxyDispatcher("/nonexistent/ca.pem"));
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/fleet.ts", import.meta.url), "utf8");
  assert.ok(!/rejectUnauthorized\s*:\s*false/.test(src));
});

test("errors never echo the refresh token", async () => {
  const { ctx } = setup(baseEnv(ON), {
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/door_lock`]: () => ({ status: 400, body: { error: `bad ${SEED}` } }),
  });
  const c = await connect(ctx);
  const res = await c.callTool({ name: "door_lock", arguments: intent });
  assert.equal(isError(res), true);
  assert.ok(!JSON.stringify(body(res)).includes(SEED));
});
