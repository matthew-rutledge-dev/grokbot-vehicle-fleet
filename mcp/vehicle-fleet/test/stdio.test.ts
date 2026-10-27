/**
 * Starts the BUILT server over stdio the way hosts do (node <abs>/dist/index.js,
 * neutral cwd, unset plugin variables passed through as literal ${...}).
 * All Fleet API / auth / proxy URLs point at a local fake HTTP server on
 * 127.0.0.1: zero real Tesla calls, no real tokens.
 */
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COMMANDS, READ_TOOLS, VIN, fixtureData, tmpDir } from "./helpers.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(pkgDir, "dist", "index.js");

let server: http.Server;
let base = "";
const hits: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      hits.push(`${req.method} ${url.pathname}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/oauth2/v3/token") return send(200, { access_token: "access-EXAMPLE", refresh_token: "rotated-EXAMPLE", expires_in: 28800 });
      if (url.pathname === `/api/1/vehicles/${VIN}`) return send(200, { response: { vin: VIN, state: "online" } });
      if (url.pathname === "/api/1/vehicles/fleet_status") return send(200, { response: { key_paired_vins: [VIN], unpaired_vins: [] } });
      if (url.pathname === `/api/1/vehicles/${VIN}/vehicle_data_cached`) return send(200, { response: fixtureData() });
      if (url.pathname === `/proxy/api/1/vehicles/${VIN}/command/door_lock`) return send(200, { response: { result: true, reason: "" } });
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

async function connect(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && !k.startsWith("TESLA_") && k !== "GROK_PLUGIN_DATA") env[k] = v;
  }
  for (const k of ["TESLA_CLIENT_ID", "TESLA_REFRESH_TOKEN", "TESLA_FLEET_REGION", "TESLA_FLEET_BASE_URL", "TESLA_COMMAND_PROXY_URL",
    "TESLA_COMMAND_PROXY_CA_CERT", "TESLA_FLEET_READ_ONLY", "TESLA_FLEET_ENABLE_LOCATION", "TESLA_DEFAULT_VIN"]) {
    env[k] = `\${${k}}`; // unexpanded host placeholders
  }
  env.TESLA_TOKEN_STORE = path.join(tmpDir(), "tokens.json");
  Object.assign(env, extra);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: os.tmpdir(), env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const client = new Client({ name: "vehicle-fleet-smoke", version: "0.0.0" });
  await client.connect(transport);
  return Object.assign(client, { stderrText: () => stderr });
}

const text = (res: unknown) => JSON.parse((res as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>;

const live = () => ({
  TESLA_CLIENT_ID: "example-client-id",
  TESLA_REFRESH_TOKEN: "seed-refresh-token-EXAMPLE-0001",
  TESLA_FLEET_BASE_URL: base,
  TESLA_FLEET_AUTH_BASE_URL: base,
  TESLA_COMMAND_PROXY_URL: `${base}/proxy`,
  TESLA_DEFAULT_VIN: VIN,
});

test("initialize + default (placeholders) = read-only: no command tools", async () => {
  const c = await connect({});
  try {
    assert.equal(c.getServerVersion()?.name, "vehicle-fleet");
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...READ_TOOLS, "get_location"].sort());
    const res = await c.callTool({ name: "door_lock", arguments: { confirm: true, user_request: "lock" } });
    assert.equal(text(res).readOnly, true);
    const b = text(await c.callTool({ name: "describe_boundary", arguments: {} }));
    assert.match(String(b.readOnlyStatus), /unexpanded placeholder/);
    assert.equal(names.length, 16);
    const u = text(await c.callTool({ name: "get_api_usage", arguments: {} }));
    assert.equal(u.ok, true);
    assert.equal(u.localEstimate, true);
    const tm = u.thisMonth as { counts: Record<string, Record<string, number>>; estimate: Record<string, unknown> };
    for (const cat of ["data", "command", "wake", "other", "auth"]) assert.deepEqual(tm.counts[cat], { billable: 0, notBilled: 0, noResponse: 0 });
    assert.equal(tm.estimate.beforeDiscountUsd, 0);
    assert.equal(tm.estimate.afterDiscountUsd, 0);
  } finally {
    await c.close();
  }
});

test("TESLA_FLEET_READ_ONLY=false exposes commands; no confirm = dry-run with zero HTTP", async () => {
  const c = await connect({ ...live(), TESLA_FLEET_READ_ONLY: "false" });
  try {
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...READ_TOOLS, ...COMMANDS, "get_location"].sort());
    assert.equal(names.length, 42);
    assert.ok(names.includes("get_api_usage"));
    const before = hits.length;
    const b = text(await c.callTool({ name: "door_lock", arguments: {} }));
    assert.equal(b.dryRun, true);
    assert.equal(b.sent, false);
    assert.equal(hits.length, before, "dry-run made no HTTP request");
  } finally {
    await c.close();
  }
});

test("reads + confirmed command against the local fake (refresh, cached read, proxy)", async () => {
  const c = await connect({ ...live(), TESLA_FLEET_READ_ONLY: "off" });
  try {
    const bat = text(await c.callTool({ name: "get_battery_charge", arguments: {} }));
    assert.equal(bat.source, "cached");
    const lock = text(await c.callTool({ name: "door_lock", arguments: { confirm: true, user_request: "lock my car" } }));
    assert.equal(lock.ok, true);
    assert.ok(hits.includes(`POST /proxy/api/1/vehicles/${VIN}/command/door_lock`));
    assert.ok(!hits.some((h) => h.includes("wake_up")));
  } finally {
    await c.close();
  }
});

test("unrecognised flag stays read-only with exactly one warning; =0 no warning", async () => {
  const c = await connect({ TESLA_FLEET_READ_ONLY: "enabled" });
  try {
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("door_lock"));
    assert.equal(c.stderrText().split("\n").filter((l) => /not a recognised value/.test(l)).length, 1);
  } finally {
    await c.close();
  }
  const d = await connect({ TESLA_FLEET_READ_ONLY: "0" });
  try {
    assert.ok((await d.listTools()).tools.some((t) => t.name === "door_lock"));
    assert.ok(!/not a recognised value/.test(d.stderrText()));
  } finally {
    await d.close();
  }
});
