import assert from "node:assert/strict";
import { test } from "node:test";
import { mapFleetError } from "../src/errors.js";
import { maskVin, redactSecrets, roundCoord } from "../src/redact.js";

test("status mapping", () => {
  const c = (s: number, b: unknown = {}, h?: Headers) => mapFleetError(s, b, h).info;
  assert.equal(c(401, { error: "login_required" }).code, "login_required");
  assert.equal(c(401, { error: "mobile_access_disabled" }).code, "mobile_access_disabled");
  assert.equal(c(401).code, "unauthorized");
  assert.equal(c(403, { error: "Tesla Vehicle Command Protocol required" }).code, "command_protocol_required");
  assert.equal(c(403, { error: "unauthorized_missing_scopes", error_description: "Unauthorized missing scopes" }).code, "missing_scope");
  assert.equal(c(403, { error: "forbidden" }).code, "forbidden");
  assert.equal(c(408).code, "vehicle_unavailable");
  assert.equal(c(408).billed, true);
  assert.equal(c(412, { error: "Unregistered account" }).code, "partner_not_registered");
  assert.equal(c(421).code, "wrong_region");
  assert.equal(c(422, { error: "vehicle rejected request: not_paired" }).code, "virtual_key_missing");
  const rl = c(429, {}, new Headers({ "retry-after": "17" }));
  assert.equal(rl.code, "rate_limited");
  assert.equal(rl.retryAfterSec, 17);
  assert.equal(c(451).code, "unavailable_legal");
  assert.equal(c(503).billed, false);
  assert.equal(c(540).code, "device_error");
});

test("redaction helpers", () => {
  assert.equal(maskVin("5YJ000000EXAMPLE"), "***MPLE");
  const t = redactSecrets("x seed-refresh-token-EXAMPLE y Bearer abcdefghijkl", ["seed-refresh-token-EXAMPLE"]);
  assert.ok(!t.includes("seed-refresh-token-EXAMPLE"));
  assert.ok(!t.includes("abcdefghijkl"));
  assert.equal(roundCoord(37.123456, "coarse"), 37.12);
  assert.equal(roundCoord(37.123456, "precise"), 37.12346);
});
