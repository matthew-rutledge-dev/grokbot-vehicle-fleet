/**
 * URL checks for play_video_on_screen (EXPERIMENTAL). The vehicle fetches the
 * URL itself; these checks keep obviously unsafe or private targets out and keep
 * the URL out of logs (host + a keyed path hash only, see audit.ts).
 *
 * Limits (by design, no DNS lookups here): a public host NAME that resolves to a
 * private or loopback address (wildcard-DNS services, "localtest"-style names,
 * a domain someone points at a LAN IP) passes these checks, and so do
 * look-alike / confusable characters (IDNA-normalised to punycode, but not
 * judged). That is why any host that is not on TESLA_FLEET_VIDEO_HOST_ALLOWLIST
 * needs the separate allow_unlisted_host approval from the user.
 */
import { isIpLiteral } from "../config.js";
import { LocalRefusal } from "../errors.js";

export const MAX_VIDEO_URL_LENGTH = 2048;

/** Single-label and special-use names that never point at a public video host. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa", ".localdomain", ".test", ".invalid", ".onion"];

export type VideoUrl = {
  /** The exact (normalised) URL that would be sent to the vehicle (never logged or echoed). */
  url: string;
  host: string;
  /** Explicit non-default port, or "" for 443. */
  port: string;
  /** path + query, only ever passed to the keyed hash. */
  pathAndQuery: string;
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
  const url = u.toString();
  // Normalisation (punycode, percent-encoding) can grow the URL: cap what is actually sent.
  if (url.length > MAX_VIDEO_URL_LENGTH) refuse(`url is longer than ${MAX_VIDEO_URL_LENGTH} characters once normalised`);
  return { url, host: bare, port: u.port, pathAndQuery: `${u.pathname}${u.search}` };
}

/** Allowlist entry: host (exact) or "*.domain" (subdomains only), optionally ":port". */
function splitEntry(e: string): { host: string; port: string } {
  const m = /^(.*?)(?::(\d+))?$/.exec(e)!;
  return { host: m[1], port: m[2] ?? "" };
}

function hostMatches(pattern: string, h: string): boolean {
  return pattern.startsWith("*.") ? h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1 : h === pattern;
}

/**
 * Exact host, or "*.domain" for any subdomain of domain (not the domain itself).
 * The port must match too: an entry without a port covers only the default port (443),
 * and a non-default port is allowed only by an entry that names it.
 */
export function hostAllowed(host: string, allowlist: readonly string[], port = ""): boolean {
  const h = host.toLowerCase();
  return allowlist.some((e) => {
    const s = splitEntry(e);
    return s.port === port && hostMatches(s.host, h);
  });
}
