import assert from "node:assert/strict";
import { test } from "node:test";
import { describeReadOnly, resolveReadOnly } from "../src/readonly.js";

test("fails closed: only explicit off values expose commands", () => {
  const cases: Array<[string | undefined, boolean, string]> = [
    [undefined, true, "unset"],
    ["", true, "unset"],
    ["   ", true, "unset"],
    ["${TESLA_FLEET_READ_ONLY}", true, "unset"],
    ["1", true, "on"], ["true", true, "on"], ["YES", true, "on"], ["On", true, "on"],
    ["0", false, "off"], ["false", false, "off"], ["No", false, "off"], [" OFF ", false, "off"],
    ["enabled", true, "unrecognised"], ["2", true, "unrecognised"], ["disable", true, "unrecognised"],
  ];
  for (const [v, ro, src] of cases) {
    const r = resolveReadOnly(v);
    assert.equal(r.readOnly, ro, `value ${JSON.stringify(v)}`);
    assert.equal(r.source, src, `value ${JSON.stringify(v)}`);
  }
});

test("unrecognised value warns once and truncates raw to 32 chars", () => {
  const r = resolveReadOnly("x".repeat(50));
  assert.equal(r.readOnly, true);
  assert.equal(r.raw?.length, 32);
  assert.match(r.warning ?? "", /staying read-only/);
  assert.equal(resolveReadOnly("off").warning, undefined);
});

test("describeReadOnly texts", () => {
  assert.match(describeReadOnly(resolveReadOnly(undefined)), /read-only ON .*unset: not set; default/);
  assert.match(describeReadOnly(resolveReadOnly("false")), /read-only OFF .*explicit off value/);
  assert.match(describeReadOnly(resolveReadOnly("enabled")), /fails closed/);
});
