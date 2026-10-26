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

test("defaults: read-only, location off, missing client id reported", () => {
  const c = loadConfig({});
  assert.equal(c.readOnly.readOnly, true);
  assert.equal(c.locationEnabled, false);
  assert.ok(c.problems.includes("TESLA_CLIENT_ID is not set"));
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
