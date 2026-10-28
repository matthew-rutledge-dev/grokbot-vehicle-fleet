/** Test-only key helpers (not shipped in src/). */
import crypto from "node:crypto";

/** P-256 private KeyObject from a raw 32-byte scalar (published protocol test vectors only). */
export function privateKeyFromScalar(d: Uint8Array): crypto.KeyObject {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(d));
  const pub = ecdh.getPublicKey();
  return crypto.createPrivateKey({
    key: {
      kty: "EC", crv: "P-256",
      d: Buffer.from(d).toString("base64url"),
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}
