/** Helpers that keep secrets, full VINs and precise coordinates out of output. */

export function maskVin(vin: string | undefined | null): string {
  if (!vin) return "";
  const v = String(vin);
  return v.length <= 4 ? "****" : `***${v.slice(-4)}`;
}

/** Replace every occurrence of each secret (len >= 8) with [redacted]. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  }
  // Bearer tokens / JWT-looking strings that slipped through.
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [redacted]");
  out = out.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]");
  return out;
}

/** Round a coordinate: coarse = 2 decimals (~1 km), precise = 5 decimals (~1 m). */
export function roundCoord(value: unknown, precision: "coarse" | "precise"): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const f = precision === "precise" ? 1e5 : 1e2;
  return Math.round(value * f) / f;
}
