/**
 * URL checks for play_video_on_screen (EXPERIMENTAL). The vehicle fetches the
 * URL itself; these checks keep obviously unsafe or private targets out and keep
 * the URL out of logs (host + a short path hash only).
 */
import crypto from "node:crypto";
import { isIpLiteral } from "../config.js";
import { LocalRefusal } from "../errors.js";

export const MAX_VIDEO_URL_LENGTH = 2048;

/** Single-label and special-use names that never point at a public video host. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa", ".localdomain", ".test", ".invalid", ".onion"];

export type VideoUrl = {
  /** The exact URL that would be sent to the vehicle (never logged or echoed). */
  url: string;
  host: string;
  /** First 16 hex chars of SHA-256(path + query): lets two log lines be matched without revealing the path. */
  pathHash: string;
};

function refuse(message: string): never {
  throw new LocalRefusal("invalid_video_url", `${message}; nothing was sent.`,
    "Pass a public https:// URL with a host name (no IP addresses, localhost or private names, no user:password@).");
}

export function validateVideoUrl(raw: unknown): VideoUrl {
  if (typeof raw !== "string" || !raw.trim()) refuse("url is required");
  const s = (raw as string).trim();
  if (s.length > MAX_VIDEO_URL_LENGTH) refuse(`url is longer than ${MAX_VIDEO_URL_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(s)) refuse("url must not contain spaces or control characters");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    refuse("url is not a valid absolute URL");
  }
  if (u.protocol !== "https:") refuse("url must use https");
  if (u.username || u.password || /^https:\/\/[^/?#]*@/i.test(s)) refuse("url must not contain credentials (user:password@)");
  const host = u.hostname.toLowerCase();
  if (!host) refuse("url has no host");
  if (isIpLiteral(host)) refuse("url host must be a name, not an IP address");
  const bare = host.endsWith(".") ? host.slice(0, -1) : host;
  if (bare === "localhost" || !bare.includes(".") || PRIVATE_SUFFIXES.some((x) => bare.endsWith(x))) {
    refuse("url host must be a public host name (not localhost, a single-label or a private/special-use name)");
  }
  const pathHash = crypto.createHash("sha256").update(`${u.pathname}${u.search}`).digest("hex").slice(0, 16);
  return { url: u.toString(), host: bare, pathHash };
}

/** Exact host, or "*.domain" for any subdomain of domain (not the domain itself). */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowlist.some((e) => (e.startsWith("*.") ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e));
}
