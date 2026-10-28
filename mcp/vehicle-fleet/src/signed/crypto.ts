/**
 * Vehicle Command Protocol cryptography (session key agreement, metadata
 * serialization, HMAC-SHA256 command authentication, AES-GCM response
 * decryption), following teslamotors/vehicle-command pkg/protocol/protocol.md
 * and internal/authentication (Apache-2.0). Uses node:crypto only.
 */
import crypto from "node:crypto";
import { SIGNATURE_TYPE_AES_GCM_RESPONSE, SIGNATURE_TYPE_HMAC, SIGNATURE_TYPE_HMAC_PERSONALIZED, TAG } from "./messages.js";

export const LABEL_SESSION_INFO = "session info";
export const LABEL_MESSAGE_AUTH = "authenticated command";

export class SignedCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SignedCommandError";
  }
}

/** TLV metadata builder: tags strictly ascending, values <= 255 bytes, 0xFF terminator. */
export class Metadata {
  private parts: Buffer[] = [];
  private last = -1;

  add(tag: number, value: Uint8Array): this {
    if (tag <= this.last) throw new SignedCommandError("metadata_order", "metadata tags must be added in increasing order");
    if (value.length > 255) throw new SignedCommandError("metadata_too_long", "metadata value longer than 255 bytes");
    this.last = tag;
    this.parts.push(Buffer.from([tag, value.length]), Buffer.from(value));
    return this;
  }

  addUint32(tag: number, v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    return this.add(tag, b);
  }

  /** Serialized metadata including the trailing 0xFF. */
  serialize(): Buffer {
    return Buffer.concat([...this.parts, Buffer.from([TAG.END])]);
  }
}

/** Load a P-256 private key (SEC1 "EC PRIVATE KEY" or PKCS#8 PEM). Throws without echoing key material. */
export function loadPrivateKeyPem(pem: string): crypto.KeyObject {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new SignedCommandError("command_key_invalid", "The command key file is not a readable PEM private key.");
  }
  const d = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== "ec" || d?.namedCurve !== "prime256v1") {
    throw new SignedCommandError("command_key_invalid", "The command key must be a NIST P-256 (prime256v1) EC private key.");
  }
  return key;
}

/** ENCODE_PUBLIC(C): 0x04 || X || Y (65 bytes). */
export function publicKeyBytes(privateKey: crypto.KeyObject): Buffer {
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  const x = Buffer.from(jwk.x as string, "base64url");
  const y = Buffer.from(jwk.y as string, "base64url");
  if (x.length !== 32 || y.length !== 32) throw new SignedCommandError("command_key_invalid", "unexpected public key size");
  return Buffer.concat([Buffer.from([4]), x, y]);
}

function publicKeyFromBytes(b: Uint8Array): crypto.KeyObject {
  if (b.length !== 65 || b[0] !== 4) throw new SignedCommandError("bad_vehicle_key", "vehicle public key is not an uncompressed P-256 point");
  try {
    return crypto.createPublicKey({
      key: { kty: "EC", crv: "P-256", x: Buffer.from(b.subarray(1, 33)).toString("base64url"), y: Buffer.from(b.subarray(33)).toString("base64url") },
      format: "jwk",
    });
  } catch {
    throw new SignedCommandError("bad_vehicle_key", "vehicle public key is not on the P-256 curve");
  }
}

/** K = SHA1(ECDH(c, V).x)[:16]. */
export function sharedKey(privateKey: crypto.KeyObject, vehiclePublic: Uint8Array): Buffer {
  const s = crypto.diffieHellman({ privateKey, publicKey: publicKeyFromBytes(vehiclePublic) });
  return crypto.createHash("sha1").update(s).digest().subarray(0, 16);
}

export function subkey(k: Uint8Array, label: string): Buffer {
  return crypto.createHmac("sha256", k).update(label).digest();
}

/** HMAC-SHA256(HMAC-SHA256(K, "session info"), metadata(type HMAC, VIN, challenge) || 0xFF || session_info). */
export function sessionInfoTag(k: Uint8Array, vin: string, challenge: Uint8Array, encodedInfo: Uint8Array): Buffer {
  const meta = new Metadata()
    .add(TAG.SIGNATURE_TYPE, Buffer.from([SIGNATURE_TYPE_HMAC]))
    .add(TAG.PERSONALIZATION, Buffer.from(vin, "utf8"))
    .add(TAG.CHALLENGE, challenge)
    .serialize();
  return crypto.createHmac("sha256", subkey(k, LABEL_SESSION_INFO)).update(meta).update(encodedInfo).digest();
}

export type CommandMetadata = { domain: number; vin: string; epoch: Uint8Array; expiresAt: number; counter: number; flags: number };

export function commandMetadata(m: CommandMetadata): Buffer {
  const meta = new Metadata()
    .add(TAG.SIGNATURE_TYPE, Buffer.from([SIGNATURE_TYPE_HMAC_PERSONALIZED]))
    .add(TAG.DOMAIN, Buffer.from([m.domain]))
    .add(TAG.PERSONALIZATION, Buffer.from(m.vin, "utf8"))
    .add(TAG.EPOCH, m.epoch)
    .addUint32(TAG.EXPIRES_AT, m.expiresAt)
    .addUint32(TAG.COUNTER, m.counter);
  if (m.flags > 0) meta.addUint32(TAG.FLAGS, m.flags);
  return meta.serialize();
}

/** tag = HMAC-SHA256(HMAC-SHA256(K, "authenticated command"), M || P). */
export function hmacPersonalizedTag(k: Uint8Array, m: CommandMetadata, payload: Uint8Array): Buffer {
  return crypto.createHmac("sha256", subkey(k, LABEL_MESSAGE_AUTH)).update(commandMetadata(m)).update(payload).digest();
}

/** Request hash for response decryption: signature type byte || tag (infotainment: full tag). */
export function requestHash(hmacTag: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([SIGNATURE_TYPE_HMAC_PERSONALIZED]), Buffer.from(hmacTag)]);
}

export type ResponseMetadata = { domain: number; vin: string; counter: number; flags: number; requestHash: Uint8Array; fault: number };

export function responseAad(m: ResponseMetadata): Buffer {
  const meta = new Metadata()
    .add(TAG.SIGNATURE_TYPE, Buffer.from([SIGNATURE_TYPE_AES_GCM_RESPONSE]))
    .add(TAG.DOMAIN, Buffer.from([m.domain]))
    .add(TAG.PERSONALIZATION, Buffer.from(m.vin, "utf8"))
    .addUint32(TAG.COUNTER, m.counter)
    .addUint32(TAG.FLAGS, m.flags)
    .add(TAG.REQUEST_HASH, m.requestHash)
    .addUint32(TAG.FAULT, m.fault)
    .serialize();
  return crypto.createHash("sha256").update(meta).digest();
}

/** AES-128-GCM decrypt of a vehicle response; throws SignedCommandError("response_auth_failed") on a bad tag. */
export function decryptResponse(k: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array, aad: Uint8Array): Buffer {
  if (nonce.length !== 12 || tag.length !== 16) throw new SignedCommandError("response_auth_failed", "response nonce/tag has the wrong length");
  try {
    const d = crypto.createDecipheriv("aes-128-gcm", k, nonce);
    d.setAAD(aad);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ciphertext), d.final()]);
  } catch {
    throw new SignedCommandError("response_auth_failed", "vehicle response failed authentication");
  }
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
