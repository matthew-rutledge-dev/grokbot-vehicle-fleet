import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, SEED, VIN, baseEnv, body, connect, fixtureData, isError, setup } from "./helpers.js";

const wakeCalls = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.includes("wake_up"));

test("battery defaults to cached data and never wakes", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_battery_charge", arguments: {} }));
  assert.equal(b.ok, true);
  assert.equal(b.source, "cached");
  assert.equal((b.charge as Record<string, unknown>).battery_level, 72);
  assert.ok(calls.some((x) => x.url.endsWith("/vehicle_data_cached")));
  assert.ok(!calls.some((x) => x.url.includes("/vehicle_data?")));
  assert.equal(wakeCalls(calls).length, 0);
});

test("live read when asleep is refused locally (no vehicle_data, no wake)", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), {
    [`GET ${BASE}/api/1/vehicles/${VIN}`]: () => ({ status: 200, body: { response: { vin: VIN, state: "asleep" } } }),
  });
  const c = await connect(ctx);
  const res = await c.callTool({ name: "get_climate", arguments: { live: true } });
  assert.equal(isError(res), true);
  assert.equal(body(res).code, "vehicle_not_online");
  assert.ok(!calls.some((x) => x.url.includes("/vehicle_data")));
  assert.equal(wakeCalls(calls).length, 0);
});

test("snapshot batches sections into ONE live call and memory cache dedupes", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_vehicle_snapshot", arguments: { live: true } }));
  assert.equal(b.ok, true);
  const live = calls.filter((x) => x.url.includes("/vehicle_data?"));
  assert.equal(live.length, 1);
  const eps = decodeURIComponent(new URL(live[0].url).searchParams.get("endpoints") ?? "");
  for (const e of ["charge_state", "climate_state", "vehicle_state", "closures_state"]) assert.ok(eps.includes(e), e);
  assert.ok(!eps.includes("location_data"), "snapshot never requests location");
  await c.callTool({ name: "get_vehicle_snapshot", arguments: { live: true } });
  assert.equal(calls.filter((x) => x.url.includes("/vehicle_data?")).length, 1);
});

test("closures + tires shaping (bar -> psi)", async () => {
  const { ctx } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }));
  const c = await connect(ctx);
  const cl = body(await c.callTool({ name: "get_closures", arguments: {} }));
  assert.equal((cl.closures as Record<string, unknown>).locked, true);
  const t = body(await c.callTool({ name: "get_tires", arguments: {} }));
  const fl = ((t.tires as Record<string, unknown>).tires as Record<string, Record<string, unknown>>).fl;
  assert.equal(fl.bar, 2.9);
  assert.equal(fl.psi, 42.1);
});

test("cached 404 gives a clean hint", async () => {
  const { ctx } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), {
    [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data_cached`]: () => ({ status: 404, body: { error: "not_found" } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_battery_charge", arguments: {} }));
  assert.equal(b.ok, false);
  assert.match(String(b.hint), /live=true/);
});

test("location opt-out: off or unrecognised value hides and refuses get_location", async () => {
  for (const v of ["0", "off", "disabled"]) {
    const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN, TESLA_FLEET_ENABLE_LOCATION: v }));
    const c = await connect(ctx);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("get_location"), v);
    const res = await c.callTool({ name: "get_location", arguments: {} });
    assert.equal(isError(res), true);
    assert.equal(body(res).locationEnabled, false);
    assert.equal(calls.length, 0);
  }
});

test("location on by default (unset / placeholder): listed and readable, coarse", async () => {
  for (const extra of [{}, { TESLA_FLEET_ENABLE_LOCATION: "${TESLA_FLEET_ENABLE_LOCATION}" }] as Array<Record<string, string>>) {
    const { ctx } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN, ...extra }));
    const c = await connect(ctx);
    assert.ok((await c.listTools()).tools.some((t) => t.name === "get_location"));
    const b = body(await c.callTool({ name: "get_location", arguments: {} }));
    assert.equal(b.ok, true);
    assert.equal(b.precision, "coarse");
    assert.equal(b.latitude, 37.12);
  }
});

test("location: env default precision, invalid precision refused, missing scope names vehicle_location", async () => {
  {
    const { ctx } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN, TESLA_FLEET_DEFAULT_LOCATION_PRECISION: "precise" }));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: "get_location", arguments: {} }));
    assert.equal(b.precision, "precise");
    assert.equal(b.latitude, 37.12346);
    assert.equal(body(await c.callTool({ name: "get_location", arguments: { precision: "coarse" } })).latitude, 37.12);
  }
  {
    const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }));
    const c = await connect(ctx);
    for (const precision of ["exact", 5, ""]) {
      const res = await c.callTool({ name: "get_location", arguments: { precision } });
      assert.equal(body(res).code, "invalid_arguments", String(precision));
    }
    assert.equal(calls.length, 0, "no token refresh, vehicle lookup or data call on invalid precision");
  }
  {
    const { ctx } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), {
      [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data`]: () => ({ status: 403, body: { error: "unauthorized_missing_scopes", error_description: "missing scopes" } }),
    });
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: "get_location", arguments: {} }));
    assert.equal(b.code, "missing_location_scope");
    assert.match(String(b.hint), /vehicle_location/);
    assert.match(String(b.hint), /TESLA_FLEET_ENABLE_LOCATION=0/);
  }
});

test("location hidden when turned off (legacy check)", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN, TESLA_FLEET_ENABLE_LOCATION: "false" }));
  const c = await connect(ctx);
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes("get_location"));
  const res = await c.callTool({ name: "get_location", arguments: {} });
  assert.equal(isError(res), true);
  assert.equal(calls.length, 0);
});

test("location opt-in: coarse by default, precise only on request", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN, TESLA_FLEET_ENABLE_LOCATION: "1" }));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_location", arguments: {} }));
  assert.equal(b.precision, "coarse");
  assert.equal(b.latitude, 37.12);
  assert.equal(b.heading, undefined);
  const live = calls.find((x) => x.url.includes("/vehicle_data?"))!;
  assert.ok(decodeURIComponent(live.url).includes("location_data"));
  const p = body(await c.callTool({ name: "get_location", arguments: { precision: "precise" } }));
  assert.equal(p.latitude, 37.12346);
});

test("ambiguous VIN lists only last-4", async () => {
  const { ctx } = setup(baseEnv(), {
    [`GET ${BASE}/api/1/vehicles`]: () => ({ status: 200, body: { response: [{ vin: VIN, state: "online" }, { vin: "5YJ000000EXAMPL2", state: "asleep" }] } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_battery_charge", arguments: {} }));
  assert.equal(b.code, "vin_ambiguous");
  assert.ok(!JSON.stringify(b).includes(VIN));
});

test("describe_boundary echoes no secret values", async () => {
  const env = baseEnv();
  const { ctx, calls } = setup(env);
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "describe_boundary", arguments: {} }));
  assert.equal(b.readOnly, true);
  assert.equal(calls.length, 0);
  const text = JSON.stringify(b);
  for (const v of [env.TESLA_REFRESH_TOKEN, env.TESLA_CLIENT_ID]) assert.ok(!text.includes(v), "no secret echoed");
});

test("error output redacts the rotated refresh token and access token, not just the env seed", async () => {
  const { ctx } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), {
    [`GET ${BASE}/api/1/vehicles`]: () => ({
      status: 400,
      body: { error: "invalid_request", error_description: `echo ${SEED} rotated-EXAMPLE-1 access-EXAMPLE-1 end` },
    }),
  });
  const c = await connect(ctx);
  const res = await c.callTool({ name: "list_vehicles", arguments: {} });
  assert.equal(isError(res), true);
  const text = JSON.stringify(body(res));
  assert.ok(ctx.tokens.secretValues().includes("rotated-EXAMPLE-1"), "store now holds the rotated token");
  for (const s of [SEED, "rotated-EXAMPLE-1", "access-EXAMPLE-1"]) assert.ok(!text.includes(s), `redacted: ${s}`);
  assert.ok(text.includes("[redacted]"));
});

test("VIN resolution lists vehicles once across several reads (no default VIN)", async () => {
  const env = baseEnv();
  const { ctx, calls } = setup(env);
  const c = await connect(ctx);
  assert.equal(body(await c.callTool({ name: "get_battery_charge", arguments: {} })).ok, true);
  assert.equal(body(await c.callTool({ name: "get_fleet_status", arguments: {} })).ok, true);
  assert.equal(body(await c.callTool({ name: "get_vehicle_state", arguments: {} })).ok, true);
  const lists = calls.filter((x) => x.method === "GET" && new URL(x.url).pathname === "/api/1/vehicles");
  assert.equal(lists.length, 1);
});

test("list_vehicles itself always fetches a fresh list", async () => {
  const { ctx, calls } = setup(baseEnv());
  const c = await connect(ctx);
  await c.callTool({ name: "get_battery_charge", arguments: {} });
  await c.callTool({ name: "list_vehicles", arguments: {} });
  const lists = calls.filter((x) => x.method === "GET" && new URL(x.url).pathname === "/api/1/vehicles");
  assert.equal(lists.length, 2);
});

test("api_status returns the plain-text body, not a non_json_response error", async () => {
  const { ctx } = setup(baseEnv(), { [`GET ${BASE}/status`]: () => ({ status: 200, body: "ok" }) });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "api_status", arguments: {} }));
  assert.equal(b.ok, true);
  assert.equal(b.status, "ok");
});

test("closures: windows reported as unknown when the data has no window fields", async () => {
  const data = fixtureData();
  const vs = data.vehicle_state as Record<string, unknown>;
  for (const k of ["fd_window", "fp_window", "rd_window", "rp_window"]) delete vs[k];
  const { ctx } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }), {
    [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data_cached`]: () => ({ status: 200, body: { response: data } }),
  });
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: "get_closures", arguments: {} }));
  assert.match(String((b.closures as Record<string, unknown>).windowsOpen), /^unknown/);
});
