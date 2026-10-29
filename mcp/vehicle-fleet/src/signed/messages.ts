/**
 * Vehicle Command Protocol message builders / parsers (field numbers from
 * teslamotors/vehicle-command, Apache-2.0; see protobuf.ts for the two
 * community-documented VehicleAction fields).
 */
import { decodeFields, getBytes, getMessage, getUint, ProtoDecodeError, ProtoWriter, type ProtoField } from "./protobuf.js";

export const DOMAIN_INFOTAINMENT = 3;
export const FLAG_ENCRYPT_RESPONSE = 1 << 1;

export const SIGNATURE_TYPE_HMAC = 6;
export const SIGNATURE_TYPE_HMAC_PERSONALIZED = 8;
export const SIGNATURE_TYPE_AES_GCM_RESPONSE = 9;

/** Signatures.Tag */
export const TAG = {
  SIGNATURE_TYPE: 0, DOMAIN: 1, PERSONALIZATION: 2, EPOCH: 3, EXPIRES_AT: 4,
  COUNTER: 5, CHALLENGE: 6, FLAGS: 7, REQUEST_HASH: 8, FAULT: 9, END: 255,
} as const;

/** CarServer VehicleAction oneof members used here (community-documented, not in the official protos). */
export const VEHICLE_ACTION = { DASHCAM_SAVE_CLIP: 47, VIDEO_REQUEST: 57, BOOMBOX: 64 } as const;

/** UniversalMessage.MessageFault_E names (subset kept short; unknown numbers are shown as fault_<n>). */
export const MESSAGE_FAULTS: Record<number, string> = {
  1: "busy", 2: "timeout", 3: "unknown_key_id", 4: "inactive_key", 5: "invalid_signature",
  6: "invalid_token_or_counter", 7: "insufficient_privileges", 8: "invalid_domains", 9: "invalid_command",
  10: "decoding", 11: "internal", 12: "wrong_personalization", 13: "bad_parameter", 14: "keychain_is_full",
  15: "incorrect_epoch", 16: "iv_incorrect_length", 17: "time_expired", 18: "not_provisioned_with_identity",
  19: "could_not_hash_metadata", 20: "time_to_live_too_long", 21: "remote_access_disabled",
  22: "remote_service_access_disabled", 23: "command_requires_account_credentials", 24: "request_mtu_exceeded",
  25: "response_mtu_exceeded", 26: "repeated_counter", 27: "invalid_key_handle", 28: "requires_response_encryption",
};

export function faultName(n: number): string {
  return MESSAGE_FAULTS[n] ?? `fault_${n}`;
}

/** CarServer.Action { vehicleAction { <oneof field> { ...inner } } } */
export function encodeVehicleAction(oneofField: number, inner: ProtoWriter): Buffer {
  const vehicleAction = new ProtoWriter().message(oneofField, inner);
  return new ProtoWriter().message(2, vehicleAction).finish();
}

/** Action for VehicleAction.videoRequestAction (57): VideoRequestAction { string url = 1 }. */
export function encodeVideoRequestAction(url: string): Buffer {
  return encodeVehicleAction(VEHICLE_ACTION.VIDEO_REQUEST, new ProtoWriter().string(1, url));
}

/**
 * Action for VehicleAction.boomboxAction (64): BoomboxAction { uint32 sound = 1 }. Field numbers from
 * Teslemetry/tesla-protocol (Apache-2.0, marked TESLEMETRY-EXT there; not in Tesla's published protos).
 * Sound ids per Tesla's Fleet API docs (remote_boombox): 0 = random fart, 2000 = locate ping.
 * Proto3 omits a zero scalar, so sound 0 encodes as an empty BoomboxAction (same bytes as Go's marshal).
 */
export function encodeBoomboxAction(sound: number): Buffer {
  const inner = new ProtoWriter();
  if (sound !== 0) inner.uint32(1, sound);
  return encodeVehicleAction(VEHICLE_ACTION.BOOMBOX, inner);
}

/** Action for VehicleAction.dashcamSaveClipAction (47): empty message. */
export function encodeDashcamSaveClipAction(): Buffer {
  return encodeVehicleAction(VEHICLE_ACTION.DASHCAM_SAVE_CLIP, new ProtoWriter());
}

function destinationDomain(domain: number): ProtoWriter {
  return new ProtoWriter().uint32(1, domain);
}

function destinationAddress(addr: Uint8Array): ProtoWriter {
  return new ProtoWriter().bytes(2, addr, true);
}

/**
 * Field order matches Go's deterministic marshal of RoutableMessage (non-oneof
 * fields first, then the payload and signature oneofs) so test vectors compare
 * byte for byte. Any order is valid protobuf.
 */
export function encodeSessionInfoRequest(o: { routingAddress: Uint8Array; uuid: Uint8Array; publicKey: Uint8Array; domain?: number }): Buffer {
  return new ProtoWriter()
    .message(6, destinationDomain(o.domain ?? DOMAIN_INFOTAINMENT))
    .message(7, destinationAddress(o.routingAddress))
    .bytes(51, o.uuid)
    .message(14, new ProtoWriter().bytes(1, o.publicKey))
    .finish();
}

export type HmacSignedCommand = {
  routingAddress: Uint8Array;
  uuid: Uint8Array;
  flags: number;
  payload: Uint8Array;
  signerPublicKey: Uint8Array;
  epoch: Uint8Array;
  counter: number;
  expiresAt: number;
  tag: Uint8Array;
  domain?: number;
};

export function encodeHmacSignedCommand(m: HmacSignedCommand): Buffer {
  const hmacData = new ProtoWriter().bytes(1, m.epoch).uint32(2, m.counter).fixed32(3, m.expiresAt).bytes(4, m.tag);
  const sig = new ProtoWriter()
    .message(1, new ProtoWriter().bytes(1, m.signerPublicKey, true))
    .message(8, hmacData);
  return new ProtoWriter()
    .message(6, destinationDomain(m.domain ?? DOMAIN_INFOTAINMENT))
    .message(7, destinationAddress(m.routingAddress))
    .bytes(51, m.uuid)
    .uint32(52, m.flags)
    .bytes(10, m.payload, true)
    .message(13, sig)
    .finish();
}

export type SessionInfo = { counter: number; publicKey: Buffer; epoch: Buffer; clockTime: number; status: number };

export function decodeSessionInfo(b: Uint8Array): SessionInfo {
  const f = decodeFields(b);
  return {
    counter: getUint(f, 1),
    publicKey: getBytes(f, 2) ?? Buffer.alloc(0),
    epoch: getBytes(f, 3) ?? Buffer.alloc(0),
    clockTime: getUint(f, 4),
    status: getUint(f, 5),
  };
}

export type ParsedReply = {
  fromDomain?: number;
  toRoutingAddress?: Buffer;
  payload?: Buffer;
  sessionInfo?: Buffer;
  sessionInfoTag?: Buffer;
  aesGcmResponse?: { nonce: Buffer; counter: number; tag: Buffer };
  operationStatus: number;
  fault: number;
  requestUuid?: Buffer;
  flags: number;
};

function domainOf(f: ProtoField[] | undefined): number | undefined {
  if (!f) return undefined;
  return f.some((x) => x.field === 1) ? getUint(f, 1) : undefined;
}

export function decodeRoutableMessage(b: Uint8Array): ParsedReply {
  const f = decodeFields(b);
  const sig = getMessage(f, 13);
  const status = getMessage(f, 12);
  const gcm = sig ? getMessage(sig, 9) : undefined;
  const infoTag = sig ? getMessage(sig, 6) : undefined;
  const to = getMessage(f, 6);
  return {
    fromDomain: domainOf(getMessage(f, 7)),
    toRoutingAddress: to ? getBytes(to, 2) : undefined,
    payload: getBytes(f, 10),
    sessionInfo: getBytes(f, 15),
    sessionInfoTag: infoTag ? getBytes(infoTag, 1) : undefined,
    aesGcmResponse: gcm
      ? { nonce: getBytes(gcm, 1) ?? Buffer.alloc(0), counter: getUint(gcm, 2), tag: getBytes(gcm, 3) ?? Buffer.alloc(0) }
      : undefined,
    operationStatus: status ? getUint(status, 1) : 0,
    fault: status ? getUint(status, 2) : 0,
    requestUuid: getBytes(f, 50),
    flags: getUint(f, 52),
  };
}

/** CarServer.Response -> actionStatus { result (0 OK, 1 ERROR), result_reason.plain_text }. */
export function decodeCarServerResponse(b: Uint8Array): { result: "ok" | "error"; reason?: string } {
  const f = decodeFields(b);
  const status = getMessage(f, 1);
  if (!status) return { result: "ok" };
  const r = getUint(status, 1);
  const reasonMsg = getMessage(status, 2);
  const text = reasonMsg ? getBytes(reasonMsg, 1)?.toString("utf8") : undefined;
  if (r !== 0 && r !== 1) throw new ProtoDecodeError(`unknown action status ${r}`);
  return { result: r === 0 ? "ok" : "error", ...(text ? { reason: text.slice(0, 200) } : {}) };
}
