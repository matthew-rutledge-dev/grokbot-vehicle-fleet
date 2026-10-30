/**
 * 0.7.2: review follow-ups from 0.7.1 (URL stripping, nav cache invalidation, nav refusals with no
 * proxy, invalid_command wording) and the off-grid reserve read-back (confirmed / pending / mismatch).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mapFleetError } from "../src/errors.js";
import { OFF_GRID_READBACK_DELAY_MS, OFF_GRID_READBACK_TRIES } from "../src/tools/energy-commands.js";
import { buildContext } from "../src/server.js";
import { BASE, VIN, baseEnv, body, connect, fakeFetch, isError, routes, setup } from "./helpers.js";
import type { Call, Route } from "./helpers.js";

const intent = { confirm: true, user_request: "please do it" };
const NAV_REST = `POST ${BASE}/api/1/vehicles/${VIN}/command/navigation_request`;
const NO_PROXY = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_VIN: VIN, TESLA_COMMAND_PROXY_URL: "", TESLA_FLEET_PROXY_URL: "" };
const navCalls = (calls: Call[]) => calls.filter((x) => x.url.endsWith("/command/navigation_request"));

// --- (a) URL stripping -----------------------------------------------------------------------

test("invalid_value inner text has URLs removed", () => {
  const e = mapFleetError(400, { error: `https://a.internal.example/x => {Message: "bad value, see https://b.internal.example/help", Status: 400}` });
  assert.equal(e.info.code, "invalid_value");
  assert.match(e.info.message, /bad value, see \[url\]/);
  assert.ok(!e.info.message.includes("internal.example"));
});

test("404 / 412 / 422 fallbacks never echo URLs", () => {
  for (const [status, code] of [[404, "not_found"], [412, "precondition_failed"], [422, "invalid_resource"]] as const) {
    for (const b of [{ error_description: "nothing at https://x.internal.example/api/1/thing" }, { error: "https://x.internal.example/y gone" }]) {
      const e = mapFleetError(status, b);
      assert.equal(e.info.code, code, String(status));
      assert.ok(!e.info.message.includes("internal.example"), `${status}: ${e.info.message}`);
      assert.match(e.info.message, /\[url\]/);
    }
  }
  assert.match(mapFleetError(404, {}).info.message, /not found/i);
});

// --- (d) invalid_command wording -------------------------------------------------------------

test("invalid_command does not blame the command proxy (the reply may come from the Fleet API REST endpoint)", () => {
  const e = mapFleetError(400, { error: "invalid_command", error_description: "" });
  assert.equal(e.info.code, "invalid_command");
  assert.doesNotMatch(e.info.message, /^The command proxy/);
  assert.match(e.info.message, /Fleet API/);
});

// --- (c) nav with no proxy still refused when unpaired or offline ----------------------------

test("share_navigation with no proxy: unpaired key = virtual_key_missing, nothing sent", async () => {
  const { ctx, calls } = setup(baseEnv(NO_PROXY), {
    [`POST ${BASE}/api/1/vehicles/fleet_status`]: () => ({ status: 200, body: { response: { key_paired_vins: [], unpaired_vins: [VIN] } } }),
    [NAV_REST]: () => { throw new Error("must not send"); },
  });
  const res = await (await connect(ctx)).callTool({ name: "share_navigation", arguments: { destination: "1 Example Street", ...intent } });
  assert.equal(isError(res), true);
  assert.equal(body(res).code, "virtual_key_missing");
  assert.equal(navCalls(calls).length, 0);
});

test("share_navigation with no proxy: vehicle asleep/offline = vehicle_not_online, nothing sent, no wake", async () => {
  for (const state of ["asleep", "offline"]) {
    const { ctx, calls } = setup(baseEnv(NO_PROXY), {
      [`GET ${BASE}/api/1/vehicles/${VIN}`]: () => ({ status: 200, body: { response: { vin: VIN, state } } }),
      [NAV_REST]: () => { throw new Error("must not send"); },
    });
    const res = await (await connect(ctx)).callTool({ name: "share_navigation", arguments: { lat: 1.25, lon: 2.5, ...intent } });
    assert.equal(isError(res), true, state);
    assert.equal(body(res).code, "vehicle_not_online", state);
    assert.equal(navCalls(calls).length, 0, state);
    assert.ok(!calls.some((x) => x.url.endsWith("/wake_up")), state);
  }
});

// --- (b) cache invalidation in finally -------------------------------------------------------

test("REST-only command clears cached vehicle data even when the send fails", async () => {
  for (const nav of [
    (() => ({ status: 500, body: {} })) as Route,
    (() => { throw new Error("socket hang up"); }) as Route,
  ]) {
    const f = fakeFetch(routes({ [NAV_REST]: nav }));
    const ctx = buildContext({ env: baseEnv({ TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_VIN: VIN }), fetchImpl: f.impl, fleetOptions: { sleep: async () => {} } });
    ctx.fleet.cache.set(`live:${VIN}`, { stale: true });
    ctx.fleet.cache.set(`cached:${VIN}`, { stale: true });
    await assert.rejects(ctx.fleet.command(VIN, "navigation_request", { type: "share_ext_content_raw", value: { "android.intent.extra.TEXT": "x" } }));
    assert.equal(ctx.fleet.cache.get(`live:${VIN}`, 60_000), undefined);
    assert.equal(ctx.fleet.cache.get(`cached:${VIN}`, 60_000), undefined);
  }
});

// --- off-grid reserve read-back ---------------------------------------------------------------

const SITE = "1234567890";
const FIELD = "off_grid_vehicle_charging_reserve_percent";
const TOOL = "set_off_grid_vehicle_charging_reserve";
const INFO = `GET ${BASE}/api/1/energy_sites/${SITE}/site_info`;
const POST = `POST ${BASE}/api/1/energy_sites/${SITE}/off_grid_vehicle_charging_reserve`;
const EON = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_ENERGY_SITE_ID: SITE };
const updated: Route = () => ({ status: 200, body: {} });
const posts = (calls: Call[]) => calls.filter((x) => x.method === "POST" && x.url.endsWith("/off_grid_vehicle_charging_reserve"));
const reads = (calls: Call[]) => calls.filter((x) => x.url.endsWith("/site_info"));
/** site_info answers: values[n-1] for the n-th read (last one repeats); a value of "fail" = HTTP 500. */
const seq = (values: Array<number | "fail" | undefined>): Route => (_c, n) => {
  const v = values[Math.min(n, values.length) - 1];
  if (v === "fail") return { status: 500, body: {} };
  return { status: 200, body: { response: v === undefined ? {} : { [FIELD]: v } } };
};

function offgrid(info: Route) {
  const slept: number[] = [];
  const f = fakeFetch(routes({ [INFO]: info, [POST]: updated }));
  const ctx = buildContext({ env: baseEnv(EON), fetchImpl: f.impl, fleetOptions: { sleep: async (ms) => { slept.push(ms); } } });
  return { ctx, calls: f.calls, slept };
}

test("off-grid read-back: bounded (3 reads, ~15 s) and documented in the preview", async () => {
  assert.equal(OFF_GRID_READBACK_TRIES, 3);
  assert.equal(OFF_GRID_READBACK_DELAY_MS, 5_000);
  const { ctx, calls } = setup(baseEnv(EON));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90 } }));
  assert.match(String(b.estimatedBillableCalls), /up to 3 after/);
  assert.equal(calls.length, 0);
});

test("off-grid read-back: new value on a later read = confirmed (lag tolerated), one POST", async () => {
  const { ctx, calls, slept } = offgrid(seq([95, 95, 90]));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
  assert.equal(b.ok, true);
  assert.equal(b.previous, 95);
  assert.equal(b.readBack, "confirmed");
  assert.equal(b.readBackValue, 90);
  assert.equal(b.readBackReads, 2);
  assert.equal(b.readBackMessage, undefined);
  assert.deepEqual(slept, [5_000, 5_000]);
  assert.equal(posts(calls).length, 1);
  assert.equal(reads(calls).length, 3);
});

test("off-grid read-back: still the old value after every read = pending (not a failure), never resent", async () => {
  const { ctx, calls, slept } = offgrid(seq([95]));
  const res = await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } });
  assert.equal(isError(res), false);
  const b = body(res);
  assert.equal(b.ok, true);
  assert.equal(b.sent, true);
  assert.equal(b.readBack, "pending");
  assert.equal(b.readBackValue, 95);
  assert.equal(b.readBackReads, 3);
  assert.match(String(b.readBackMessage), /accepted/);
  assert.match(String(b.readBackMessage), /Not resent/);
  assert.equal(slept.length, 3);
  assert.equal(posts(calls).length, 1);
  assert.equal(reads(calls).length, 4);
});

test("off-grid read-back: a third value = mismatch, stops reading", async () => {
  const { ctx, calls } = offgrid(seq([95, 50]));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
  assert.equal(b.ok, true);
  assert.equal(b.readBack, "mismatch");
  assert.equal(b.readBackValue, 50);
  assert.match(String(b.readBackMessage), /reports 50, not the requested 90/);
  assert.equal(reads(calls).length, 2);
  assert.equal(posts(calls).length, 1);
});

test("off-grid read-back: no previous value (pre-read absent) = a different value stays pending, not mismatch", async () => {
  const { ctx } = offgrid(seq([undefined, 50]));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
  assert.equal(b.precheck, "unavailable");
  assert.equal(b.readBack, "pending");
  assert.equal(b.readBackValue, 50);
});

test("off-grid read-back: all reads fail = unavailable; some fail then confirmed = confirmed", async () => {
  {
    const { ctx, calls } = offgrid(seq([95, "fail"]));
    const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
    assert.equal(b.ok, true);
    assert.equal(b.readBack, "unavailable");
    assert.equal(b.readBackReads, 3);
    assert.equal(posts(calls).length, 1);
  }
  {
    const { ctx } = offgrid(seq([95, "fail", 90]));
    const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
    assert.equal(b.readBack, "confirmed");
    assert.equal(b.readBackReads, 2);
  }
});

test("off-grid read-back: none after a rejected send, a noop, or a dry run", async () => {
  {
    const f = fakeFetch(routes({ [INFO]: seq([95]), [POST]: () => ({ status: 200, body: { response: { result: false, reason: "nope" } } }) }));
    const ctx = buildContext({ env: baseEnv(EON), fetchImpl: f.impl, fleetOptions: { sleep: async () => {} } });
    const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
    assert.equal(b.ok, false);
    assert.equal(b.readBack, undefined);
    assert.equal(reads(f.calls).length, 1);
  }
  {
    const { ctx, calls } = offgrid(seq([90]));
    const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
    assert.equal(b.noop, true);
    assert.equal(b.readBack, undefined);
    assert.equal(reads(calls).length, 1);
    assert.equal(posts(calls).length, 0);
  }
  {
    const { ctx, calls } = setup(baseEnv({ ...EON, TESLA_FLEET_DRY_RUN: "1" }));
    const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { [FIELD]: 90, ...intent } }));
    assert.equal(b.dryRun, true);
    assert.equal(calls.length, 0);
  }
});

test("remote_boombox description: fart field-tested, locate_ping refused on owner cars, phrase match", async () => {
  const { ctx } = setup(baseEnv({ TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_VIN: VIN, TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS: "1" }));
  const t = (await (await connect(ctx)).listTools()).tools.find((x) => x.name === "remote_boombox");
  const d = t?.description ?? "";
  assert.match(d, /fart \(id 0, an empty BoomboxAction\) is field-tested here/);
  assert.match(d, /owner outside/);
  assert.match(d, /phrase match/);
  assert.doesNotMatch(d, /not field-tested here/);
});
