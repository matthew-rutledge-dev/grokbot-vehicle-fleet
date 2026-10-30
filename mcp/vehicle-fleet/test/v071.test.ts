/**
 * 0.7.1: REST-only navigation_request goes straight to the Fleet API; proxy text/binary error bodies;
 * Tesla energy 400 messages; off-grid reserve range; boombox locate_ping note.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorBodyFromText, printable } from "../src/http.js";
import { mapFleetError } from "../src/errors.js";
import { REST_ONLY_COMMANDS } from "../src/fleet.js";
import { BASE, PROXY, VIN, baseEnv, body, connect, isError, setup } from "./helpers.js";
import type { Call, Route } from "./helpers.js";

const ON = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_VIN: VIN };
const intent = { confirm: true, user_request: "please do it" };
const ok: Route = () => ({ status: 200, body: { response: { result: true, reason: "" } } });
const NAV_REST = `POST ${BASE}/api/1/vehicles/${VIN}/command/navigation_request`;
const NAV_PROXY = `POST ${PROXY}/api/1/vehicles/${VIN}/command/navigation_request`;
const navCalls = (calls: Call[]) => calls.filter((x) => x.url.endsWith("/command/navigation_request"));
// What an affected proxy build returns: its own JSON error, then the forwarded (gzip) upstream reply.
const JUNK = "{\"response\":null,\"error\":\"command requires using the REST API\",\"error_description\":\"\"}\n\u001f\u008b\b\u0000d\u0000\u0003,\u0000E\u0019I5B";

test("REST-only list is exactly navigation_request (verified in tesla-http-proxy command.go)", () => {
  assert.deepEqual([...REST_ONLY_COMMANDS], ["navigation_request"]);
});

test("share_navigation: sent to the Fleet API base, not the proxy, no proxy dispatcher", async () => {
  const { ctx, calls } = setup(baseEnv(ON), { [NAV_REST]: ok, [NAV_PROXY]: () => { throw new Error("must not use the proxy"); } });
  const c = await connect(ctx);
  for (const args of [{ destination: "1 Example Street" }, { lat: 1.25, lon: 2.5 }]) {
    const b = body(await c.callTool({ name: "share_navigation", arguments: { ...args, ...intent } }));
    assert.equal(b.ok, true, JSON.stringify(b));
  }
  const n = navCalls(calls);
  assert.equal(n.length, 2);
  for (const x of n) {
    assert.ok(x.url.startsWith(`${BASE}/`));
    assert.equal(x.dispatcher, undefined);
    assert.match(x.headers.Authorization ?? "", /^Bearer /);
  }
});

test("share_navigation works with no proxy configured; other commands still refuse without one", async () => {
  const env = baseEnv({ ...ON, TESLA_COMMAND_PROXY_URL: "", TESLA_FLEET_PROXY_URL: "" });
  const { ctx, calls } = setup(env, { [NAV_REST]: ok });
  const c = await connect(ctx);
  assert.equal(body(await c.callTool({ name: "share_navigation", arguments: { destination: "Example Place", ...intent } })).ok, true);
  assert.equal(navCalls(calls).length, 1);
  const lock = await c.callTool({ name: "door_lock", arguments: { ...intent } });
  assert.equal(body(lock).code, "proxy_not_configured");
});

test("door_lock still goes through the proxy", async () => {
  const { ctx, calls } = setup(baseEnv(ON));
  const c = await connect(ctx);
  assert.equal(body(await c.callTool({ name: "door_lock", arguments: { ...intent } })).ok, true);
  assert.ok(calls.some((x) => x.url === `${PROXY}/api/1/vehicles/${VIN}/command/door_lock`));
});

test("share_navigation dry-runs show the Fleet API transport and make no network call", async () => {
  {
    const { ctx, calls } = setup(baseEnv({ ...ON, TESLA_FLEET_DRY_RUN: "1" }));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: "share_navigation", arguments: { destination: "Example Place", ...intent } }));
    assert.equal(b.dryRun, true);
    const ws = b.wouldSend as Array<{ url: string }>;
    assert.ok(ws[0].url.startsWith("<fleet base>/"), ws[0].url);
    assert.match(String(b.transport), /Fleet API REST/);
    assert.equal(calls.length, 0);
  }
  {
    const { ctx, calls } = setup(baseEnv(ON));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: "share_navigation", arguments: { destination: "Example Place" } }));
    assert.match(String(b.transport), /Fleet API REST/);
    assert.equal(calls.length, 0);
  }
  const tl = await (await connect(setup(baseEnv(ON)).ctx)).listTools();
  const nav = tl.tools.find((t) => t.name === "share_navigation");
  assert.match(nav?.description ?? "", /straight to the Fleet API/);
  assert.doesNotMatch(nav?.description ?? "", /Signed via your tesla-http-proxy/);
});

test("errorBodyFromText: leading JSON kept, appended binary dropped; text-only bodies are printable", () => {
  const b = errorBodyFromText(JUNK);
  assert.equal(b.error, "command requires using the REST API");
  assert.equal(b.trailingData, true);
  const plain = errorBodyFromText("bad gateway\u0000\u001f\u008b junk");
  assert.equal(plain.error, "non_json_response");
  assert.equal(plain.error_description, "bad gateway junk");
  assert.equal(printable("a\u0001\u0002b\n c"), "a b c");
  assert.equal(errorBodyFromText("{not json").error, "non_json_response");
});

test("proxy 'command requires using the REST API' + forwarded junk = rest_required, clean message, no binary", async () => {
  const { ctx } = setup(baseEnv(ON), {
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/door_lock`]: () => ({ status: 400, body: JUNK }),
  });
  const c = await connect(ctx);
  const res = await c.callTool({ name: "door_lock", arguments: { ...intent } });
  assert.equal(isError(res), true);
  const b = body(res);
  assert.equal(b.code, "rest_required");
  const s = JSON.stringify(b);
  assert.ok(!/[\u0000-\u0008\u000e-\u001f\u007f-\u00ff]/.test(s), "no control or binary characters");
  assert.ok(!s.includes("non_json_response"));
  assert.match(s, /may have reached the car/);
});

test("proxy invalid_command (text or JSON) = invalid_command", () => {
  assert.equal(mapFleetError(400, errorBodyFromText("invalid command\n")).info.code, "invalid_command");
  assert.equal(mapFleetError(400, { response: null, error: "invalid_command", error_description: "" }).info.code, "invalid_command");
  assert.equal(mapFleetError(400, { error: "command not implemented" }).info.code, "invalid_command");
});

test("energy 400 with Tesla's nested Message = invalid_value with Tesla's words, no internal URL", async () => {
  const SITE = "1234567890";
  const FIELD = "off_grid_vehicle_charging_reserve_percent";
  const tesla = `https://energy.internal.example/api/v2/energy_site/off_grid_vehicle_charging_reserve => {Message: "Invalid off grid vehicle charging reserve values", Status: 400}`;
  const { ctx, calls } = setup(baseEnv({ ...ON, TESLA_DEFAULT_ENERGY_SITE_ID: SITE }), {
    [`GET ${BASE}/api/1/energy_sites/${SITE}/site_info`]: () => ({ status: 200, body: { response: { [FIELD]: 50 } } }),
    [`POST ${BASE}/api/1/energy_sites/${SITE}/off_grid_vehicle_charging_reserve`]: () => ({ status: 400, body: { response: null, error: tesla, error_description: "" } }),
  });
  const c = await connect(ctx);
  const res = await c.callTool({ name: "set_off_grid_vehicle_charging_reserve", arguments: { [FIELD]: 60, ...intent } });
  assert.equal(isError(res), true);
  const b = body(res);
  assert.equal(b.code, "invalid_value");
  assert.match(String(b.message ?? b.error), /Invalid off grid vehicle charging reserve values/);
  assert.ok(!JSON.stringify(b).includes("internal.example"));
  assert.equal(calls.filter((x) => x.method === "POST" && x.url.endsWith("/off_grid_vehicle_charging_reserve")).length, 1, "not retried");
});

test("unknown 4xx error text never echoes URLs and never becomes the error code", () => {
  const e = mapFleetError(400, { error: "https://internal.example/x => boom" });
  assert.equal(e.info.code, "http_error");
  assert.ok(!e.info.message.includes("internal.example"));
});

test("remote_boombox description says locate_ping needs robotaxi mode under 10 mph", async () => {
  const { ctx } = setup(baseEnv({ ...ON, TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS: "1" }));
  const tl = await (await connect(ctx)).listTools();
  const t = tl.tools.find((x) => x.name === "remote_boombox");
  assert.match(t?.description ?? "", /locate_ping only works in robotaxi mode under 10 mph/);
});
