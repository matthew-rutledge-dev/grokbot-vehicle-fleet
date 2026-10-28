/**
 * play_video_on_screen (EXPERIMENTAL): URL validation, gating, allowlist,
 * dry-runs, audit log, and the signed_command send path against an in-process
 * fake vehicle. Every HTTP call goes to the fake fetch; no network.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { auditVin } from "../src/audit.js";
import { loadConfig, parseHostAllowlist } from "../src/config.js";
import { encodeVideoRequestAction } from "../src/signed/messages.js";
import { hostAllowed, validateVideoUrl } from "../src/tools/videourl.js";
import { FakeVehicle, type FakeVehicleOptions } from "./fake-vehicle.js";
import { BASE, baseEnv, body, connect, isError, setup, tmpDir, type Route } from "./helpers.js";

const VIN = "5YJ0000000EXAMPLE";
const URL_OK = "https://video.example.com/clips/intro.mp4?sig=SECRET-QUERY-EXAMPLE";
const TOOL = "play_video_on_screen";
const intent = { confirm: true, user_request: "play the intro clip on the car screen" };

function keyFile(): string {
  const dir = tmpDir();
  const p = path.join(dir, "command-key.pem");
  const pem = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "sec1" }) as string;
  fs.writeFileSync(p, pem, { mode: 0o600 });
  return p;
}

function env(extra: Record<string, string> = {}) {
  const dir = tmpDir();
  return baseEnv({
    TESLA_FLEET_READ_ONLY: "false",
    TESLA_DEFAULT_VIN: VIN,
    TESLA_FLEET_COMMAND_KEY_FILE: keyFile(),
    TESLA_FLEET_VIDEO_HOST_ALLOWLIST: "video.example.com, *.cdn.example.net",
    TESLA_FLEET_AUDIT_LOG: path.join(dir, "audit", "audit.jsonl"),
    ...extra,
  });
}

function vehicleRoutes(v?: FakeVehicle, over: Record<string, Route> = {}): Record<string, Route> {
  return {
    [`GET ${BASE}/api/1/vehicles/${VIN}`]: () => ({ status: 200, body: { response: { vin: VIN, state: "online" } } }),
    [`POST ${BASE}/api/1/vehicles/fleet_status`]: () => ({ status: 200, body: { response: { key_paired_vins: [VIN], unpaired_vins: [] } } }),
    ...(v ? {
      [`POST ${BASE}/api/1/vehicles/${VIN}/signed_command`]: async (call) => {
        const msg = JSON.parse(call.body!).routable_message as string;
        return { status: 200, body: { response: await v.handle(VIN, msg) } };
      },
    } : {}),
    ...over,
  };
}

function auditLines(e: Record<string, string>): Array<Record<string, unknown>> {
  const p = e.TESLA_FLEET_AUDIT_LOG;
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

function assertAuditHygiene(e: Record<string, string>) {
  const raw = fs.existsSync(e.TESLA_FLEET_AUDIT_LOG) ? fs.readFileSync(e.TESLA_FLEET_AUDIT_LOG, "utf8") : "";
  for (const l of raw.split("\n").filter(Boolean)) {
    const v = (JSON.parse(l) as { vin?: unknown }).vin;
    assert.ok(v === undefined || v === null || v === VIN, "audit vin is the full VIN (or null)");
  }
  assert.ok(!raw.includes("SECRET-QUERY"), "no query string");
  assert.ok(!raw.includes("/clips/intro.mp4"), "no path");
  assert.ok(!raw.includes("access-EXAMPLE"), "no token");
  assert.ok(!raw.includes("BEGIN"), "no key material");
}

const fake = (o: Partial<FakeVehicleOptions> = {}) => new FakeVehicle({ vin: VIN, ...o });

// ---------- audit VIN ----------

test("auditVin: full 17-character VIN, upper-cased; null when unknown or not VIN-shaped", () => {
  assert.equal(auditVin(VIN), VIN);
  assert.equal(auditVin(` ${VIN.toLowerCase()} `), VIN);
  assert.equal(auditVin(undefined), null);
  assert.equal(auditVin("SHORT"), null);
  assert.equal(auditVin(`${VIN}\n{"x":1}`), null);
});

// ---------- URL validation ----------

test("validateVideoUrl: accepts public https; host lower-cased; port and path kept for the keyed hash", () => {
  const v = validateVideoUrl("https://Video.Example.com/clips/intro.mp4?sig=SECRET-QUERY-EXAMPLE");
  assert.equal(v.host, "video.example.com");
  assert.equal(v.port, "");
  assert.equal(v.pathAndQuery, "/clips/intro.mp4?sig=SECRET-QUERY-EXAMPLE");
  assert.equal(validateVideoUrl("https://video.example.com:443/a.mp4").port, "", "default port normalised away");
  assert.equal(validateVideoUrl("https://video.example.com:8443/a.mp4").port, "8443");
  // Raw input is short, but the normalised (percent-encoded) URL would exceed the cap.
  assert.throws(() => validateVideoUrl(`https://video.example.com/${"\u00e9".repeat(400)}`), (e: unknown) => (e as { code?: string }).code === "invalid_video_url");
});

test("validateVideoUrl: refuses non-https, credentials, IPs, localhost/private names, junk, overlong", () => {
  const bad = [
    undefined, "", "   ", "not a url", "http://video.example.com/a.mp4", "ftp://video.example.com/a", "javascript:alert(1)",
    "https://user:pass@video.example.com/a.mp4", "https://user@video.example.com/a.mp4",
    "https://192.0.2.10/a.mp4", "https://[2001:db8::1]/a.mp4", "https://2130706433/a.mp4", "https://0x7f.1/a.mp4",
    "https://localhost/a.mp4", "https://cam.localhost/a", "https://nas/a.mp4", "https://nas.local/a.mp4", "https://box.internal/a",
    "https://router.lan/a", "https://printer.home.arpa/a", "https://video.example.com/a b.mp4",
    `https://video.example.com/${"a".repeat(2100)}`,
  ];
  for (const u of bad) assert.throws(() => validateVideoUrl(u), (e: unknown) => (e as { code?: string }).code === "invalid_video_url", String(u).slice(0, 60));
});

test("allowlist parsing and matching: exact host, *.domain = subdomains only; junk dropped with one warning", () => {
  const w: string[] = [];
  const list = parseHostAllowlist("Video.Example.com, *.cdn.example.net, 192.0.2.1, example.org:8443, example.com/path, single, ,", w);
  assert.deepEqual(list, ["video.example.com", "*.cdn.example.net", "example.org:8443"]);
  assert.equal(w.length, 1);
  assert.ok(!w[0].includes("192.0.2.1"), "warning does not echo entries");
  assert.equal(hostAllowed("video.example.com", list), true);
  assert.equal(hostAllowed("evil-video.example.com", list), false);
  assert.equal(hostAllowed("a.cdn.example.net", list), true);
  assert.equal(hostAllowed("cdn.example.net", list), false);
  assert.equal(hostAllowed("cdn.example.net.evil.example", list), false);
  assert.equal(hostAllowed("example.org", list, "8443"), true, "entry names the port");
  assert.equal(hostAllowed("example.org", list), false, "port entry does not cover 443");
  assert.equal(hostAllowed("video.example.com", list, "8443"), false, "portless entry does not cover other ports");
  assert.deepEqual(loadConfig({ TESLA_CLIENT_ID: "x" }).videoHostAllowlist, [], "unset = empty");
});

// ---------- gating ----------

test("read-only (default) hides and refuses play_video_on_screen; nothing sent", async () => {
  const { ctx, calls } = setup(baseEnv({ TESLA_DEFAULT_VIN: VIN }));
  const c = await connect(ctx);
  assert.ok(!(await c.listTools()).tools.some((t) => t.name === TOOL));
  const res = await c.callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } });
  assert.equal(isError(res), true);
  assert.equal(body(res).readOnly, true);
  assert.equal(calls.length, 0);
});

test("listed when commands are on; schema marks it EXPERIMENTAL and requires url", async () => {
  const { ctx } = setup(env());
  const c = await connect(ctx);
  const t = (await c.listTools()).tools.find((x) => x.name === TOOL)!;
  assert.ok(t);
  assert.match(t.description!, /^EXPERIMENTAL/);
  assert.deepEqual(t.inputSchema.required, ["url"]);
  const props = t.inputSchema.properties as Record<string, unknown>;
  for (const k of ["vin", "url", "allow_unlisted_host", "confirm", "user_request"]) assert.ok(k in props, k);
});

test("without confirm: dry-run preview (host + path hash only), zero network, audited", async () => {
  const e = env();
  const { ctx, calls } = setup(e, vehicleRoutes());
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: TOOL, arguments: { url: URL_OK } }));
  assert.equal(b.dryRun, true);
  assert.equal(b.sent, false);
  assert.equal(b.experimental, true);
  assert.equal((b.video as { host: string }).host, "video.example.com");
  assert.equal(b.hostAllowlisted, true);
  assert.match(String(b.commandKey), /present/);
  assert.equal((b.action as { vehicleAction: number }).vehicleAction, 57);
  assert.ok(!JSON.stringify(b).includes("SECRET-QUERY") && !JSON.stringify(b).includes("intro.mp4"), "URL not echoed");
  assert.equal(calls.length, 0);
  const a = auditLines(e);
  assert.equal(a.length, 1);
  assert.equal(a[0].event, "dry_run");
  assert.equal(a[0].vin, VIN, "audit records the full VIN");
  assert.equal("vinLast6" in a[0], false);
  assertAuditHygiene(e);
});

test("confirm without user_request: refused and audited, nothing sent", async () => {
  const e = env();
  const { ctx, calls } = setup(e, vehicleRoutes(fake()));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: TOOL, arguments: { url: URL_OK, confirm: true } }));
  assert.equal(b.code, "user_request_required");
  assert.equal(calls.length, 0);
  assert.deepEqual(auditLines(e).map((x) => [x.event, x.code]), [["refused", "user_request_required"]]);
});

test("invalid URL: refused before anything else (even with confirm), audited without the URL", async () => {
  const e = env();
  const { ctx, calls } = setup(e, vehicleRoutes(fake()));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: TOOL, arguments: { url: "http://192.0.2.10/private.mp4?token=SECRET-QUERY-EXAMPLE", ...intent } }));
  assert.equal(b.code, "invalid_video_url");
  assert.equal(calls.length, 0);
  const a = auditLines(e);
  assert.deepEqual(a.map((x) => [x.event, x.code]), [["refused", "invalid_video_url"]]);
  assert.ok(!JSON.stringify(a).includes("192.0.2.10") && !JSON.stringify(a).includes("SECRET"));
});

test("host not on the allowlist: refused unless allow_unlisted_host=true", async () => {
  const e = env();
  const v = fake();
  const { ctx, calls } = setup(e, vehicleRoutes(v));
  const c = await connect(ctx);
  const url = "https://media.example.org/x.mp4";
  const dry = body(await c.callTool({ name: TOOL, arguments: { url } }));
  assert.equal(dry.needsAllowUnlistedHost, true);
  assert.match(String(dry.toSend), /allow_unlisted_host=true/);
  const r1 = body(await c.callTool({ name: TOOL, arguments: { url, ...intent } }));
  assert.equal(r1.code, "video_host_not_allowlisted");
  const r2 = body(await c.callTool({ name: TOOL, arguments: { url, allow_unlisted_host: "true", ...intent } }));
  assert.equal(r2.code, "video_host_not_allowlisted", "only the boolean true counts");
  assert.equal(calls.length, 0);
  const ok = body(await c.callTool({ name: TOOL, arguments: { url, allow_unlisted_host: true, ...intent } }));
  assert.equal(ok.ok, true);
  const a = auditLines(e).filter((x) => x.event === "attempt");
  assert.equal(a.length, 1);
  assert.equal(a[0].hostAllowlisted, false);
  assert.equal(a[0].allowUnlistedHost, true);
});

test("unset allowlist: every host needs allow_unlisted_host", async () => {
  const e = env({ TESLA_FLEET_VIDEO_HOST_ALLOWLIST: "" });
  const { ctx, calls } = setup(e, vehicleRoutes(fake()));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
  assert.equal(b.code, "video_host_not_allowlisted");
  assert.equal(calls.length, 0);
});

test("TESLA_FLEET_DRY_RUN: confirmed call validated and previewed, nothing sent", async () => {
  const e = env({ TESLA_FLEET_DRY_RUN: "1" });
  const { ctx, calls } = setup(e, vehicleRoutes(fake()));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
  assert.equal(b.dryRunMode, "TESLA_FLEET_DRY_RUN");
  assert.equal((b.wouldSend as unknown[]).length, 2);
  assert.ok(!JSON.stringify(b).includes(VIN), "VIN masked");
  assert.equal(calls.length, 0);
  assert.equal(auditLines(e)[0].mode, "TESLA_FLEET_DRY_RUN");
});

test("command key missing or invalid: refused before any network call", async () => {
  for (const [extra, code] of [
    [{ TESLA_FLEET_COMMAND_KEY_FILE: "" }, "command_key_not_configured"],
    [{ TESLA_FLEET_COMMAND_KEY_FILE: path.join(tmpDir(), "missing.pem") }, "command_key_unreadable"],
  ] as const) {
    const e = env(extra);
    const { ctx, calls } = setup(e, vehicleRoutes(fake()));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
    assert.equal(b.code, code);
    assert.equal(calls.length, 0);
  }
  const bad = path.join(tmpDir(), "bad.pem");
  const label = ["EC", "PRIVATE", "KEY"].join(" "); // built in pieces so secret scanners do not flag a fake key
  fs.writeFileSync(bad, `-----BEGIN ${label}-----\nnot-a-key\n-----END ${label}-----\n`, { mode: 0o600 });
  const e = env({ TESLA_FLEET_COMMAND_KEY_FILE: bad });
  const { ctx, calls } = setup(e, vehicleRoutes(fake()));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
  assert.equal(b.code, "command_key_invalid");
  assert.ok(!JSON.stringify(b).includes("not-a-key"));
  assert.equal(calls.length, 0);
});

// ---------- send path ----------

test("happy path: online + paired checks, 2 signed_command calls to the Fleet API (not the proxy), audited", async () => {
  const e = env();
  const v = fake();
  const { ctx, calls } = setup(e, vehicleRoutes(v));
  const c = await connect(ctx);
  const b = body(await c.callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
  assert.equal(b.ok, true);
  assert.equal(b.sent, true);
  assert.equal(b.experimental, true);
  assert.equal(b.authenticatedResponse, true);
  const signed = calls.filter((x) => x.url.endsWith("/signed_command"));
  assert.equal(signed.length, 2);
  assert.ok(signed.every((x) => x.url === `${BASE}/api/1/vehicles/${VIN}/signed_command`));
  assert.ok(signed.every((x) => /^Bearer access-EXAMPLE-/.test(x.headers.Authorization)));
  assert.ok(!calls.some((x) => x.url.includes("proxy.example.com")), "the proxy is not used");
  assert.ok(!calls.some((x) => x.url.includes("wake_up")), "never wakes");
  const cmd = v.received.find((x) => x.kind === "command")!;
  assert.equal(cmd.validTag, true);
  assert.equal(cmd.action!.toString("hex"), encodeVideoRequestAction(validateVideoUrl(URL_OK).url).toString("hex"), "full URL reaches the car");
  assert.deepEqual(auditLines(e).map((x) => [x.event, x.outcome ?? null]), [["attempt", null], ["result", "accepted"]]);
  assertAuditHygiene(e);
  if (process.platform !== "win32") assert.equal(fs.statSync(e.TESLA_FLEET_AUDIT_LOG).mode & 0o077, 0, "audit log 0600");
});

test("vehicle rejects / protocol fault: reported, not retried, audited", async () => {
  for (const [o, code, extra] of [
    [{ answer: "error", reason: "not_supported" }, "vehicle_rejected", { reason: "not_supported" }],
    [{ answer: "fault", faultCode: 9 }, "vehicle_protocol_fault", { fault: "invalid_command", executed: false }],
  ] as const) {
    const e = env();
    const v = fake(o as Partial<FakeVehicleOptions>);
    const { ctx, calls } = setup(e, vehicleRoutes(v));
    const c = await connect(ctx);
    const b = body(await c.callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
    assert.equal(b.ok, false);
    assert.equal(b.code, code);
    for (const [k, val] of Object.entries(extra)) assert.equal(b[k], val);
    assert.equal(calls.filter((x) => x.url.endsWith("/signed_command")).length, 2, "no retry");
    assert.equal(auditLines(e).at(-1)!.event, "result");
  }
});

test("asleep vehicle or unpaired key: refused before any signed_command, audited", async () => {
  const asleep = env();
  const s1 = setup(asleep, vehicleRoutes(fake(), {
    [`GET ${BASE}/api/1/vehicles/${VIN}`]: () => ({ status: 200, body: { response: { vin: VIN, state: "asleep" } } }),
  }));
  const b1 = body(await (await connect(s1.ctx)).callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
  assert.equal(b1.code, "vehicle_not_online");
  assert.ok(!s1.calls.some((x) => x.url.endsWith("/signed_command") || x.url.includes("wake_up")));
  assert.equal(auditLines(asleep).at(-1)!.code, "vehicle_not_online");

  const unpaired = env();
  const s2 = setup(unpaired, vehicleRoutes(fake(), {
    [`POST ${BASE}/api/1/vehicles/fleet_status`]: () => ({ status: 200, body: { response: { key_paired_vins: [], unpaired_vins: [VIN] } } }),
  }));
  const b2 = body(await (await connect(s2.ctx)).callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
  assert.equal(b2.code, "virtual_key_missing");
  assert.ok(!s2.calls.some((x) => x.url.endsWith("/signed_command")));
});

test("handshake rejected by the car: not sent (action never transmitted)", async () => {
  const e = env();
  const v = fake({ handshakeFault: 3 });
  const { ctx, calls } = setup(e, vehicleRoutes(v));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
  assert.equal(b.code, "virtual_key_missing");
  assert.equal(b.sent, false);
  assert.equal(calls.filter((x) => x.url.endsWith("/signed_command")).length, 1);
  assert.deepEqual(auditLines(e).map((x) => [x.event, x.stage ?? null]), [["attempt", null], ["failure", "handshake"]]);
});

test("timeout on the command request: state unknown, not retried", async () => {
  const e = env();
  const v = fake();
  const { ctx, calls } = setup(e, vehicleRoutes(v, {
    [`POST ${BASE}/api/1/vehicles/${VIN}/signed_command`]: async (call, n) => {
      if (n === 2) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return { status: 200, body: { response: await v.handle(VIN, JSON.parse(call.body!).routable_message) } };
    },
  }));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
  assert.equal(b.sent, "unknown");
  assert.equal(b.code, "state_unknown");
  assert.equal(calls.filter((x) => x.url.endsWith("/signed_command")).length, 2);
  assert.equal(auditLines(e).at(-1)!.sent, "unknown");
});

test("Fleet API 4xx on the command (e.g. action not allowed): error surfaced, audited as failure", async () => {
  const e = env();
  const v = fake();
  const { ctx } = setup(e, vehicleRoutes(v, {
    [`POST ${BASE}/api/1/vehicles/${VIN}/signed_command`]: async (call, n) => {
      if (n === 2) return { status: 400, body: { error: "invalid_command", error_description: "unsupported" } };
      return { status: 200, body: { response: await v.handle(VIN, JSON.parse(call.body!).routable_message) } };
    },
  }));
  const res = await (await connect(ctx)).callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } });
  assert.equal(isError(res), true);
  const last = auditLines(e).at(-1)!;
  assert.equal(last.event, "failure");
  assert.equal(last.stage, "command");
  assert.equal(last.rejectedBy, "fleet_api");
  assert.equal(last.httpStatus, 400);
});

test("audit log not writable: refused before sending (fail closed)", async () => {
  const dir = tmpDir();
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  const e = env({ TESLA_FLEET_AUDIT_LOG: path.join(blocker, "audit.jsonl") }); // parent is a file
  const { ctx, calls } = setup(e, vehicleRoutes(fake()));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
  assert.equal(b.code, "audit_log_unavailable");
  assert.equal(calls.length, 0, "no billable reads (vehicle, fleet_status) and nothing sent");
});

// ---------- review follow-ups ----------

test("command key readable by group/others (0644): refused with command_key_insecure_permissions", { skip: process.platform === "win32" }, async () => {
  const key = keyFile();
  fs.chmodSync(key, 0o644);
  for (const args of [{ url: URL_OK, ...intent }, { url: URL_OK }]) {
    const e = env({ TESLA_FLEET_COMMAND_KEY_FILE: key });
    const { ctx, calls } = setup(e, vehicleRoutes(fake()));
    const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: args }));
    if ("confirm" in args) {
      assert.equal(b.code, "command_key_insecure_permissions");
      assert.match(String(b.message ?? b.error ?? JSON.stringify(b)), /chmod 600/);
    } else {
      assert.match(String(b.commandKey), /chmod 600/, "preview reports it too");
    }
    assert.equal(calls.length, 0);
  }
});

test("no-confirm dry-run only stats the key file (an unparseable key still previews as present)", async () => {
  const bad = path.join(tmpDir(), "garbage.pem");
  fs.writeFileSync(bad, "garbage", { mode: 0o600 });
  const e = env({ TESLA_FLEET_COMMAND_KEY_FILE: bad });
  const { ctx, calls } = setup(e, vehicleRoutes());
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { url: URL_OK } }));
  assert.equal(b.dryRun, true);
  assert.match(String(b.commandKey), /present/);
  assert.equal(calls.length, 0);
});

test("HTTP 200 with an unexpected body: handshake = not sent; command = state unknown", async () => {
  for (const [badCall, sent, code] of [[1, false, null], [2, "unknown", "state_unknown"]] as const) {
    const e = env();
    const v = fake();
    const { ctx, calls } = setup(e, vehicleRoutes(v, {
      [`POST ${BASE}/api/1/vehicles/${VIN}/signed_command`]: async (call, n) => {
        if (n === badCall) return { status: 200, body: { response: null } };
        return { status: 200, body: { response: await v.handle(VIN, JSON.parse(call.body!).routable_message) } };
      },
    }));
    const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
    assert.equal(b.sent, sent, `bad body on call ${badCall}`);
    if (code) assert.equal(b.code, code);
    assert.equal(calls.filter((x) => x.url.endsWith("/signed_command")).length, badCall, "no retry");
    assert.equal(auditLines(e).at(-1)!.sent, sent);
  }
});

test("unencrypted success reply (old firmware): reported as UNVERIFIED, not 'accepted'", async () => {
  const e = env();
  const { ctx } = setup(e, vehicleRoutes(fake({ answer: "plaintext_ok" })));
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { url: URL_OK, ...intent } }));
  assert.equal(b.authenticatedResponse, false);
  assert.match(String(b.message), /UNVERIFIED/);
  assert.doesNotMatch(String(b.message), /vehicle accepted/);
  assert.equal(auditLines(e).at(-1)!.outcome, "accepted_unverified");
});

test("non-default port: refused unless an allowlist entry names it (allow_unlisted_host does not cover ports)", async () => {
  const u = "https://video.example.com:8443/clips/intro.mp4";
  const e1 = env();
  const s1 = setup(e1, vehicleRoutes(fake()));
  const b1 = body(await (await connect(s1.ctx)).callTool({ name: TOOL, arguments: { url: u, allow_unlisted_host: true, ...intent } }));
  assert.equal(b1.code, "video_port_not_allowed");
  assert.equal(s1.calls.length, 0);
  const e2 = env({ TESLA_FLEET_VIDEO_HOST_ALLOWLIST: "video.example.com:8443" });
  const s2 = setup(e2, vehicleRoutes());
  const b2 = body(await (await connect(s2.ctx)).callTool({ name: TOOL, arguments: { url: u } }));
  assert.equal(b2.dryRun, true);
  assert.equal(b2.hostAllowlisted, true);
  assert.equal((b2.video as { port?: string }).port, "8443");
});

test("audit: keyed path hash with a per-install 0600 salt; pre-existing loose file and dir are tightened", { skip: process.platform === "win32" }, async () => {
  const dir = path.join(tmpDir(), "loose");
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const log = path.join(dir, "audit.jsonl");
  fs.writeFileSync(log, "", { mode: 0o644 });
  fs.chmodSync(log, 0o644);
  const e = env({ TESLA_FLEET_AUDIT_LOG: log });
  const { ctx } = setup(e, vehicleRoutes());
  const b = body(await (await connect(ctx)).callTool({ name: TOOL, arguments: { url: URL_OK } }));
  assert.equal(fs.statSync(log).mode & 0o777, 0o600, "existing log tightened");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "existing dir tightened");
  assert.equal(fs.statSync(`${log}.salt`).mode & 0o777, 0o600, "salt 0600");
  const h = (b.video as { pathHash: string }).pathHash;
  assert.match(h, /^[0-9a-f]{16}$/);
  const unkeyed = crypto.createHash("sha256").update("/clips/intro.mp4?sig=SECRET-QUERY-EXAMPLE").digest("hex").slice(0, 16);
  assert.notEqual(h, unkeyed, "not a plain hash");
  assert.equal(auditLines(e)[0].pathHash ?? (auditLines(e)[0].url as { pathHash?: string } | undefined)?.pathHash, h);
  // Another install (different salt) hashes the same path differently.
  const e2 = env();
  const s2 = setup(e2, vehicleRoutes());
  const b2 = body(await (await connect(s2.ctx)).callTool({ name: TOOL, arguments: { url: URL_OK } }));
  assert.notEqual((b2.video as { pathHash: string }).pathHash, h);
  assertAuditHygiene(e);
});
