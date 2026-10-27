import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { checkUrl, configPresence, defaultTokenStorePath, loadConfig, REGION_BASE_URLS } from "../src/config.js";
import { isUnsetValue, readEnv, readOptInFlag } from "../src/env.js";

test("placeholders and blanks are unset", () => {
  assert.equal(isUnsetValue("${TESLA_CLIENT_ID}"), true);
  assert.equal(isUnsetValue("  "), true);
  assert.equal(readEnv("X", { X: " v " }), "v");
  assert.equal(readEnv("X", { X: "${X}" }), undefined);
});

test("location flag is opt-in only", () => {
  for (const v of ["1", "true", "yes", "ON"]) assert.equal(readOptInFlag("L", { L: v }), true, v);
  for (const v of [undefined, "", "0", "enabled", "${L}"]) assert.equal(readOptInFlag("L", { L: v }), false, String(v));
});

test("URLs: https anywhere, http only on loopback", () => {
  assert.ok(checkUrl("U", "https://proxy.example.com/").url === "https://proxy.example.com");
  assert.ok(checkUrl("U", "http://127.0.0.1:4443").warning);
  assert.ok(checkUrl("U", "http://proxy.example.com").problem);
  assert.ok(checkUrl("U", "not a url").problem);
});

test("region maps to documented base URL; explicit base URL wins", () => {
  const c = loadConfig({ TESLA_CLIENT_ID: "id", TESLA_FLEET_REGION: "EU" });
  assert.equal(c.baseUrl, REGION_BASE_URLS.eu);
  const d = loadConfig({ TESLA_CLIENT_ID: "id", TESLA_FLEET_REGION: "eu", TESLA_FLEET_BASE_URL: "https://fleet-api.example.test" });
  assert.equal(d.baseUrl, "https://fleet-api.example.test");
  const e = loadConfig({ TESLA_CLIENT_ID: "id", TESLA_FLEET_REGION: "mars" });
  assert.ok(e.problems.some((p) => p.includes("TESLA_FLEET_REGION")));
});

test("defaults: read-only, location on (coarse), missing client id reported", () => {
  const c = loadConfig({});
  assert.equal(c.readOnly.readOnly, true);
  assert.equal(c.locationEnabled, true);
  assert.ok(c.problems.includes("TESLA_CLIENT_ID (or TESLA_FLEET_CLIENT_ID) is not set"));
});

test("token store default honours GROK_PLUGIN_DATA then XDG", () => {
  assert.equal(defaultTokenStorePath({ GROK_PLUGIN_DATA: path.join("x", "data") }), path.join("x", "data", "tokens.json"));
  if (process.platform !== "win32") {
    assert.equal(defaultTokenStorePath({ XDG_STATE_HOME: "/tmp/state" }), "/tmp/state/grokbot-vehicle-fleet/tokens.json");
  }
});

test("configPresence reports set/missing only", () => {
  const p = configPresence({ TESLA_CLIENT_ID: "secret-ish-value", TESLA_REFRESH_TOKEN: "${TESLA_REFRESH_TOKEN}" });
  assert.equal(p.TESLA_CLIENT_ID, "set");
  assert.equal(p.TESLA_REFRESH_TOKEN, "missing");
  assert.ok(!JSON.stringify(p).includes("secret-ish-value"));
});

test("TESLA_FLEET_CLIENT_ID / TESLA_FLEET_PROXY_URL are aliases; the primary name wins", () => {
  const a = loadConfig({ TESLA_FLEET_CLIENT_ID: "alias-id", TESLA_FLEET_PROXY_URL: "https://proxy.example.com" });
  assert.equal(a.clientId, "alias-id");
  assert.equal(a.proxyUrl, "https://proxy.example.com");
  assert.equal(a.problems.length, 0);
  const b = loadConfig({
    TESLA_CLIENT_ID: "primary-id", TESLA_FLEET_CLIENT_ID: "alias-id",
    TESLA_COMMAND_PROXY_URL: "https://primary.example.com", TESLA_FLEET_PROXY_URL: "https://proxy.example.com",
  });
  assert.equal(b.clientId, "primary-id");
  assert.equal(b.proxyUrl, "https://primary.example.com");
  const c = loadConfig({ TESLA_CLIENT_ID: "${TESLA_CLIENT_ID}", TESLA_FLEET_CLIENT_ID: "alias-id" });
  assert.equal(c.clientId, "alias-id", "an unexpanded placeholder counts as unset, so the alias is used");
});

test("dry-run flag and climate defaults: opt-in, validated, fall back with a warning", () => {
  const d = loadConfig({});
  assert.equal(d.dryRun, false);
  assert.deepEqual(d.climate, { tempC: 21, seatLevel: 2, seats: "driver", coldBelowC: 5, defrostBelowC: -2, wheelWhenCold: true });
  const c = loadConfig({
    TESLA_FLEET_DRY_RUN: "yes", TESLA_FLEET_DEFAULT_CLIMATE_TEMP_C: "20.5", TESLA_FLEET_DEFAULT_SEAT_HEAT_LEVEL: "1",
    TESLA_FLEET_DEFAULT_HEATED_SEATS: "none", TESLA_FLEET_COLD_OUTSIDE_BELOW_C: "8", TESLA_FLEET_DEFROST_OUTSIDE_BELOW_C: "0",
    TESLA_FLEET_STEERING_WHEEL_HEAT_WHEN_COLD: "false",
  });
  assert.equal(c.dryRun, true);
  assert.deepEqual(c.climate, { tempC: 20.5, seatLevel: 1, seats: "none", coldBelowC: 8, defrostBelowC: 0, wheelWhenCold: false });
  const bad = loadConfig({ TESLA_FLEET_DEFAULT_CLIMATE_TEMP_C: "40", TESLA_FLEET_DEFAULT_SEAT_HEAT_LEVEL: "2.5", TESLA_FLEET_DEFAULT_HEATED_SEATS: "all" });
  assert.equal(bad.climate.tempC, 21);
  assert.equal(bad.climate.seatLevel, 2);
  assert.equal(bad.climate.seats, "driver");
  assert.equal(bad.warnings.length, 3);
});

test("TESLA_FLEET_DRY_RUN fails closed: unknown values turn dry-run on with a warning", () => {
  for (const v of ["", "0", "false", "off", "no", "OFF"]) {
    const c = loadConfig({ TESLA_FLEET_DRY_RUN: v });
    assert.equal(c.dryRun, false, JSON.stringify(v));
    assert.ok(!c.warnings.some((w) => w.includes("TESLA_FLEET_DRY_RUN")));
  }
  for (const v of ["1", "true", "on", "YES"]) assert.equal(loadConfig({ TESLA_FLEET_DRY_RUN: v }).dryRun, true, v);
  for (const v of ["maybe", "2", "enabled"]) {
    const c = loadConfig({ TESLA_FLEET_DRY_RUN: v });
    assert.equal(c.dryRun, true, v);
    assert.equal(c.warnings.filter((w) => w.includes("TESLA_FLEET_DRY_RUN")).length, 1);
    assert.ok(!c.warnings.join(" ").includes(v), "value not echoed");
  }
  assert.equal(loadConfig({}).dryRun, false);
});

test("TESLA_FLEET_ENABLE_LOCATION: default on; off values off; unrecognised = off with a warning", () => {
  assert.equal(loadConfig({}).locationEnabled, true);
  assert.equal(loadConfig({}).locationPrecision, "coarse");
  for (const v of ["", "${TESLA_FLEET_ENABLE_LOCATION}", "1", "true", "on", "YES"]) assert.equal(loadConfig({ TESLA_FLEET_ENABLE_LOCATION: v }).locationEnabled, true, v);
  for (const v of ["0", "false", "no", "OFF"]) {
    const c = loadConfig({ TESLA_FLEET_ENABLE_LOCATION: v });
    assert.equal(c.locationEnabled, false, v);
    assert.ok(!c.warnings.some((w) => w.includes("TESLA_FLEET_ENABLE_LOCATION")));
  }
  const bad = loadConfig({ TESLA_FLEET_ENABLE_LOCATION: "disabled" });
  assert.equal(bad.locationEnabled, false);
  assert.equal(bad.warnings.filter((w) => w.includes("TESLA_FLEET_ENABLE_LOCATION")).length, 1);
  assert.equal(loadConfig({ TESLA_FLEET_DEFAULT_LOCATION_PRECISION: "precise" }).locationPrecision, "precise");
  const p = loadConfig({ TESLA_FLEET_DEFAULT_LOCATION_PRECISION: "exact" });
  assert.equal(p.locationPrecision, "coarse");
  assert.equal(p.warnings.length, 1);
});

test("TESLA_FLEET_PROXY_CA_FILE is an alias for TESLA_COMMAND_PROXY_CA_CERT; the primary name wins", () => {
  assert.equal(loadConfig({ TESLA_FLEET_PROXY_CA_FILE: "/path/to/alias-ca.pem" }).proxyCaCertPath, "/path/to/alias-ca.pem");
  assert.equal(loadConfig({ TESLA_COMMAND_PROXY_CA_CERT: "/path/to/primary-ca.pem", TESLA_FLEET_PROXY_CA_FILE: "/path/to/alias-ca.pem" }).proxyCaCertPath, "/path/to/primary-ca.pem");
  assert.equal(loadConfig({ TESLA_COMMAND_PROXY_CA_CERT: "${TESLA_COMMAND_PROXY_CA_CERT}", TESLA_FLEET_PROXY_CA_FILE: "/path/to/alias-ca.pem" }).proxyCaCertPath, "/path/to/alias-ca.pem", "unexpanded primary placeholder falls back to the alias");
  assert.equal(loadConfig({}).proxyCaCertPath, undefined);
  assert.equal(configPresence({ TESLA_FLEET_PROXY_CA_FILE: "/x.pem" }).TESLA_FLEET_PROXY_CA_FILE, "set");
});
