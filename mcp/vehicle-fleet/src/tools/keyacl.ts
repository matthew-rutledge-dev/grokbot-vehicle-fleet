/**
 * Windows-only, best-effort, NON-FATAL check of the command key file's ACL.
 * POSIX hosts enforce chmod 600 + owner in video.ts; Windows has no mode bits,
 * so statKey only checks that the file exists there. This helper runs the
 * built-in `icacls <file>` (metadata only; the key is never read) and warns when
 * a broad group (Everyone, BUILTIN\Users, Authenticated Users, or their
 * well-known SIDs) holds an allow entry with read, write or full rights.
 * English principal names only (icacls localises them; SIDs are matched too).
 * Any failure to run or parse icacls yields no warning, never a refusal.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const BROAD_PRINCIPALS = [
  "everyone",
  "builtin\\users",
  "nt authority\\authenticated users",
  "*s-1-1-0",
  "*s-1-5-32-545",
  "*s-1-5-11",
];

/** Simple rights (F, M, RX, R, W) and specific / generic rights that expose or replace the key. */
const RISKY_RIGHTS = new Set(["F", "M", "RX", "R", "W", "RD", "WD", "AD", "GR", "GW", "GA", "MA", "WDAC", "WO"]);

function broadPrincipal(left: string): string | undefined {
  const l = left.trimEnd().toLowerCase();
  return BROAD_PRINCIPALS.find((p) => l === p || l.endsWith(` ${p}`));
}

/**
 * Parse `icacls <file>` output. Returns e.g. ["Everyone:(R)", "BUILTIN\\Users:(I)(RX)"]
 * for allow entries of broad groups with risky rights. Deny entries are ignored.
 */
export function parseIcaclsBroadAccess(output: string): string[] {
  const found: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const idx = raw.lastIndexOf(":(");
    if (idx < 0) continue;
    const who = broadPrincipal(raw.slice(0, idx));
    if (!who) continue;
    const rights = raw.slice(idx + 1).trim();
    const groups = [...rights.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(",").map((s) => s.trim().toUpperCase()));
    if (groups.some((g) => g.includes("DENY"))) continue;
    if (groups.some((g) => g.some((r) => RISKY_RIGHTS.has(r)))) {
      const left = raw.slice(0, idx).trimEnd();
      found.push(`${left.slice(left.length - who.length)}:${rights}`);
    }
  }
  return found;
}

export type AclCheckOptions = {
  platform?: NodeJS.Platform;
  /** Test seam: returns icacls stdout for the file. */
  run?: (file: string) => string;
};

function runIcacls(file: string): string {
  return execFileSync("icacls", [file], { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
}

/** Warning text when a broad group can access the key file on Windows; undefined otherwise (and on any error). */
export function windowsKeyAclWarning(file: string | undefined, opts: AclCheckOptions = {}): string | undefined {
  if (!file || (opts.platform ?? process.platform) !== "win32") return undefined;
  let out: string;
  try {
    out = (opts.run ?? runIcacls)(path.resolve(file));
  } catch {
    return undefined;
  }
  const broad = parseIcaclsBroadAccess(out);
  if (broad.length === 0) return undefined;
  return `Windows: TESLA_FLEET_COMMAND_KEY_FILE is accessible to broad groups (${broad.join(", ")}). Not enforced; restrict it to your own account, e.g. icacls <file> /inheritance:r /grant:r "%USERNAME%:R".`;
}
