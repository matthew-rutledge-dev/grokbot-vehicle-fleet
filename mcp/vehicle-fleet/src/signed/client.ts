/**
 * Generic signed_command helper: one Vehicle Command Protocol session handshake
 * with the infotainment domain, then one HMAC-SHA256-authenticated CarServer
 * Action, both POSTed to Fleet API /api/1/vehicles/{vin}/signed_command
 * (protocol per teslamotors/vehicle-command pkg/protocol/protocol.md, Apache-2.0).
 *
 * For actions stock tesla-http-proxy cannot encode (it has no REST endpoint for
 * them). Runs only where the virtual-key private key lives; the key is passed
 * in as a KeyObject and never logged or returned.
 *
 * Self-contained on purpose (no server imports) so the same design can be
 * reused elsewhere. No automatic retry: a protocol fault is reported, not resent.
 */
import crypto from "node:crypto";
import {
  constantTimeEqual, decryptResponse, hmacPersonalizedTag, publicKeyBytes, requestHash, responseAad,
  sessionInfoTag, sharedKey, SignedCommandError,
} from "./crypto.js";
import {
  decodeCarServerResponse, decodeRoutableMessage, decodeSessionInfo, DOMAIN_INFOTAINMENT, encodeHmacSignedCommand,
  encodeSessionInfoRequest, faultName, FLAG_ENCRYPT_RESPONSE, type ParsedReply,
} from "./messages.js";
import { ProtoDecodeError } from "./protobuf.js";

/** POST {routable_message: base64} and return the base64 `response` RoutableMessage. */
export type SignedTransport = (vin: string, routableMessageB64: string) => Promise<string>;

export type Session = {
  key: Buffer;
  epoch: Buffer;
  counter: number;
  clockTime: number;
  receivedAtMs: number;
};

export type SignedResult =
  | { status: "ok"; authenticatedResponse: boolean; reason?: string }
  | { status: "rejected"; authenticatedResponse: boolean; reason?: string }
  | { status: "fault"; fault: string; faultCode: number };

/** before_send: handshake or local signing failed, the action was never sent. command: the action request was made. */
export type SignedPhase = "before_send" | "command";

/** Error with the phase it happened in. */
export class SignedPhaseError extends Error {
  constructor(readonly phase: SignedPhase, readonly inner: unknown) {
    super(inner instanceof Error ? inner.message : String(inner));
    this.name = "SignedPhaseError";
  }
}

export type SignedClientOptions = {
  now?: () => number;
  random?: (n: number) => Buffer;
  /** Command lifetime in vehicle-clock seconds (default 15; vehicle-command uses 5 over BLE). */
  expiresInSec?: number;
};

const KEY_FAULTS = new Set([3, 4]); // unknown_key_id, inactive_key

export class SignedCommandClient {
  private readonly now: () => number;
  private readonly random: (n: number) => Buffer;
  private readonly expiresInSec: number;
  private readonly publicKey: Buffer;

  constructor(private readonly privateKey: crypto.KeyObject, private readonly transport: SignedTransport, opts: SignedClientOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? ((n) => crypto.randomBytes(n));
    this.expiresInSec = opts.expiresInSec ?? 15;
    this.publicKey = publicKeyBytes(privateKey);
  }

  private async roundTrip(vin: string, msg: Buffer): Promise<ParsedReply> {
    const b64 = await this.transport(vin, msg.toString("base64"));
    if (typeof b64 !== "string" || b64.length === 0) throw new SignedCommandError("bad_response", "signed_command returned no response message");
    try {
      return decodeRoutableMessage(Buffer.from(b64, "base64"));
    } catch (e) {
      if (e instanceof ProtoDecodeError) throw new SignedCommandError("bad_response", `could not decode the vehicle response (${e.message})`);
      throw e;
    }
  }

  /** Session info handshake with the infotainment domain; the reply is HMAC-verified before use. */
  async handshake(vin: string): Promise<Session> {
    const uuid = this.random(16);
    const msg = encodeSessionInfoRequest({ routingAddress: this.random(16), uuid, publicKey: this.publicKey });
    const r = await this.roundTrip(vin, msg);
    if (r.fault) {
      if (KEY_FAULTS.has(r.fault)) throw new SignedCommandError("virtual_key_missing", `The vehicle does not recognise this key (${faultName(r.fault)}).`);
      throw new SignedCommandError("handshake_fault", `Handshake rejected by the vehicle (${faultName(r.fault)}).`);
    }
    if (!r.sessionInfo || !r.sessionInfoTag) throw new SignedCommandError("handshake_incomplete", "Handshake reply had no session info.");
    if (r.requestUuid?.length && !constantTimeEqual(r.requestUuid, uuid)) throw new SignedCommandError("handshake_mismatch", "Handshake reply was for a different request.");
    let info;
    try {
      info = decodeSessionInfo(r.sessionInfo);
    } catch {
      throw new SignedCommandError("bad_response", "could not decode session info");
    }
    if (info.status === 1) throw new SignedCommandError("virtual_key_missing", "The vehicle reports this key is not on its key list.");
    if (info.epoch.length !== 16) throw new SignedCommandError("bad_response", "session info epoch has the wrong length");
    const key = sharedKey(this.privateKey, info.publicKey);
    const expected = sessionInfoTag(key, vin, uuid, r.sessionInfo);
    if (!constantTimeEqual(expected, r.sessionInfoTag)) throw new SignedCommandError("handshake_auth_failed", "Session info failed authentication; discarded.");
    return { key, epoch: info.epoch, counter: info.counter, clockTime: info.clockTime, receivedAtMs: this.now() };
  }

  /** Build the signed RoutableMessage for one CarServer Action (exposed for tests and dry-runs). */
  buildCommand(vin: string, session: Session, action: Buffer): { message: Buffer; uuid: Buffer; tag: Buffer; counter: number; expiresAt: number } {
    if (session.counter >= 0xffffffff) throw new SignedCommandError("counter_rollover", "anti-replay counter exhausted; start a new session");
    const counter = session.counter + 1;
    const elapsed = Math.max(0, Math.floor((this.now() - session.receivedAtMs) / 1000));
    const expiresAt = session.clockTime + elapsed + this.expiresInSec;
    const flags = FLAG_ENCRYPT_RESPONSE;
    const tag = hmacPersonalizedTag(session.key, { domain: DOMAIN_INFOTAINMENT, vin, epoch: session.epoch, expiresAt, counter, flags }, action);
    const uuid = this.random(16);
    const message = encodeHmacSignedCommand({
      routingAddress: this.random(16), uuid, flags, payload: action, signerPublicKey: this.publicKey,
      epoch: session.epoch, counter, expiresAt, tag,
    });
    session.counter = counter;
    return { message, uuid, tag, counter, expiresAt };
  }

  /** Interpret the vehicle's reply to a signed command. */
  readReply(vin: string, r: ParsedReply, sent: { uuid: Buffer; tag: Buffer }, session: Session): SignedResult {
    if (r.requestUuid?.length && !constantTimeEqual(r.requestUuid, sent.uuid)) throw new SignedCommandError("bad_response", "reply was for a different request");
    if (r.fromDomain !== undefined && r.fromDomain !== DOMAIN_INFOTAINMENT) throw new SignedCommandError("bad_response", "reply came from an unexpected domain");
    if (r.fault) return { status: "fault", fault: faultName(r.fault), faultCode: r.fault };
    let plaintext: Buffer;
    let authenticated = false;
    if (r.aesGcmResponse) {
      const aad = responseAad({
        domain: r.fromDomain ?? DOMAIN_INFOTAINMENT, vin, counter: r.aesGcmResponse.counter, flags: r.flags,
        requestHash: requestHash(sent.tag), fault: r.fault,
      });
      plaintext = decryptResponse(session.key, r.aesGcmResponse.nonce, r.payload ?? Buffer.alloc(0), r.aesGcmResponse.tag, aad);
      authenticated = true;
    } else {
      plaintext = r.payload ?? Buffer.alloc(0); // firmware before 2024.38 ignores FLAG_ENCRYPT_RESPONSE
    }
    let status;
    try {
      status = decodeCarServerResponse(plaintext);
    } catch (e) {
      throw new SignedCommandError("bad_response", `could not decode the action status (${e instanceof Error ? e.message : String(e)})`);
    }
    return status.result === "ok"
      ? { status: "ok", authenticatedResponse: authenticated, ...(status.reason ? { reason: status.reason } : {}) }
      : { status: "rejected", authenticatedResponse: authenticated, ...(status.reason ? { reason: status.reason } : {}) };
  }

  /** Handshake + one signed infotainment action. Errors are wrapped with the phase they happened in. */
  async sendInfotainmentAction(vin: string, action: Buffer): Promise<SignedResult & { counter: number }> {
    let session: Session;
    let sent: ReturnType<SignedCommandClient["buildCommand"]>;
    try {
      session = await this.handshake(vin);
      sent = this.buildCommand(vin, session, action);
    } catch (e) {
      throw new SignedPhaseError("before_send", e);
    }
    try {
      const reply = await this.roundTrip(vin, sent.message);
      return { ...this.readReply(vin, reply, sent, session), counter: sent.counter };
    } catch (e) {
      throw new SignedPhaseError("command", e);
    }
  }
}
