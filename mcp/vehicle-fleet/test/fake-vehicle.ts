/**
 * In-process fake vehicle for the signed_command helper: answers session info
 * requests and HMAC-signed infotainment commands the way the protocol spec
 * describes (teslamotors/vehicle-command pkg/protocol/protocol.md). Test-only;
 * it never touches a network. Keys are generated per test run.
 */
import crypto from "node:crypto";
import {
  hmacPersonalizedTag, publicKeyBytes, requestHash, responseAad, sessionInfoTag, sharedKey,
} from "../src/signed/crypto.js";
import { DOMAIN_INFOTAINMENT } from "../src/signed/messages.js";
import { decodeFields, getBytes, getMessage, getUint, ProtoWriter } from "../src/signed/protobuf.js";

export type FakeVehicleOptions = {
  vin: string;
  counter?: number;
  clockTime?: number;
  /** What the car answers to a valid command. */
  answer?: "ok" | "error" | "fault" | "plaintext_ok" | "bad_tag" | "wrong_uuid" | "empty";
  faultCode?: number;
  reason?: string;
  sessionStatus?: number;
  handshakeFault?: number;
  tamperSessionTag?: boolean;
};

export type Received = { kind: "session" | "command"; action?: Buffer; counter?: number; expiresAt?: number; flags?: number; validTag?: boolean };

export class FakeVehicle {
  readonly key = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  readonly epoch = crypto.randomBytes(16);
  readonly received: Received[] = [];
  private k?: Buffer;
  private counter: number;
  private readonly clockTime: number;

  constructor(readonly o: FakeVehicleOptions) {
    this.counter = o.counter ?? 6;
    this.clockTime = o.clockTime ?? 2650;
  }

  private reply(fields: (w: ProtoWriter) => ProtoWriter, routing: Buffer, uuid: Buffer | undefined): string {
    const w = new ProtoWriter()
      .message(6, new ProtoWriter().bytes(2, routing, true))
      .message(7, new ProtoWriter().uint32(1, DOMAIN_INFOTAINMENT));
    if (uuid) w.bytes(50, uuid);
    return fields(w).finish().toString("base64");
  }

  /** The transport function the client calls. */
  handle = async (vin: string, b64: string): Promise<string> => {
    const f = decodeFields(Buffer.from(b64, "base64"));
    const routing = getBytes(getMessage(f, 7)!, 2)!;
    const uuid = getBytes(f, 51)!;
    const sir = getMessage(f, 14);
    if (sir) {
      this.received.push({ kind: "session" });
      if (this.o.handshakeFault) {
        return this.reply((w) => w.message(12, new ProtoWriter().uint32(1, 2).uint32(2, this.o.handshakeFault!)), routing, uuid);
      }
      const clientPub = getBytes(sir, 1)!;
      this.k = sharedKey(this.key, clientPub);
      const info = new ProtoWriter().uint32(1, this.counter).bytes(2, publicKeyBytes(this.key)).bytes(3, this.epoch)
        .fixed32(4, this.clockTime).uint32(5, this.o.sessionStatus ?? 0).finish();
      const tag = sessionInfoTag(this.k, vin, uuid, info);
      if (this.o.tamperSessionTag) tag[0] ^= 0xff;
      return this.reply((w) => w.bytes(15, info, true).message(13, new ProtoWriter().message(6, new ProtoWriter().bytes(1, tag))), routing, uuid);
    }
    const payload = getBytes(f, 10)!;
    const sig = getMessage(f, 13)!;
    const h = getMessage(sig, 8)!;
    const counter = getUint(h, 2);
    const expiresAt = getUint(h, 3);
    const flags = getUint(f, 52);
    const tag = getBytes(h, 4)!;
    const expected = hmacPersonalizedTag(this.k!, { domain: DOMAIN_INFOTAINMENT, vin, epoch: getBytes(h, 1)!, expiresAt, counter, flags }, payload);
    const validTag = crypto.timingSafeEqual(expected, tag) && counter > this.counter && getBytes(h, 1)!.equals(this.epoch);
    this.received.push({ kind: "command", action: payload, counter, expiresAt, flags, validTag });
    if (!validTag) return this.reply((w) => w.message(12, new ProtoWriter().uint32(1, 2).uint32(2, 5)), routing, uuid);
    this.counter = counter;
    const a = this.o.answer ?? "ok";
    if (a === "fault") return this.reply((w) => w.message(12, new ProtoWriter().uint32(1, 2).uint32(2, this.o.faultCode ?? 9)), routing, uuid);
    if (a === "wrong_uuid") return this.reply((w) => w, routing, crypto.randomBytes(16));
    const status = a === "error"
      ? new ProtoWriter().uint32(1, 1).message(2, new ProtoWriter().string(1, this.o.reason ?? "not_supported"))
      : new ProtoWriter();
    const plain = a === "empty" ? Buffer.alloc(0) : new ProtoWriter().message(1, status).finish();
    if (a === "plaintext_ok") return this.reply((w) => w.bytes(10, plain, true), routing, uuid);
    const respCounter = 1;
    const aad = responseAad({ domain: DOMAIN_INFOTAINMENT, vin, counter: respCounter, flags: 0, requestHash: requestHash(tag), fault: 0 });
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-128-gcm", this.k!, nonce);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const gtag = c.getAuthTag();
    if (a === "bad_tag") gtag[0] ^= 0xff;
    return this.reply((w) => w.bytes(10, ct, true).message(13, new ProtoWriter().message(9,
      new ProtoWriter().bytes(1, nonce).uint32(2, respCounter).bytes(3, gtag))), routing, uuid);
  };

}
