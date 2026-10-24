import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, RateLimiter } from "../src/ratelimit.js";

test("documented limits", () => {
  assert.equal(LIMITS.data.capacity, 60);
  assert.equal(LIMITS.wake.capacity, 3);
  assert.equal(LIMITS.command.capacity, 30);
  assert.ok(LIMITS.auth.capacity <= 20);
});

test("wake bucket: 3 per minute per VIN, refills over time, separate per VIN", () => {
  let t = 0;
  const rl = new RateLimiter(() => t);
  for (let i = 0; i < 3; i++) rl.take("wake", "A");
  assert.throws(() => rl.take("wake", "A"), /Local wake rate limit/);
  rl.take("wake", "B");
  t += 20_000;
  rl.take("wake", "A");
});
