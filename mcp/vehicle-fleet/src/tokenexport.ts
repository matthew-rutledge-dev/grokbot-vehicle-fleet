/**
 * Opt-in access-token export (TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE).
 *
 * Off by default. When a path is configured, every access token this server obtains
 * (first acquisition and every refresh) is written to that file for trusted local
 * consumers on the same host (for example a read-only poller), so they never need a
 * refresh token of their own (refresh tokens are single use; two refreshers would race).
 *
 * - Content: the raw access token only. No newline, no JSON, never the refresh token.
 * - Atomic: temp file in the same directory + fsync + rename. File mode 0600; a missing
 *   parent directory is created with mode 0700. On Windows the modes are best effort
 *   (no ACLs are set); the file inherits the directory's ACL.
 * - Failures never stop the server: a write failure is warned about once (error code
 *   only, never the token) and the next refresh tries again.
 *
 * WARNING: the exported token carries every scope the plugin was granted (including
 * vehicle_cmds / energy_cmds when granted). Anyone who can read the file can act as the
 * plugin until the token expires.
 */
import fs from "node:fs";
import path from "node:path";
import { usagePathFor } from "./usage.js";

export const EXPORT_ENV = "TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE";

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};

/** True when `child` is `parent` or sits inside it. */
function isSameOrInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Validate the configured export path. Returns the path to use, or undefined (off) plus a
 * warning. Refused: a relative path, the token store itself, anything inside the token
 * store path, the store's lock file, and the usage counter file.
 */
export function resolveExportPath(raw: string | undefined, tokenStorePath: string): { path?: string; warning?: string } {
  if (raw === undefined) return {};
  if (!path.isAbsolute(raw)) {
    return { warning: `${EXPORT_ENV} must be an absolute path; access-token export is off.` };
  }
  const reserved = [tokenStorePath, `${tokenStorePath}.lock`, usagePathFor(tokenStorePath)];
  if (reserved.some((r) => isSameOrInside(raw, r))) {
    return { warning: `${EXPORT_ENV} must not be the token store, its lock file, the usage file, or a path inside them; access-token export is off.` };
  }
  if (/[\\/]$/.test(raw)) {
    return { warning: `${EXPORT_ENV} must be a file path, not a directory; access-token export is off.` };
  }
  return { path: path.resolve(raw) };
}

/** Atomic raw-string write: tmp + fsync + rename; file 0600, new parent directory 0700. */
export function atomicWriteRaw(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

export class AccessTokenExporter {
  private warned = false;
  constructor(
    readonly filePath: string | undefined,
    private readonly warn: (message: string) => void = (m) => console.error(m),
  ) {}

  get enabled(): boolean {
    return Boolean(this.filePath);
  }

  /** Write the access token. Never throws; never logs or returns the token. */
  write(accessToken: string): boolean {
    if (!this.filePath) return false;
    try {
      atomicWriteRaw(this.filePath, accessToken);
      this.warned = false;
      return true;
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        const code = (e as NodeJS.ErrnoException)?.code ?? "write_failed";
        this.warn(`${EXPORT_ENV}: could not write the access-token export (${code}); continuing without it.`);
      }
      return false;
    }
  }
}
