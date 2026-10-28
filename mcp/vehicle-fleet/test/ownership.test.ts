import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, VIN, baseEnv, body, connect, fixtureData, isError, setup } from "./helpers.js";
import { decodeTeslaVin, recallModelArg } from "../src/tools/ownership.js";
import { NhtsaLimiter } from "../src/ratelimit.js";
import { tireSummary } from "../src/tools/extract.js";

const NHTSA = "https://api.nhtsa.gov/recalls/recallsByVehicle";
/** A decodable 17-character placeholder (position 4 = 3, position 10 = L -> 2020). */
const VIN17 = "5YJ3EXAMPLE000001";
const noWake = (calls: Array<{ url: string }>) => !calls.some((c) => /wake_up|\/command\//.test(c.url));

function statusData() {
  const d = fixtureData();
  Object.assign(d.vehicle_state as Record<string, unknown>, {
    car_version: "2026.32.1 0123456789ab", odometer: 21000.44, service_mode: false,
    software_update: { status: "downloading", version: "2026.38.2", download_perc: 40, install_perc: 1, expected_duration_sec: 2700, scheduled_time_ms: 0 },
    tpms_rcp_front_value: 2.9, tpms_rcp_rear_value: 2.9,
  });
  return d;
}

test("get_vehicle_status: firmware, pending update, odometer mi+km, service mode (cached, never wakes)", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), {
    [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data_cached`]: () => ({ status: 200, body: { response: statusData() } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_vehicle_status", arguments: {} }));
  const s = b.status as Record<string, unknown>;
  assert.equal(s.firmware, "2026.32.1");
  assert.deepEqual(s.odometer, { mi: 21000.4, km: 33796.9 });
  assert.equal(s.serviceMode, false);
  const u = s.softwareUpdate as Record<string, unknown>;
  assert.equal(u.status, "downloading");
  assert.equal(u.version, "2026.38.2");
  assert.equal(u.download_perc, 40);
  assert.equal(u.pending, true);
  assert.equal(u.scheduledFor, undefined);
  assert.ok(calls.some((x) => x.url.endsWith("/vehicle_data_cached")));
  assert.ok(noWake(calls));
});

test("snapshot includes status by default and asks only for vehicle_state for it when live", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_vehicle_snapshot", arguments: { live: true, sections: ["status"] } }));
  assert.ok(b.status);
  const live = calls.filter((x) => x.url.includes("/vehicle_data?"));
  assert.equal(decodeURIComponent(new URL(live[0].url).searchParams.get("endpoints") ?? ""), "vehicle_state");
  const all = body(await c.callTool({ name: "get_vehicle_snapshot", arguments: {} }));
  for (const k of ["charge", "climate", "closures", "tires", "status"]) assert.ok(k in all, k);
});

test("tires: psi below the recommended cold pressure when reported", () => {
  const t = tireSummary({ tpms_pressure_fl: 2.5, tpms_pressure_rr: 2.9, tpms_rcp_front_value: 2.9, tpms_rcp_rear_value: 2.9 });
  assert.equal((t.fl as Record<string, unknown>).psiBelowRecommended, 5.8);
  assert.equal((t.fl as Record<string, unknown>).recommendedPsi, 42.1);
  assert.equal((t.rr as Record<string, unknown>).psiBelowRecommended, 0);
  assert.equal((tireSummary({ tpms_pressure_fl: 2.5 }).fl as Record<string, unknown>).psiBelowRecommended, undefined);
});

test("recent alerts, release notes, service status, warranty: one cached data call each, shaped, images dropped", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), {
    [`GET ${BASE}/api/1/vehicles/${VIN}/recent_alerts`]: () => ({ status: 200, body: { response: { recent_alerts: [{ name: "Example_a001", time: "2026-10-01T10:00:00Z", audience: ["customer"], user_text: "Example alert", extra: "x" }] } } }),
    [`GET ${BASE}/api/1/vehicles/${VIN}/release_notes`]: () => ({ status: 200, body: { response: { release_notes: [{ title: "Example feature", subtitle: "Sub", description: "Text", customer_version: "2026.38.2", image_url: "https://images.example.com/a.png" }] } } }),
    [`GET ${BASE}/api/1/vehicles/${VIN}/service_data`]: () => ({ status: 200, body: { response: { service_status: "in_service", service_etc: "2026-10-30T17:00:00Z", service_visit_number: "SV-EXAMPLE", status_id: 8, other_detail: 1 } } }),
    [`GET ${BASE}/api/1/dx/warranty/details`]: () => ({ status: 200, body: { response: { activeWarranty: [{ warrantyType: "BATTERY", warrantyDisplayName: "Battery and Drive Unit", expirationDate: "2028-01-01T00:00:00Z", expirationOdometer: 120000, odometerUnit: "MI", internal: "x" }], upcomingWarranty: [], expiredWarranty: [{ warrantyType: "BASIC" }] } } }),
  });
  const c = await connect(ctx);
  const a = body(await c.callTool({ name: "get_recent_alerts", arguments: {} }));
  assert.deepEqual(a.alerts, [{ name: "Example_a001", time: "2026-10-01T10:00:00Z", audience: ["customer"], user_text: "Example alert" }]);
  const n = body(await c.callTool({ name: "get_release_notes", arguments: {} }));
  assert.deepEqual(n.notes, [{ title: "Example feature", subtitle: "Sub", description: "Text", customer_version: "2026.38.2" }]);
  const s = body(await c.callTool({ name: "get_service_status", arguments: {} }));
  assert.equal(s.inService, true);
  assert.equal(s.service_etc, "2026-10-30T17:00:00Z");
  assert.deepEqual(s.otherKeys, ["other_detail"]);
  const w = body(await c.callTool({ name: "get_warranty", arguments: {} }));
  assert.equal((w.active as Array<Record<string, unknown>>)[0].expirationOdometer, 120000);
  assert.equal("internal" in (w.active as Array<Record<string, unknown>>)[0], false);
  assert.equal((w.expired as unknown[]).length, 1);
  const wc = calls.find((x) => x.url.includes("/dx/warranty/details"))!;
  assert.equal(new URL(wc.url).searchParams.get("vin"), VIN);
  // Second round is served from memory: no new network calls.
  const before = calls.length;
  for (const name of ["get_recent_alerts", "get_release_notes", "get_service_status", "get_warranty"]) await c.callTool({ name, arguments: {} });
  assert.equal(calls.length, before);
  assert.ok(noWake(calls));
  assert.ok(!calls.some((x) => x.url.includes("/vehicle_data")));
});

test("recalls: NHTSA by model/year decoded locally; no token, no VIN, not Fleet usage", async () => {
  const { ctx, calls } = setup(baseEnv(), {
    [`GET ${NHTSA}`]: () => ({ status: 200, body: { Count: 1, results: [{ NHTSACampaignNumber: "26V000001", Component: "EXAMPLE", Summary: "Example summary", Remedy: "OTA", overTheAirUpdate: true, parkIt: false, Manufacturer: "x" }] } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_recalls", arguments: { vin: VIN17 } }));
  assert.equal(b.ok, true);
  assert.equal(b.model, "Model 3");
  assert.equal(b.modelYear, 2020);
  assert.deepEqual(b.recalls, [{ NHTSACampaignNumber: "26V000001", Component: "EXAMPLE", Summary: "Example summary", Remedy: "OTA", overTheAirUpdate: true, parkIt: false }]);
  assert.equal(calls.length, 1, "only the NHTSA call (no token refresh, no Fleet call)");
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get("make"), "TESLA");
  assert.equal(u.searchParams.get("model"), "MODEL 3");
  assert.equal(u.searchParams.get("modelYear"), "2020");
  assert.ok(!calls[0].url.includes(VIN17));
  assert.equal(Object.keys(calls[0].headers).some((h) => h.toLowerCase() === "authorization"), false);
  const usage = body(await c.callTool({ name: "describe_boundary", arguments: {} }));
  assert.equal(usage.billableCallsThisSession, 0);
});

test("recalls: undecodable VIN is refused before any call unless model and year are given; NHTSA failure is clean", async () => {
  const { ctx, calls } = setup(baseEnv(), { [`GET ${NHTSA}`]: () => ({ status: 503, body: "down" }) });
  const c = await connect(ctx);
  const r = await c.callTool({ name: "get_recalls", arguments: { vin: VIN } });
  assert.equal(isError(r), true);
  assert.equal(body(r).code, "model_year_unknown");
  assert.equal(calls.length, 0);
  const f = await c.callTool({ name: "get_recalls", arguments: { vin: VIN, model: "Model Y", model_year: 2024 } });
  assert.equal(isError(f), true);
  assert.equal(body(f).code, "nhtsa_unavailable");
  assert.equal(new URL(calls[0].url).searchParams.get("model"), "MODEL Y");
});

test("VIN decode", () => {
  assert.deepEqual(decodeTeslaVin(VIN17), { model: "Model 3", modelYear: 2020 });
  assert.deepEqual(decodeTeslaVin("7SAYEXAMPLE000002"), { model: "Model Y", modelYear: 2020 });
  assert.deepEqual(decodeTeslaVin("short"), {});
});

test("VIN decode: a non-Tesla manufacturer code is not decoded", () => {
  // Obviously fake placeholders with a valid 17-character shape but no Tesla WMI.
  assert.deepEqual(decodeTeslaVin("1ABCEXAMPLE000003"), {});
  assert.deepEqual(decodeTeslaVin("ZZZ3EXAMPLE000004"), {});
  for (const wmi of ["5YJ", "7SA", "7G2", "LRW", "XP7", "SFZ"]) {
    assert.equal(decodeTeslaVin(`${wmi}3EXAMPLE000005`).model, "Model 3", wmi);
  }
});

test("tires: psiBelowRecommended is clamped at 0 when a tire is above the recommended pressure", () => {
  const t = tireSummary({ tpms_pressure_fl: 3.0, tpms_pressure_fr: 2.89, tpms_rcp_front_value: 2.9 });
  assert.equal((t.fl as Record<string, unknown>).psiBelowRecommended, 0);
  assert.equal(Object.is((t.fr as Record<string, unknown>).psiBelowRecommended, -0), false);
  assert.equal((t.fr as Record<string, unknown>).psiBelowRecommended, 0.1);
});

test("recalls: model is validated before any call; free text and VIN-like strings never reach NHTSA", async () => {
  const { ctx, calls } = setup(baseEnv(), { [`GET ${NHTSA}`]: () => ({ status: 200, body: { Count: 0, results: [] } }) });
  const c = await connect(ctx);
  for (const model of ["Roadster", VIN17, "5YJ3EXAMPLE000009", "Model 3; DROP", "", " ", 3, ["Model 3"]]) {
    const r = await c.callTool({ name: "get_recalls", arguments: { vin: VIN17, model, model_year: 2024 } });
    assert.equal(isError(r), true, String(model));
    assert.equal(body(r).code, "invalid_arguments", String(model));
    assert.equal(body(r).sent, false);
  }
  assert.equal(calls.length, 0, "nothing sent for a bad model (no NHTSA, no token refresh, no vehicle lookup)");
  // Case-insensitive match is canonicalised.
  const ok = body(await c.callTool({ name: "get_recalls", arguments: { vin: VIN17, model: "  model   y ", model_year: 2024 } }));
  assert.equal(ok.model, "Model Y");
  assert.equal(new URL(calls[0].url).searchParams.get("model"), "MODEL Y");
  assert.equal(recallModelArg(undefined), undefined);
  assert.equal(recallModelArg("CYBERTRUCK"), "Cybertruck");
});

test("recalls: local NHTSA limiter refuses before sending (min interval and hourly cap)", async () => {
  let t = 1_000_000;
  const lim = new NhtsaLimiter(() => t, 5_000, 3);
  lim.take();
  assert.throws(() => lim.take(), (e: Error & { code?: string; extra?: { retryAfterSec?: number } }) => e.code === "rate_limited_locally" && e.extra?.retryAfterSec === 5);
  t += 5_000; lim.take();
  t += 5_000; lim.take();
  t += 5_000;
  assert.throws(() => lim.take(), (e: Error & { code?: string; extra?: { retryAfterSec?: number } }) => e.code === "rate_limited_locally" && e.extra?.retryAfterSec === 3600 - 15);
  t = 1_000_000 + 3_600_000; lim.take(); // the first request has left the window

  // Through the tool: a second uncached query right away is refused locally, nothing sent; cache hits are not limited.
  const { ctx, calls } = setup(baseEnv(), { [`GET ${NHTSA}`]: () => ({ status: 200, body: { Count: 0, results: [] } }) });
  const c = await connect(ctx);
  assert.equal(body(await c.callTool({ name: "get_recalls", arguments: { vin: VIN17 } })).ok, true);
  assert.equal(body(await c.callTool({ name: "get_recalls", arguments: { vin: VIN17 } })).ok, true, "cache hit");
  const r = await c.callTool({ name: "get_recalls", arguments: { vin: VIN17, model: "Model Y", model_year: 2024 } });
  assert.equal(isError(r), true);
  assert.equal(body(r).code, "rate_limited_locally");
  assert.equal(calls.length, 1);
});

test("TESLA_FLEET_DISABLE_NHTSA hides and refuses get_recalls; nothing is sent", async () => {
  for (const v of ["1", "true", "ON", "garbage"]) {
    const { ctx, calls } = setup(baseEnv({ TESLA_FLEET_DISABLE_NHTSA: v }));
    assert.equal(ctx.config.nhtsaEnabled, false, v);
    const c = await connect(ctx);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("get_recalls"), v);
    assert.ok(names.includes("get_warranty"), v);
    assert.equal(names.length, 21, v);
    const r = await c.callTool({ name: "get_recalls", arguments: { vin: VIN17 } });
    assert.equal(isError(r), true);
    assert.equal(body(r).nhtsaEnabled, false);
    assert.equal(calls.length, 0);
    assert.equal(body(await c.callTool({ name: "describe_boundary", arguments: {} })).nhtsaRecallsEnabled, false);
  }
  assert.ok(setup(baseEnv({ TESLA_FLEET_DISABLE_NHTSA: "garbage" })).ctx.config.warnings.some((w) => w.includes("TESLA_FLEET_DISABLE_NHTSA")));
  for (const v of ["0", "false", "off", "${TESLA_FLEET_DISABLE_NHTSA}"]) {
    const { ctx } = setup(baseEnv({ TESLA_FLEET_DISABLE_NHTSA: v }));
    assert.equal(ctx.config.nhtsaEnabled, true, v);
    const names = (await (await connect(ctx)).listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("get_recalls"), v);
    assert.equal(names.length, 22, v);
  }
});

test("HTTP: Content-Type only with a body", async () => {
  const { ctx, calls } = setup(baseEnv(), { [`GET ${NHTSA}`]: () => ({ status: 200, body: { Count: 0, results: [] } }) });
  const c = await connect(ctx);
  await c.callTool({ name: "get_recalls", arguments: { vin: VIN17 } });
  const h = (i: number) => Object.keys(calls[i].headers).some((k) => k.toLowerCase() === "content-type");
  assert.equal(calls[0].body, undefined);
  assert.equal(h(0), false);
  // A request with a body (the form-encoded token refresh) still sends Content-Type; bodiless Fleet GETs do not.
  await c.callTool({ name: "get_warranty", arguments: { vin: VIN } });
  const post = calls.findIndex((x) => x.method === "POST");
  const get = calls.findIndex((x) => x.method === "GET" && x.url.includes("/warranty/"));
  assert.ok(post > 0 && h(post));
  assert.ok(get > 0 && !h(get));
});

test("ownership reads stay listed in read-only mode and no command is reachable", async () => {
  const { ctx } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }));
  const c = await connect(ctx);
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const n of ["get_vehicle_status", "get_recent_alerts", "get_release_notes", "get_service_status", "get_warranty", "get_recalls"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("door_unlock"));
  const r = await c.callTool({ name: "door_unlock", arguments: { confirm: true, user_request: "x" } });
  assert.equal(isError(r), true);
});
