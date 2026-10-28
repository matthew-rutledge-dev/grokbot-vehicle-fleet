/**
 * Windows command-key ACL warning (non-fatal): icacls output parsing, the
 * platform gate, error tolerance, and (on Windows CI only) a real icacls run.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseIcaclsBroadAccess, windowsKeyAclWarning } from "../src/tools/keyacl.js";
import { tmpDir } from "./helpers.js";

const FILE = "C:\\keys\\command-key.pem";
const ok = (file: string) => `${file} NT AUTHORITY\\SYSTEM:(F)
                     BUILTIN\\Administrators:(F)
                     EXAMPLE-PC\\example-user:(R)

Successfully processed 1 files; Failed processing 0 files
`;

test("parseIcaclsBroadAccess: private ACL (SYSTEM, Administrators, owner) = no findings", () => {
  assert.deepEqual(parseIcaclsBroadAccess(ok(FILE)), []);
});

test("parseIcaclsBroadAccess: Everyone / Users / Authenticated Users with read, write or full rights are flagged", () => {
  const out = `${FILE} Everyone:(R)
                     BUILTIN\\Users:(I)(RX)
                     NT AUTHORITY\\Authenticated Users:(I)(M)
                     EXAMPLE-PC\\example-user:(F)
Successfully processed 1 files; Failed processing 0 files`;
  assert.deepEqual(parseIcaclsBroadAccess(out), ["Everyone:(R)", "BUILTIN\\Users:(I)(RX)", "NT AUTHORITY\\Authenticated Users:(I)(M)"]);
});

test("parseIcaclsBroadAccess: well-known SIDs, specific rights, CRLF; deny entries and non-read rights ignored", () => {
  const out = [
    `${FILE} *S-1-1-0:(RD,RA)`,
    "      *S-1-5-32-545:(DENY)(R)",
    "      *S-1-5-11:(S)",
    "      BUILTIN\\Users:(OI)(CI)(IO)(GR)",
    "      EXAMPLE-PC\\Everyone-Else:(R)",
    "",
  ].join("\r\n");
  assert.deepEqual(parseIcaclsBroadAccess(out), ["*S-1-1-0:(RD,RA)", "BUILTIN\\Users:(OI)(CI)(IO)(GR)"]);
});

test("parseIcaclsBroadAccess: a path containing a broad name or colons does not confuse it", () => {
  const file = "C:\\Users\\Everyone\\key.pem";
  assert.deepEqual(parseIcaclsBroadAccess(ok(file)), []);
});

test("windowsKeyAclWarning: off on non-Windows, unset file, or icacls failure; warns on broad access (never throws)", () => {
  let calls = 0;
  const run = () => { calls++; return `${FILE} Everyone:(R)\n`; };
  assert.equal(windowsKeyAclWarning(FILE, { platform: "linux", run }), undefined);
  assert.equal(windowsKeyAclWarning(undefined, { platform: "win32", run }), undefined);
  assert.equal(calls, 0, "icacls not run off Windows or without a file");
  assert.equal(windowsKeyAclWarning(FILE, { platform: "win32", run: () => { throw new Error("icacls missing"); } }), undefined);
  assert.equal(windowsKeyAclWarning(FILE, { platform: "win32", run: () => ok(FILE) }), undefined);
  const w = windowsKeyAclWarning(FILE, { platform: "win32", run });
  assert.match(w!, /^Windows: TESLA_FLEET_COMMAND_KEY_FILE is accessible to broad groups \(Everyone:\(R\)\)/);
  assert.match(w!, /Not enforced/);
  assert.ok(!w!.includes(FILE), "path not echoed");
});

test("windowsKeyAclWarning on a real Windows file: private = none; Everyone:R = warning", { skip: process.platform !== "win32" }, () => {
  const p = path.join(tmpDir(), "command-key.pem");
  fs.writeFileSync(p, crypto.randomBytes(16).toString("hex"));
  const me = process.env.USERNAME!;
  execFileSync("icacls", [p, "/inheritance:r", "/grant:r", `${me}:F`], { stdio: "ignore" });
  assert.equal(windowsKeyAclWarning(p), undefined);
  execFileSync("icacls", [p, "/grant", "*S-1-1-0:R"], { stdio: "ignore" });
  assert.match(windowsKeyAclWarning(p) ?? "", /broad groups \(Everyone:\(R\)\)/);
});
