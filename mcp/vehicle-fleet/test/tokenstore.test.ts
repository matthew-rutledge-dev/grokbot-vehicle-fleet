import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { sha256, TokenStore } from "../src/tokenstore.js";
import { tmpDir } from "./helpers.js";

test("atomic write, 0600, no temp files left", () => {
  const dir = path.join(tmpDir(), "nested");
  const s = new TokenStore(path.join(dir, "tokens.json"));
  assert.equal(s.read(), undefined);
  s.write({ version: 1, refresh_token: "r1" });
  assert.equal(s.read()?.refresh_token, "r1");
  assert.ok(s.read()?.updated_at);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, "tokens.json")).mode & 0o777, 0o600);
  }
});

test("lock serialises concurrent writers", async () => {
  const s = new TokenStore(path.join(tmpDir(), "tokens.json"));
  s.write({ version: 1, refresh_token: "0" });
  const bump = () => s.withLock(async () => {
    const n = Number(s.read()?.refresh_token);
    await new Promise((r) => setTimeout(r, 5));
    s.write({ version: 1, refresh_token: String(n + 1) });
  });
  await Promise.all([bump(), bump(), bump(), bump()]);
  assert.equal(s.read()?.refresh_token, "4");
  assert.equal(fs.existsSync(`${s.filePath}.lock`), false);
});

test("stale lock is broken", async () => {
  const s = new TokenStore(path.join(tmpDir(), "tokens.json"));
  fs.writeFileSync(`${s.filePath}.lock`, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${s.filePath}.lock`, old, old);
  assert.equal(await s.withLock(async () => 42), 42);
});

test("sha256 is hex", () => {
  assert.match(sha256("x"), /^[0-9a-f]{64}$/);
});
