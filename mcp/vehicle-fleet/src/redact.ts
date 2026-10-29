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

/**
 * Short secrets (the 4-digit valet PIN) can't go through redactSecrets (len >= 8, plain substring
 * replace would also hit unrelated text). Walk the value instead: a string has every occurrence
 * not touching other digits replaced; a number whose decimal form equals the secret, or a key
 * equal to it, is replaced too. Returns a new value; JSON-safe.
 */
export function redactShortSecrets(value: unknown, secrets: Array<string | undefined>): unknown {
  const list = secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (!list.length) return value;
  const res = list.map((s) => new RegExp(`(?<!\\d)${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`, "g"));
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 32) return "[redacted]";
    if (typeof v === "string") return res.reduce((acc, re) => acc.replace(re, "[redacted]"), v);
    if (typeof v === "number") return list.includes(String(v)) ? "[redacted]" : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [walk(k, depth + 1) as string, walk(x, depth + 1)]));
    }
    return v;
  };
  return walk(value, 0);
}

/** Round a coordinate: coarse = 2 decimals (~1 km), precise = 5 decimals (~1 m). */
export function roundCoord(value: unknown, precision: "coarse" | "precise"): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const f = precision === "precise" ? 1e5 : 1e2;
  return Math.round(value * f) / f;
}
