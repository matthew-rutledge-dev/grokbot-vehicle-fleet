/**
 * 0.6.1: review follow-ups from 0.6.0 (valet PIN redaction only for a well-formed PIN, more
 * refused PIN-like argument names, camelCase / coords location keys).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dropLocation, isLocationKey } from "../src/tools/energy.js";
import { isPinArgName, redactableValetPin } from "../src/tools/valet.js";
import { PROXY, VIN, baseEnv, body, connect, setup, type Call, type Route } from "./helpers.js";

const ON = { TESLA_FLEET_READ_ONLY: "false", TESLA_DEFAULT_VIN: VIN };
const intent = { confirm: true, user_request: "please do it" };
const ok: Route = () => ({ status: 200, body: { response: { result: true, reason: "" } } });
const cmd = (n: string, r: Route = ok) => ({ [`POST ${PROXY}/api/1/vehicles/${VIN}/command/${n}`]: r });
const cmdCalls = (calls: Call[]) => calls.filter((x) => x.url.includes("/command/"));

test("redactableValetPin: only an exact 4-digit PIN is registered for short-secret redaction", () => {
  assert.equal(redactableValetPin("7391"), "7391");
  assert.equal(redactableValetPin("0000"), "0000");
  for (const v of [undefined, "", "1", "12", "123", "12345", "12a4", " 1234", "1234 ", "١٢٣٤", "12.4", "-123"]) {
    assert.equal(redactableValetPin(v), undefined, JSON.stringify(v));
  }
});

test("malformed TESLA_FLEET_VALET_PIN does not mask ordinary values in other tools' output", async () => {
  // A 1-digit "PIN" would otherwise turn every standalone 1 in a reply into [redacted].
  const echo: Route = () => ({ status: 200, body: { response: { result: false, reason: "volume 1 out of range 1" } } });
  const envx = { ...ON, TESLA_FLEET_ENABLE_VALET: "1", TESLA_FLEET_VALET_PIN: "1" };
  const { ctx } = setup(baseEnv(envx), cmd("adjust_volume", echo));
  const b = body(await (await connect(ctx)).callTool({ name: "adjust_volume", arguments: { volume: 1, ...intent } }));
  const j = JSON.stringify(b);
  assert.ok(!j.includes("[redacted]"), j);
  assert.match(j, /volume 1 out of range 1/);
});

test("well-formed PIN is still scrubbed from command replies (regression)", async () => {
  const echo: Route = () => ({ status: 200, body: { response: { result: false, reason: "code 7391 rejected" } } });
  const envx = { ...ON, TESLA_FLEET_ENABLE_VALET: "1", TESLA_FLEET_VALET_PIN: "7391" };
  const { ctx } = setup(baseEnv(envx), cmd("set_valet_mode", echo));
  const res = await (await connect(ctx)).callTool({ name: "set_valet_mode", arguments: { on: true, vin: VIN, ...intent } });
  assert.ok(!JSON.stringify(res).includes("7391"));
  assert.match(JSON.stringify(body(res)), /\[redacted\]/);
});

test("isPinArgName: code / secret / valet_code refused in any case or separator", () => {
  for (const k of ["code", "Code", "CODE", "secret", "Secret", "SECRET", "valet_code", "valetCode", "Valet-Code", "VALET_CODE",
    "valet code", "valet.secret", "valetSecret", "pin", "pass_code", "Valet-Pin", "valet_passcode"]) {
    assert.ok(isPinArgName(k), k);
  }
  for (const k of ["on", "vin", "confirm", "user_request", "volume", "encode", "codec", "secretary_mode"]) assert.ok(!isPinArgName(k), k);
});

test("set_valet_mode / reset_valet_pin: code, secret, valet_code arguments refused (not ignored), nothing sent, value not echoed", async () => {
  const envx = { ...ON, TESLA_FLEET_ENABLE_VALET: "1", TESLA_FLEET_VALET_PIN: "7391" };
  const { ctx, calls } = setup(baseEnv(envx), { ...cmd("set_valet_mode"), ...cmd("reset_valet_pin") });
  const c = await connect(ctx);
  for (const k of ["code", "Code", "secret", "SECRET", "valet_code", "valetCode", "Valet-Code"]) {
    for (const [name, base] of [["set_valet_mode", { on: true, vin: VIN }], ["set_valet_mode", { on: false, vin: VIN }], ["reset_valet_pin", { vin: VIN }]] as const) {
      for (const extra of [{}, intent]) {
        const b = body(await c.callTool({ name, arguments: { ...base, [k]: "4826", ...extra } }));
        assert.equal(b.code, "invalid_arguments", `${name} ${k}`);
        assert.ok(!JSON.stringify(b).includes("4826"), `${name} ${k}: value echoed`);
      }
    }
  }
  assert.equal(cmdCalls(calls).length, 0);
});

test("isLocationKey: snake, camel, Pascal, kebab, coords; ordinary keys kept", () => {
  for (const k of ["lat", "lon", "lng", "latitude", "Longitude", "LATITUDE", "home_latitude", "homeLatitude", "homeLongitude", "HomeLat",
    "homeLng", "gpsLat", "GPS-Coords", "coords", "Coords", "coord", "coordinates", "siteAddress", "geoLocation", "geolocation", "last_location", "locationId"]) {
    assert.ok(isLocationKey(k), k);
  }
  for (const k of ["energy_added_wh", "name", "vin_hash", "session_id", "platform", "relative", "plateau", "translation", "flatness", "longevity",
    "chargeLimit", "salon", "dissolved", "geometryVersion"]) {
    assert.ok(!isLocationKey(k), k);
  }
});

test("dropLocation: camelCase and coords keys removed at any depth", () => {
  const out = dropLocation({
    kept: 1, homeLatitude: 11.11, homeLongitude: 22.22, coords: [33.33, 44.44],
    deep: { a: [{ b: { siteLatitude: 55.55, Coords: { x: 66.66 }, gpsLng: 77.77, ok: true } }] },
  });
  const j = JSON.stringify(out);
  for (const v of ["11.11", "22.22", "33.33", "44.44", "55.55", "66.66", "77.77"]) assert.ok(!j.includes(v), v);
  assert.deepEqual(out, { kept: 1, deep: { a: [{ b: { ok: true } }] } });
});
