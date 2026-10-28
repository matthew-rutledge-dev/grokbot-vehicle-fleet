/**
 * signed_command helper: protocol vectors and an end-to-end run against an
 * in-process fake vehicle. No network.
 *
 * Vectors:
 * - "protocol.md": the worked examples in teslamotors/vehicle-command
 *   pkg/protocol/protocol.md (Apache-2.0), using Tesla's PUBLISHED test keys
 *   (scalars below). Those keys are public debug values: never enrol them on a car.
 * - "go": produced by running vehicle-command's own Go implementation
 *   (internal/authentication: hmacTag, RequestID, Verifier.Encrypt, proto.Marshal)
 *   at commit d6239bf with the same test keys and a placeholder VIN, so this
 *   TypeScript encoder/signer is checked byte for byte against the reference.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { SignedCommandClient, SignedPhaseError } from "../src/signed/client.js";
import {
  commandMetadata, decryptResponse, hmacPersonalizedTag, loadPrivateKeyPem, Metadata, privateKeyFromScalar, publicKeyBytes,
  requestHash, responseAad, sessionInfoTag, sharedKey, SignedCommandError, subkey,
} from "../src/signed/crypto.js";
import {
  decodeCarServerResponse, decodeRoutableMessage, encodeDashcamSaveClipAction, encodeHmacSignedCommand, encodeSessionInfoRequest,
  encodeVideoRequestAction,
} from "../src/signed/messages.js";
import { decodeFields, encodeVarint, ProtoDecodeError } from "../src/signed/protobuf.js";
import { FakeVehicle } from "./fake-vehicle.js";

const hx = (s: string) => Buffer.from(s, "hex");

// Tesla's published protocol.md test keys (public; debug only).
const CLIENT_D = "2538CDC29A97C19C1E99A637D6CF4F8C970C118B56EDE1E6323E6D162C4B30DB";
const CLIENT_PUB = "04b2b6bc68c2da0665ce656815594996c62394edd8bea905fe781a754fe6a845a714330902f225e9269d466e05b349981fda9d85cc23c6fb444aa73b629105dc6e";
const VEHICLE_D = "344EE5B466A7CF1EEB12B6F50331DB2E5EC5834EF5F4BEFCFD8CBE55C2528D70";
const VEHICLE_PUB = "04c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d97";
const DOC_VIN = "5YJ30123456789ABC"; // protocol.md example VIN (not a real vehicle)
const VIN = "5YJ0000000EXAMPLE"; // placeholder, 17 characters
const EPOCH = "4c463f9cc0d3d26906e982ed224adde6";
const ROUTING = "2c907bd76c640d360b3027dc7404efde";
const SESSION_UUID = "1588d5a30eabc6f8fc9a951b11f6fd11";
const CMD_UUID = "58406580528b6a5301391800b4fe9b99";
const SESSION_INFO = "0806124104c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d971a104c463f9cc0d3d26906e982ed224adde6255a0a0000";
const K = "1b2fce19967b79db696f909cff89ea9a";
const VIDEO_URL = "https://video.example.com/clip.mp4";

const client = () => privateKeyFromScalar(hx(CLIENT_D));

test("protocol.md: public key encoding and K = SHA1(ECDH x)[:16]", () => {
  assert.equal(publicKeyBytes(client()).toString("hex"), CLIENT_PUB);
  assert.equal(publicKeyBytes(privateKeyFromScalar(hx(VEHICLE_D))).toString("hex"), VEHICLE_PUB);
  assert.equal(sharedKey(client(), hx(VEHICLE_PUB)).toString("hex"), K);
  assert.equal(sharedKey(privateKeyFromScalar(hx(VEHICLE_D)), hx(CLIENT_PUB)).toString("hex"), K, "symmetric");
});

test("protocol.md: SESSION_INFO_KEY and session info tag", () => {
  assert.equal(subkey(hx(K), "session info").toString("hex"), "fceb679ee7bca756fcd441bf238bf2f338629b41d9eb9c67be1b32c9672ce300");
  assert.equal(sessionInfoTag(hx(K), DOC_VIN, hx(SESSION_UUID), hx(SESSION_INFO)).toString("hex"),
    "996c1fe38331be138f8039c194b14db2198846ed7d8251e6749284d7b32ea002");
});

test("protocol.md: metadata serialization examples", () => {
  assert.equal(new Metadata().add(2, Buffer.from("abc")).addUint32(5, 100).serialize().toString("hex"), "0203616263050400000064ff");
  // Same field set as the AES-GCM example, but signature type HMAC_PERSONALIZED (8) instead of AES_GCM_PERSONALIZED (5).
  const m = commandMetadata({ domain: 3, vin: DOC_VIN, epoch: hx(EPOCH), expiresAt: 2655, counter: 7, flags: 2 });
  assert.equal(m.toString("hex"), "000108010103021135594a333031323334353637383941424303104c463f9cc0d3d26906e982ed224adde6040400000a5f050400000007070400000002ff");
  assert.throws(() => new Metadata().add(5, Buffer.alloc(1)).add(2, Buffer.alloc(1)), SignedCommandError);
  assert.throws(() => new Metadata().add(1, Buffer.alloc(256)), SignedCommandError);
  const noFlags = commandMetadata({ domain: 3, vin: DOC_VIN, epoch: hx(EPOCH), expiresAt: 2655, counter: 7, flags: 0 });
  assert.ok(!noFlags.toString("hex").includes("070400000000"), "flags omitted when zero");
});

test("protocol.md: AES-GCM example (AAD = SHA256(metadata)) round-trips through decryptResponse", () => {
  const aad = crypto.createHash("sha256").update(hx("000105010103021135594a333031323334353637383941424303104c463f9cc0d3d26906e982ed224adde6040400000a5f050400000007070400000002ff")).digest();
  const pt = decryptResponse(hx(K), hx("dbf79447fa156674dae1caed"), hx("38038e8c0f2e"), hx("c228e0ff64991481db3a7bbc133696c5"), aad);
  assert.equal(pt.toString("hex"), "120452020801");
  assert.throws(() => decryptResponse(hx(K), hx("dbf79447fa156674dae1caed"), hx("38038e8c0f2f"), hx("c228e0ff64991481db3a7bbc133696c5"), aad),
    (e: unknown) => e instanceof SignedCommandError && e.code === "response_auth_failed");
});

test("go: VideoRequestAction payload (VehicleAction field 57, url field 1)", () => {
  assert.equal(encodeVideoRequestAction(VIDEO_URL).toString("hex"),
    "1227ca03240a2268747470733a2f2f766964656f2e6578616d706c652e636f6d2f636c69702e6d7034");
  assert.equal(encodeDashcamSaveClipAction().toString("hex"), "1203fa0200", "VehicleAction field 47, empty message");
});

const GO_HMAC_TAG = "8b5512c24eb419a95bf247ec635f5a7ee28fc35f37be134920aa37ca0d8f9a16";

test("go: HMAC-personalized tag, request hash and full RoutableMessage bytes", () => {
  const payload = encodeVideoRequestAction(VIDEO_URL);
  const meta = { domain: 3, vin: VIN, epoch: hx(EPOCH), expiresAt: 2655, counter: 7, flags: 2 };
  const tag = hmacPersonalizedTag(hx(K), meta, payload);
  assert.equal(tag.toString("hex"), GO_HMAC_TAG);
  assert.equal(requestHash(tag).toString("hex"), `08${GO_HMAC_TAG}`);
  const msg = encodeHmacSignedCommand({
    routingAddress: hx(ROUTING), uuid: hx(CMD_UUID), flags: 2, payload, signerPublicKey: hx(CLIENT_PUB),
    epoch: hx(EPOCH), counter: 7, expiresAt: 2655, tag,
  });
  assert.equal(msg.toString("hex"),
    "320208033a1212102c907bd76c640d360b3027dc7404efde9a031058406580528b6a5301391800b4fe9b99a0030252291227ca03240a2268747470733a2f2f766964656f2e6578616d706c652e636f6d2f636c69702e6d70346a82010a430a4104b2b6bc68c2da0665ce656815594996c62394edd8bea905fe781a754fe6a845a714330902f225e9269d466e05b349981fda9d85cc23c6fb444aa73b629105dc6e423b0a104c463f9cc0d3d26906e982ed224adde610071d5f0a000022208b5512c24eb419a95bf247ec635f5a7ee28fc35f37be134920aa37ca0d8f9a16");
});

test("go: session info request bytes and session tag for the placeholder VIN", () => {
  assert.equal(encodeSessionInfoRequest({ routingAddress: hx(ROUTING), uuid: hx(SESSION_UUID), publicKey: hx(CLIENT_PUB) }).toString("hex"),
    "320208033a1212102c907bd76c640d360b3027dc7404efde9a03101588d5a30eabc6f8fc9a951b11f6fd1172430a4104b2b6bc68c2da0665ce656815594996c62394edd8bea905fe781a754fe6a845a714330902f225e9269d466e05b349981fda9d85cc23c6fb444aa73b629105dc6e");
  assert.equal(sessionInfoTag(hx(K), VIN, hx(SESSION_UUID), hx(SESSION_INFO)).toString("hex"),
    "25af8d77964b9a9498cd0d8c940de756196941f730060fcf6f9da44a8ad0a4d4");
});

test("go: vehicle-encrypted responses (Verifier.Encrypt) decrypt and decode", () => {
  const cases: Array<[string, { result: string; reason?: string }]> = [
    ["321212102c907bd76c640d360b3027dc7404efde3a02080392031058406580528b6a5301391800b4fe9b995202cb6a6a244a220a0ccb97a84d210e931eaea49d0c10081a10a637ea229537d9e2546c2baaab290292", { result: "ok" }],
    ["321212102c907bd76c640d360b3027dc7404efde3a02080392031058406580528b6a5301391800b4fe9b99520e0e92ff14b0135ce6b6a0e5dcba256a244a220a0c8cbd8822a945925197b805d910091a100d8faad1e364de640f0d908c79183ebb", { result: "error", reason: "faulty" }],
  ];
  for (const [hex, want] of cases) {
    const r = decodeRoutableMessage(hx(hex));
    assert.equal(r.fromDomain, 3);
    assert.equal(r.requestUuid?.toString("hex"), CMD_UUID);
    assert.ok(r.aesGcmResponse);
    const aad = responseAad({ domain: 3, vin: VIN, counter: r.aesGcmResponse.counter, flags: r.flags, requestHash: hx(`08${GO_HMAC_TAG}`), fault: r.fault });
    const pt = decryptResponse(hx(K), r.aesGcmResponse.nonce, r.payload!, r.aesGcmResponse.tag, aad);
    assert.deepEqual(decodeCarServerResponse(pt), want);
    // Wrong request hash (e.g. a reply to some other command) must not authenticate.
    const bad = responseAad({ domain: 3, vin: VIN, counter: r.aesGcmResponse.counter, flags: r.flags, requestHash: hx(`08${"00".repeat(32)}`), fault: r.fault });
    assert.throws(() => decryptResponse(hx(K), r.aesGcmResponse!.nonce, r.payload!, r.aesGcmResponse!.tag, bad), SignedCommandError);
  }
});

test("protobuf reader rejects truncated / malformed input", () => {
  assert.throws(() => decodeFields(hx("0a05abcd")), ProtoDecodeError);
  assert.throws(() => decodeFields(hx("08")), ProtoDecodeError);
  assert.throws(() => decodeFields(hx("0b")), ProtoDecodeError, "group wire type");
  assert.throws(() => decodeFields(hx("00")), ProtoDecodeError, "field 0");
  assert.equal(encodeVarint(300).toString("hex"), "ac02");
  assert.throws(() => decodeCarServerResponse(hx("0a020805")), ProtoDecodeError, "unknown action status");
});

test("loadPrivateKeyPem: P-256 PEM accepted (SEC1 and PKCS#8); other keys refused without echoing", () => {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sec1 = privateKey.export({ format: "pem", type: "sec1" }) as string;
  const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  assert.deepEqual(publicKeyBytes(loadPrivateKeyPem(sec1)), publicKeyBytes(loadPrivateKeyPem(pkcs8)));
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  assert.throws(() => loadPrivateKeyPem(other), (e: unknown) => e instanceof SignedCommandError && e.code === "command_key_invalid" && !e.message.includes("BEGIN"));
  assert.throws(() => loadPrivateKeyPem("not a key"), (e: unknown) => e instanceof SignedCommandError && e.code === "command_key_invalid");
});

function mkClient(v: FakeVehicle, now = () => 1_000_000) {
  const key = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  return new SignedCommandClient(key, v.handle, { now });
}

test("client end to end (fake vehicle): handshake verified, counter+1, expiry from vehicle clock, encrypted ack", async () => {
  const v = new FakeVehicle({ vin: VIN, counter: 41, clockTime: 5000 });
  let t = 1_000_000;
  const c = mkClient(v, () => t);
  const s = await c.handshake(VIN);
  assert.equal(s.counter, 41);
  t += 3_000;
  const r = await new SignedCommandClient((c as unknown as { privateKey: crypto.KeyObject }).privateKey, v.handle, { now: () => t })
    .sendInfotainmentAction(VIN, encodeVideoRequestAction(VIDEO_URL));
  assert.equal(r.status, "ok");
  assert.equal((r as { authenticatedResponse: boolean }).authenticatedResponse, true);
  const cmd = v.received.find((x) => x.kind === "command")!;
  assert.equal(cmd.validTag, true);
  assert.equal(cmd.counter, 42);
  assert.equal(cmd.flags, 2, "FLAG_ENCRYPT_RESPONSE");
  assert.equal(cmd.expiresAt, 5000 + 15, "fresh handshake: vehicle clock + 15 s");
  assert.equal(cmd.action!.toString("hex"), encodeVideoRequestAction(VIDEO_URL).toString("hex"));
});

test("client: expiry tracks elapsed local time since the handshake", async () => {
  const v = new FakeVehicle({ vin: VIN, clockTime: 100 });
  let t = 50_000;
  const c = mkClient(v, () => t);
  const s = await c.handshake(VIN);
  t += 7_900;
  const built = c.buildCommand(VIN, s, encodeVideoRequestAction(VIDEO_URL));
  assert.equal(built.expiresAt, 100 + 7 + 15);
  assert.equal(s.counter, built.counter, "session counter advanced");
});

test("client: rejected action, plaintext ack (old firmware), protocol fault", async () => {
  const rej = await mkClient(new FakeVehicle({ vin: VIN, answer: "error", reason: "not_supported" })).sendInfotainmentAction(VIN, encodeVideoRequestAction(VIDEO_URL));
  assert.deepEqual({ ...rej, counter: 0 }, { status: "rejected", authenticatedResponse: true, reason: "not_supported", counter: 0 });
  const plain = await mkClient(new FakeVehicle({ vin: VIN, answer: "plaintext_ok" })).sendInfotainmentAction(VIN, encodeVideoRequestAction(VIDEO_URL));
  assert.equal(plain.status, "ok");
  assert.equal((plain as { authenticatedResponse: boolean }).authenticatedResponse, false);
  const fault = await mkClient(new FakeVehicle({ vin: VIN, answer: "fault", faultCode: 9 })).sendInfotainmentAction(VIN, encodeVideoRequestAction(VIDEO_URL));
  assert.equal(fault.status, "fault");
  assert.equal((fault as { fault: string }).fault, "invalid_command");
});

async function phaseErr(p: Promise<unknown>): Promise<{ phase: string; code?: string }> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof SignedPhaseError);
    return { phase: e.phase, code: (e.inner as { code?: string }).code };
  }
  assert.fail("expected an error");
}

test("client: handshake failures are before_send (action never sent)", async () => {
  for (const [opts, code] of [
    [{ tamperSessionTag: true }, "handshake_auth_failed"],
    [{ handshakeFault: 3 }, "virtual_key_missing"],
    [{ sessionStatus: 1 }, "virtual_key_missing"],
    [{ handshakeFault: 1 }, "handshake_fault"],
  ] as const) {
    const v = new FakeVehicle({ vin: VIN, ...opts });
    assert.deepEqual(await phaseErr(mkClient(v).sendInfotainmentAction(VIN, encodeVideoRequestAction(VIDEO_URL))), { phase: "before_send", code });
    assert.ok(!v.received.some((x) => x.kind === "command"), "no command after a failed handshake");
  }
});

test("client: tampered encrypted ack or reply to another request is not trusted", async () => {
  assert.deepEqual(await phaseErr(mkClient(new FakeVehicle({ vin: VIN, answer: "bad_tag" })).sendInfotainmentAction(VIN, encodeVideoRequestAction(VIDEO_URL))),
    { phase: "command", code: "response_auth_failed" });
  assert.deepEqual(await phaseErr(mkClient(new FakeVehicle({ vin: VIN, answer: "wrong_uuid" })).sendInfotainmentAction(VIN, encodeVideoRequestAction(VIDEO_URL))),
    { phase: "command", code: "bad_response" });
});

test("client: session bound to the VIN (a different VIN fails the handshake tag)", async () => {
  const v = new FakeVehicle({ vin: VIN });
  const c = mkClient(v);
  const wrong = (vin: string, b64: string) => v.handle(vin === VIN ? "5YJ0000000EXAMPLF" : vin, b64);
  const c2 = new SignedCommandClient((c as unknown as { privateKey: crypto.KeyObject }).privateKey, wrong);
  assert.deepEqual(await phaseErr(c2.sendInfotainmentAction(VIN, encodeVideoRequestAction(VIDEO_URL))), { phase: "before_send", code: "handshake_auth_failed" });
});

test("client: garbage transport response is a decode error, not a crash", async () => {
  const key = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const c = new SignedCommandClient(key, async () => Buffer.from("0a05ab", "hex").toString("base64"));
  assert.deepEqual(await phaseErr(c.sendInfotainmentAction(VIN, encodeVideoRequestAction(VIDEO_URL))), { phase: "before_send", code: "bad_response" });
});
