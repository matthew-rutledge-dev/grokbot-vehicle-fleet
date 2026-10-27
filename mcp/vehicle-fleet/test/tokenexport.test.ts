import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TokenManager } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { Http } from "../src/http.js";
import { RateLimiter } from "../src/ratelimit.js";
import { AccessTokenExporter, resolveExportPath } from "../src/tokenexport.js";
import { TokenStore } from "../src/tokenstore.js";
import { VIN, baseEnv, connect, fakeFetch, routes, setup, tmpDir } from "./helpers.js";

const POSIX = process.platform !== "win32";
const EXPORT = "TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE";

function mk(env: Record<string, string>, now?: () => number) {
  const f = fakeFetch(routes());
  const config = loadConfig(env);
  const warnings: string[] = [];
  const exporter = new AccessTokenExporter(config.accessTokenExportPath, (m) => warnings.push(m));
  const tm = new TokenManager(config, new TokenStore(config.tokenStorePath), new Http(f.impl), new RateLimiter(), now, exporter);
  return { tm, config, warnings, calls: f.calls };
}

test("export is off by default: no path, nothing written, status off", async () => {
  const env = baseEnv();
  const { tm, config } = mk(env);
  assert.equal(config.accessTokenExportPath, undefined);
  await tm.getAccessToken();
  const files = fs.readdirSync(path.dirname(env.TESLA_TOKEN_STORE));
  assert.ok(files.every((f) => f === "tokens.json"), `only the token store is written (${files.join(",")})`);
  assert.equal(tm.status().accessTokenExport, "off");
  for (const v of ["", "   ", "${TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE}"]) {
    assert.equal(loadConfig(baseEnv({ [EXPORT]: v })).accessTokenExportPath, undefined, `"${v}" = off`);
  }
});

test("after a refresh the file holds the raw access token only, mode 0600, new parent dir 0700", async () => {
  const out = path.join(tmpDir(), "state", "grokbot-vehicle-fleet", "access-token");
  const { tm, warnings } = mk(baseEnv({ [EXPORT]: out }));
  const tok = await tm.getAccessToken();
  assert.equal(fs.readFileSync(out, "utf8"), tok, "raw string: no newline, no JSON");
  assert.ok(!fs.readFileSync(out, "utf8").includes("rotated-EXAMPLE"), "never the refresh token");
  assert.equal(tm.status().accessTokenExport, "on");
  assert.deepEqual(warnings, []);
  if (POSIX) {
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(out)).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ["access-token"], "no temp files left behind");
});

test("rewritten on rotation", async () => {
  let t = 1_000_000;
  const out = path.join(tmpDir(), "access-token");
  const { tm } = mk(baseEnv({ [EXPORT]: out }), () => t);
  assert.equal(await tm.getAccessToken(), "access-EXAMPLE-1");
  assert.equal(fs.readFileSync(out, "utf8"), "access-EXAMPLE-1");
  t += 28800 * 1000;
  assert.equal(await tm.getAccessToken(), "access-EXAMPLE-2");
  assert.equal(fs.readFileSync(out, "utf8"), "access-EXAMPLE-2");
  if (POSIX) assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test("refused (export off, safe warning, server keeps working) when it collides with the token store or is relative", async () => {
  const dir = tmpDir();
  const store = path.join(dir, "tokens.json");
  const bad = [store, path.join(store, "access-token"), `${store}.lock`, path.join(dir, "usage.json"), "relative/access-token", path.join(dir, "sub") + path.sep];
  for (const p of bad) {
    const env = baseEnv({ TESLA_TOKEN_STORE: store, [EXPORT]: p });
    const config = loadConfig(env);
    assert.equal(config.accessTokenExportPath, undefined, p);
    const w = config.warnings.filter((x) => x.includes(EXPORT));
    assert.equal(w.length, 1, p);
    assert.ok(!w[0].includes(dir) && !w[0].includes(p), "warning does not echo the path");
    assert.deepEqual(config.problems, [], "not a fatal config problem");
  }
  assert.equal(resolveExportPath(path.join(dir, "access-token"), store).path, path.join(dir, "access-token"), "a sibling file is fine");
  // The token store is still written correctly and the server still serves tokens.
  const { tm } = mk(baseEnv({ TESLA_TOKEN_STORE: store, [EXPORT]: store }));
  assert.equal(await tm.getAccessToken(), "access-EXAMPLE-1");
  assert.equal(new TokenStore(store).read()?.refresh_token, "rotated-EXAMPLE-1");
});

test("a write failure warns once (no token, no path) and keeps serving", async () => {
  let t = 1_000_000;
  const out = path.join(tmpDir(), "is-a-dir");
  fs.mkdirSync(path.join(out, "child"), { recursive: true });
  const { tm, warnings } = mk(baseEnv({ [EXPORT]: out }), () => t);
  assert.equal(await tm.getAccessToken(), "access-EXAMPLE-1");
  t += 28800 * 1000;
  assert.equal(await tm.getAccessToken(), "access-EXAMPLE-2");
  assert.equal(warnings.length, 1, "warned once");
  assert.ok(!/access-EXAMPLE|rotated-EXAMPLE|seed-refresh/.test(warnings[0]));
  assert.ok(!warnings[0].includes(out));
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ["is-a-dir"], "no temp files left behind");
});

test("no token in tool output or stderr with export on", async () => {
  const out = path.join(tmpDir(), "access-token");
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  try {
    const { ctx } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN, [EXPORT]: out }));
    const c = await connect(ctx);
    const texts: string[] = [];
    for (const name of ["get_battery_charge", "describe_boundary"]) {
      const res = (await c.callTool({ name, arguments: {} })) as { content: Array<{ text?: string }> };
      texts.push(...res.content.map((x) => x.text ?? ""));
    }
    const tok = fs.readFileSync(out, "utf8");
    assert.ok(tok.startsWith("access-EXAMPLE"));
    const all = [...texts, ...errs].join("\n");
    assert.ok(!all.includes(tok), "access token never in tool output or stderr");
    assert.ok(!all.includes(out), "export path not echoed");
    assert.match(texts.join("\n"), /accessTokenExport/);
  } finally {
    console.error = orig;
  }
});
