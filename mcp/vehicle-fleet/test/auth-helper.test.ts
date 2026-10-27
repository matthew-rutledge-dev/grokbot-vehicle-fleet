import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers.js";

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "auth-helper.mjs");

function scopesFor(args: string[], extra: Record<string, string> = {}): string {
  const out = execFileSync(process.execPath, [HELPER, "url", ...args], {
    env: { PATH: process.env.PATH ?? "", TESLA_CLIENT_ID: "example-client-id", TESLA_REDIRECT_URI: "http://localhost:8765/callback", TESLA_TOKEN_STORE: path.join(tmpDir(), "t.json"), ...extra },
    encoding: "utf8",
  });
  const url = out.split(/\s+/).find((s) => s.startsWith("https://"))!;
  return new URL(url).searchParams.get("scope") ?? "";
}

test("auth helper: default scopes are read-only; command scopes only on opt-in", () => {
  assert.equal(scopesFor([]), "openid offline_access vehicle_device_data");
  assert.equal(scopesFor(["--commands"]), "openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds");
  assert.equal(scopesFor(["--energy-commands"]), "openid offline_access vehicle_device_data energy_device_data energy_cmds");
  assert.equal(scopesFor([], { TESLA_AUTH_COMMANDS: "1", TESLA_AUTH_ENERGY: "1" }), "openid offline_access vehicle_device_data energy_device_data vehicle_cmds vehicle_charging_cmds");
  assert.throws(() => scopesFor(["--everything"]));
});
