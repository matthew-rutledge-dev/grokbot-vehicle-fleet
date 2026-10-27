import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TokenManager } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { Http } from "../src/http.js";
import { RateLimiter } from "../src/ratelimit.js";
import { startTokenKeepFresh } from "../src/server.js";
import {
  AccessTokenExporter, canonicalPath, isAbsoluteFor, KeepFresh, KEEP_FRESH_LEAD_MS, resolveExportPath, type Scheduler,
} from "../src/tokenexport.js";
import { TokenStore } from "../src/tokenstore.js";
import { AUTH, VIN, baseEnv, connect, fakeFetch, routes, setup, tmpDir, type Route } from "./helpers.js";

const POSIX = process.platform !== "win32";
const EXPORT = "TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE";

function mk(env: Record<string, string>, now?: () => number, over: Record<string, Route> = {}) {
  const f = fakeFetch(routes(over));
  const config = loadConfig(env);
  const warnings: string[] = [];
  const exporter = new AccessTokenExporter(config.accessTokenExportPath, (m) => warnings.push(m), config.tokenStorePath);
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

// ---------- collision guard: symlinks and hardlinks ----------

test("refused: export through a symlinked directory that points at the store's directory", { skip: !POSIX }, () => {
  const dir = tmpDir();
  const storeDir = path.join(dir, "store");
  fs.mkdirSync(storeDir);
  const store = path.join(storeDir, "tokens.json");
  fs.writeFileSync(store, "{}");
  const link = path.join(dir, "link");
  fs.symlinkSync(storeDir, link, "dir");
  for (const name of ["tokens.json", "tokens.json.lock", "usage.json"]) {
    const config = loadConfig(baseEnv({ TESLA_TOKEN_STORE: store, [EXPORT]: path.join(link, name) }));
    assert.equal(config.accessTokenExportPath, undefined, name);
    assert.equal(config.warnings.filter((w) => w.includes(EXPORT)).length, 1);
  }
  // A different file in the same (linked) directory is allowed.
  assert.ok(resolveExportPath(path.join(link, "access-token"), store).path);
});

test("refused: the token store configured through a symlink", { skip: !POSIX }, () => {
  const dir = tmpDir();
  const real = path.join(dir, "real");
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(dir, "alias"), "dir");
  const storeViaLink = path.join(dir, "alias", "tokens.json");
  assert.equal(resolveExportPath(path.join(real, "tokens.json"), storeViaLink).path, undefined);
  assert.equal(resolveExportPath(path.join(real, "usage.json"), storeViaLink).path, undefined);
  // The export file itself a symlink to the store.
  fs.writeFileSync(path.join(real, "tokens.json"), "{}");
  fs.symlinkSync(path.join(real, "tokens.json"), path.join(dir, "tok-link"));
  assert.equal(resolveExportPath(path.join(dir, "tok-link"), storeViaLink).path, undefined);
});

test("refused: an existing export target that is a hardlink to the store (dev+ino)", (t) => {
  const dir = tmpDir();
  const store = path.join(dir, "a", "tokens.json");
  fs.mkdirSync(path.dirname(store));
  fs.writeFileSync(store, "{}");
  const hard = path.join(dir, "b-access-token");
  try {
    fs.linkSync(store, hard);
  } catch {
    t.skip("hardlinks not supported here");
    return;
  }
  assert.equal(resolveExportPath(hard, store).path, undefined);
});

test("guard is re-checked before each write (a symlink swapped in after start)", { skip: !POSIX }, async () => {
  const dir = tmpDir();
  const store = path.join(dir, "store", "tokens.json");
  const out = path.join(dir, "out", "tokens.json"); // same name, different (real) directory: allowed at start
  const { tm, warnings } = mk(baseEnv({ TESLA_TOKEN_STORE: store, [EXPORT]: out }));
  assert.equal(await tm.forceRefresh(), "access-EXAMPLE-1");
  assert.equal(fs.readFileSync(out, "utf8"), "access-EXAMPLE-1");
  fs.rmSync(path.dirname(out), { recursive: true });
  fs.symlinkSync(path.dirname(store), path.dirname(out), "dir"); // now out -> the store itself
  const before = fs.readFileSync(store, "utf8");
  assert.equal(await tm.forceRefresh(), "access-EXAMPLE-2", "server keeps serving");
  assert.ok(fs.readFileSync(store, "utf8").includes("rotated-EXAMPLE-2"), "store still holds JSON, not the access token");
  assert.notEqual(fs.readFileSync(store, "utf8"), "access-EXAMPLE-2");
  assert.notEqual(before, "");
  assert.equal(warnings.filter((w) => w.includes("now resolves")).length, 1);
});

test("platform rules: win32 needs a drive letter or UNC; darwin and win32 compare case-insensitively", () => {
  assert.equal(isAbsoluteFor("C:\\data\\tok", "win32"), true);
  assert.equal(isAbsoluteFor("\\\\server\\share\\tok", "win32"), true);
  assert.equal(isAbsoluteFor("\\tok", "win32"), false, "rooted path without a drive");
  assert.equal(isAbsoluteFor("/tok", "win32"), false);
  assert.equal(isAbsoluteFor("C:tok", "win32"), false);
  assert.equal(resolveExportPath("\\tok", "C:\\x\\tokens.json", "win32").path, undefined);
  const dir = tmpDir();
  const store = path.join(dir, "Store", "Tokens.json");
  assert.equal(canonicalPath(store, "darwin"), canonicalPath(store.toLowerCase(), "darwin"));
  assert.equal(resolveExportPath(path.join(dir, "store", "tokens.JSON"), store, "darwin").path, undefined);
  assert.equal(resolveExportPath(path.join(dir, "store", "tokens.JSON"), store, "win32").path, undefined);
  assert.ok(resolveExportPath(path.join(dir, "store", "tokens.JSON"), store, "linux").path, "case-sensitive on linux");
});

test("warns once (no path) when the existing parent directory is group- or world-writable", { skip: !POSIX }, () => {
  const dir = path.join(tmpDir(), "shared");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o777);
  const warnings: string[] = [];
  const ex = new AccessTokenExporter(path.join(dir, "access-token"), (m) => warnings.push(m), path.join(tmpDir(), "tokens.json"));
  assert.equal(ex.write("t1"), true);
  assert.equal(ex.write("t2"), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /group- or world-writable/);
  assert.ok(!warnings[0].includes(dir));
  assert.equal(fs.statSync(path.join(dir, "access-token")).mode & 0o777, 0o600, "final mode 0600 without a chmod");
});

// ---------- keep-fresh loop (fake scheduler, fake clock) ----------

function fakeScheduler() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const s: Scheduler = {
    setTimeout(fn, ms) {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout(h) {
      (h as { cleared: boolean }).cleared = true;
    },
  };
  const pending = () => timers.filter((t) => !t.cleared && !(t as { fired?: boolean }).fired);
  const fire = async () => {
    const t = pending()[0];
    assert.ok(t, "a timer is scheduled");
    (t as { fired?: boolean }).fired = true;
    t.fn();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    return t.ms;
  };
  return { s, timers, pending, fire };
}

test("keep-fresh: startup refresh writes the file, then refreshes ~10 min before expiry, repeatedly", async () => {
  let t = 1_000_000;
  const out = path.join(tmpDir(), "access-token");
  const { tm, calls } = mk(baseEnv({ [EXPORT]: out }), () => t);
  const sch = fakeScheduler();
  const k = new KeepFresh(tm, () => t, sch.s, () => undefined, () => 0);
  await k.start();
  assert.equal(fs.readFileSync(out, "utf8"), "access-EXAMPLE-1", "written at startup");
  assert.equal(sch.pending().length, 1);
  assert.equal(sch.pending()[0].ms, 28800 * 1000 - KEEP_FRESH_LEAD_MS, "expires_in minus 10 min");
  t += sch.pending()[0].ms;
  await sch.fire();
  assert.equal(fs.readFileSync(out, "utf8"), "access-EXAMPLE-2", "refreshed before expiry");
  assert.equal(sch.pending().length, 1, "next one scheduled");
  t += sch.pending()[0].ms;
  await sch.fire();
  assert.equal(fs.readFileSync(out, "utf8"), "access-EXAMPLE-3");
  assert.equal(calls.filter((c) => c.url === `${AUTH}/oauth2/v3/token`).length, 3);
  k.stop();
  assert.equal(sch.pending().length, 0);
});

test("keep-fresh shares the single-flight refresh with tool calls (one token request)", async () => {
  const out = path.join(tmpDir(), "access-token");
  const { tm, calls } = mk(baseEnv({ [EXPORT]: out }));
  const sch = fakeScheduler();
  const k = new KeepFresh(tm, Date.now, sch.s, () => undefined, () => 0);
  const [, a] = await Promise.all([k.start(), tm.getAccessToken()]);
  assert.equal(a, "access-EXAMPLE-1");
  assert.equal(calls.filter((c) => c.url === `${AUTH}/oauth2/v3/token`).length, 1);
});

test("keep-fresh: failures back off 1, 5, 15, 15 min with one warning, then recover", async () => {
  let t = 1_000_000;
  let fail = true;
  let n = 0;
  const out = path.join(tmpDir(), "access-token");
  const { tm } = mk(baseEnv({ [EXPORT]: out }), () => t, {
    [`POST ${AUTH}/oauth2/v3/token`]: () => {
      if (fail) return { status: 503, body: {} };
      n++;
      return { status: 200, body: { access_token: `access-EXAMPLE-${n}`, refresh_token: `rotated-EXAMPLE-${n}`, expires_in: 28800 } };
    },
  });
  const warnings: string[] = [];
  const sch = fakeScheduler();
  const k = new KeepFresh(tm, () => t, sch.s, (m) => warnings.push(m), () => 0);
  await k.start();
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) {
    delays.push(sch.pending()[0].ms);
    t += sch.pending()[0].ms;
    await sch.fire();
  }
  delays.push(sch.pending()[0].ms);
  assert.deepEqual(delays, [60_000, 300_000, 900_000, 900_000]);
  assert.equal(warnings.length, 1);
  assert.ok(!/EXAMPLE/.test(warnings[0]));
  assert.equal(fs.existsSync(out), false);
  fail = false;
  t += sch.pending()[0].ms;
  await sch.fire();
  assert.equal(fs.readFileSync(out, "utf8"), "access-EXAMPLE-1");
  assert.equal(sch.pending()[0].ms, 28800 * 1000 - KEEP_FRESH_LEAD_MS, "back to the normal schedule");
});

test("keep-fresh: login_required stops the loop and leaves the file alone", async () => {
  let t = 1_000_000;
  let revoked = false;
  const out = path.join(tmpDir(), "access-token");
  const { tm } = mk(baseEnv({ [EXPORT]: out }), () => t, {
    [`POST ${AUTH}/oauth2/v3/token`]: () =>
      revoked
        ? { status: 401, body: { error: "login_required" } }
        : { status: 200, body: { access_token: "access-EXAMPLE-1", refresh_token: "rotated-EXAMPLE-1", expires_in: 28800 } },
  });
  const warnings: string[] = [];
  const sch = fakeScheduler();
  const k = new KeepFresh(tm, () => t, sch.s, (m) => warnings.push(m), () => 0);
  await k.start();
  assert.equal(fs.readFileSync(out, "utf8"), "access-EXAMPLE-1");
  revoked = true;
  t += sch.pending()[0].ms;
  await sch.fire();
  assert.equal(sch.pending().length, 0, "nothing scheduled");
  assert.equal(k.running, false);
  assert.equal(fs.readFileSync(out, "utf8"), "access-EXAMPLE-1", "file left as is");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /login_required/);
});

test("keep-fresh: nothing scheduled when export is off, or when no refresh token exists", async () => {
  const sch = fakeScheduler();
  const { ctx, calls } = setup(baseEnv());
  assert.equal(startTokenKeepFresh(ctx, { scheduler: sch.s }), undefined);
  assert.equal(sch.timers.length, 0);
  assert.equal(calls.length, 0, "no refresh at startup when export is off");
  const env = baseEnv({ [EXPORT]: path.join(tmpDir(), "access-token") });
  delete (env as Record<string, string | undefined>).TESLA_REFRESH_TOKEN;
  const { tm } = mk(env);
  const k = new KeepFresh(tm, Date.now, sch.s, () => undefined);
  await k.start();
  assert.equal(sch.timers.length, 0);
});

test("real scheduler timers are unref'd", async () => {
  const { realScheduler } = await import("../src/tokenexport.js");
  const h = realScheduler.setTimeout(() => undefined, 60_000) as ReturnType<typeof setTimeout>;
  assert.equal(h.hasRef(), false);
  realScheduler.clearTimeout(h);
});
