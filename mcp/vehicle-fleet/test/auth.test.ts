import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { TokenManager } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { Http } from "../src/http.js";
import { RateLimiter } from "../src/ratelimit.js";
import { sha256, TokenStore } from "../src/tokenstore.js";
import { AUTH, SEED, baseEnv, fakeFetch, routes } from "./helpers.js";

function mk(env: Record<string, string>, over = {}, now?: () => number) {
  const f = fakeFetch(routes(over));
  const config = loadConfig(env);
  const store = new TokenStore(config.tokenStorePath);
  const tm = new TokenManager(config, store, new Http(f.impl), new RateLimiter(), now);
  return { tm, store, calls: f.calls };
}

test("seed is adopted, rotated token persisted before use, correct host + form body", async () => {
  const { tm, store, calls } = mk(baseEnv());
  const tok = await tm.getAccessToken();
  assert.equal(tok, "access-EXAMPLE-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${AUTH}/oauth2/v3/token`);
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("client_id"), "example-client-id");
  assert.equal(form.get("refresh_token"), SEED);
  assert.equal(form.get("client_secret"), null, "refresh does not send the client secret");
  const saved = store.read()!;
  assert.equal(saved.refresh_token, "rotated-EXAMPLE-1");
  assert.ok(saved.seen_seed_sha256?.includes(sha256(SEED)));
  assert.ok(!fs.readFileSync(store.filePath, "utf8").includes("access-EXAMPLE"), "access token never on disk");
});

test("cached access token reused until 60 s before expiry", async () => {
  let t = 1_000_000;
  const { tm, calls } = mk(baseEnv(), {}, () => t);
  await tm.getAccessToken();
  t += (28800 - 120) * 1000;
  await tm.getAccessToken();
  assert.equal(calls.length, 1);
  t += 90 * 1000; // now within 60 s of expiry
  assert.equal(await tm.getAccessToken(), "access-EXAMPLE-2");
  assert.equal(calls.length, 2);
  assert.equal(new URLSearchParams(calls[1].body).get("refresh_token"), "rotated-EXAMPLE-1");
});

test("single-flight: concurrent callers share one refresh", async () => {
  const { tm, calls } = mk(baseEnv());
  const toks = await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()]);
  assert.deepEqual(new Set(toks).size, 1);
  assert.equal(calls.length, 1);
});

test("restart: already-seen seed is NOT re-adopted; stored rotated token wins", async () => {
  const env = baseEnv();
  await mk(env).tm.getAccessToken();
  const second = mk(env);
  await second.tm.getAccessToken();
  assert.equal(new URLSearchParams(second.calls[0].body).get("refresh_token"), "rotated-EXAMPLE-1");
});

test("a new seed (after re-consent) is adopted", async () => {
  const env = baseEnv();
  await mk(env).tm.getAccessToken();
  const again = mk({ ...env, TESLA_REFRESH_TOKEN: "fresh-seed-EXAMPLE-0002" });
  await again.tm.getAccessToken();
  assert.equal(new URLSearchParams(again.calls[0].body).get("refresh_token"), "fresh-seed-EXAMPLE-0002");
});

test("login_required marks needs_reauth and stops (no loop)", async () => {
  const { tm, store, calls } = mk(baseEnv(), {
    [`POST ${AUTH}/oauth2/v3/token`]: () => ({ status: 401, body: { error: "login_required" } }),
  });
  await assert.rejects(tm.getAccessToken(), /Refresh token expired/);
  assert.equal(store.read()?.needs_reauth, true);
  await assert.rejects(tm.getAccessToken(), /re-consent/);
  assert.equal(calls.length, 1, "second attempt refused locally");
});

test("no refresh token -> local refusal, no network", async () => {
  const env = baseEnv();
  delete (env as Record<string, string | undefined>).TESLA_REFRESH_TOKEN;
  const { tm, calls } = mk(env);
  await assert.rejects(tm.getAccessToken(), /No refresh token/);
  assert.equal(calls.length, 0);
});
