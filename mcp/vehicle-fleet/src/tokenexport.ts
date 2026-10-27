/**
 * Opt-in access-token export (TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE).
 *
 * Off by default. When a path is configured, every access token this server obtains
 * (its first refresh and every later one) is written to that file for trusted local
 * consumers on the same host (for example a read-only poller), so they never need a
 * refresh token of their own (refresh tokens are single use; two refreshers would race).
 * A keep-fresh loop (KeepFresh, below) refreshes ahead of expiry while the server runs.
 *
 * - Content: the raw access token only. No newline, no JSON, never the refresh token.
 * - Atomic: temp file in the same directory + fsync + rename, created with mode 0600; a
 *   missing parent directory is created with mode 0700. On Windows the modes are best
 *   effort (no ACLs are set); the file inherits the directory's ACL.
 * - Collision guard: the export path, the token store, its lock file and usage.json are
 *   compared canonically (realpath of the nearest existing ancestor + the remaining
 *   segments), and an existing target that is the same file (dev + ino) as any of them is
 *   refused. Checked at start and again before every write.
 * - Failures never stop the server: a write failure is warned about once (error code
 *   only, never the token or path) and the next refresh tries again.
 *
 * WARNING: the exported token carries every scope the plugin was granted (vehicle data and
 * full-precision location, and vehicle_cmds / energy_cmds when granted). Anyone who can read
 * the file can act as the plugin until the token expires.
 */
import fs from "node:fs";
import path from "node:path";
import { FleetApiError, LocalRefusal } from "./errors.js";
import { usagePathFor } from "./usage.js";

export const EXPORT_ENV = "TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE";

type Platform = NodeJS.Platform;

/** Case-insensitive file systems by default on Windows and macOS. */
const foldCase = (platform: Platform) => platform === "win32" || platform === "darwin";

/**
 * Absolute for this platform. On win32 only a drive-letter path (C:\...) or a UNC path
 * (\\server\share\...) counts; a rooted "\tok" path depends on the current drive.
 */
export function isAbsoluteFor(p: string, platform: Platform = process.platform): boolean {
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(p);
  return path.isAbsolute(p);
}

/** realpath of the nearest existing ancestor + the remaining segments (symlinks resolved). */
export function canonicalPath(p: string, platform: Platform = process.platform): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      const out = path.join(real, ...rest);
      return foldCase(platform) ? out.toLowerCase() : out;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) {
        const out = path.join(cur, ...rest);
        return foldCase(platform) ? out.toLowerCase() : out;
      }
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `child` is `parent` or sits inside it (both canonical). */
function isSameOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function fileId(p: string): string | undefined {
  try {
    const s = fs.statSync(p);
    return `${s.dev}:${s.ino}`;
  } catch {
    return undefined;
  }
}

/** Paths the export must never touch. */
export function reservedPaths(tokenStorePath: string): string[] {
  return [tokenStorePath, `${tokenStorePath}.lock`, usagePathFor(tokenStorePath)];
}

/**
 * Validate the configured export path. Returns the path to use, or undefined (off) plus a
 * warning. Refused: a non-absolute path, a directory-style path, the token store, its lock
 * file, the usage counter file, anything inside them (all compared canonically), and an
 * existing target that is the same file (dev + ino) as any of them.
 */
export function resolveExportPath(
  raw: string | undefined,
  tokenStorePath: string,
  platform: Platform = process.platform,
): { path?: string; warning?: string } {
  if (raw === undefined) return {};
  if (!isAbsoluteFor(raw, platform)) {
    return { warning: `${EXPORT_ENV} must be an absolute path${platform === "win32" ? " (drive letter or UNC)" : ""}; access-token export is off.` };
  }
  if (/[\\/]$/.test(raw)) {
    return { warning: `${EXPORT_ENV} must be a file path, not a directory; access-token export is off.` };
  }
  const collision = { warning: `${EXPORT_ENV} must not be the token store, its lock file, the usage file, or a path inside them; access-token export is off.` };
  const target = canonicalPath(raw, platform);
  const reserved = reservedPaths(tokenStorePath);
  if (reserved.some((r) => isSameOrInside(target, canonicalPath(r, platform)))) return collision;
  const id = fileId(raw);
  if (id && reserved.some((r) => fileId(r) === id)) return collision;
  return { path: path.resolve(raw) };
}

/** Atomic raw-string write: tmp (0600) + fsync + rename; a new parent directory is 0700. */
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
}

export class AccessTokenExporter {
  private warnedWrite = false;
  private warnedPerms = false;
  private warnedGuard = false;
  constructor(
    readonly filePath: string | undefined,
    private readonly warn: (message: string) => void = (m) => console.error(m),
    /** Token store path, re-checked before every write (a symlink could appear later). */
    private readonly tokenStorePath?: string,
  ) {}

  get enabled(): boolean {
    return Boolean(this.filePath);
  }

  private warnLoosePerms(dir: string): void {
    if (process.platform === "win32" || this.warnedPerms) return;
    try {
      if ((fs.statSync(dir).mode & 0o022) !== 0) {
        this.warnedPerms = true;
        this.warn(`${EXPORT_ENV}: the export file's directory is group- or world-writable; use a private directory (not /tmp or a shared or synced folder).`);
      }
    } catch {
      /* missing: created 0700 on write */
    }
  }

  /** Write the access token. Never throws; never logs or returns the token. */
  write(accessToken: string): boolean {
    if (!this.filePath) return false;
    if (this.tokenStorePath && !resolveExportPath(this.filePath, this.tokenStorePath).path) {
      if (!this.warnedGuard) {
        this.warnedGuard = true;
        this.warn(`${EXPORT_ENV} now resolves to the token store, its lock file or the usage file; not written.`);
      }
      return false;
    }
    this.warnLoosePerms(path.dirname(this.filePath));
    try {
      atomicWriteRaw(this.filePath, accessToken);
      this.warnedWrite = false;
      return true;
    } catch (e) {
      if (!this.warnedWrite) {
        this.warnedWrite = true;
        const code = (e as NodeJS.ErrnoException)?.code ?? "write_failed";
        this.warn(`${EXPORT_ENV}: could not write the access-token export (${code}); continuing without it.`);
      }
      return false;
    }
  }
}

/** What the keep-fresh loop needs from the TokenManager. */
export interface RefreshSource {
  /** Refresh now through the manager's single-flight + store lock + auth rate limiter. */
  forceRefresh(): Promise<string>;
  /** Expiry (ms epoch) of the in-memory access token, if any. */
  accessExpiresAt(): number | undefined;
  /** A refresh token is available (store or unseen seed) and re-consent is not pending. */
  canRefresh(): boolean;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real timers, unref'd so the loop never keeps the process alive. */
export const realScheduler: Scheduler = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout(h) {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export const KEEP_FRESH_LEAD_MS = 10 * 60_000;
export const KEEP_FRESH_MIN_DELAY_MS = 60_000;
export const KEEP_FRESH_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];

function errorCode(e: unknown): string {
  if (e instanceof LocalRefusal) return e.code;
  if (e instanceof FleetApiError) return e.info.code;
  return "refresh_failed";
}

function retryAfterMs(e: unknown): number {
  const s = e instanceof FleetApiError ? e.info.retryAfterSec : e instanceof LocalRefusal ? (e.extra?.retryAfterSec as number | undefined) : undefined;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

/**
 * Keeps the exported access token fresh while the server runs: refresh once at start (if a
 * refresh token exists), then again about 10 minutes before each expiry. Failures back off
 * 1, 5, 15 min (capped; a longer Retry-After wins) with one warning; login_required or a
 * missing refresh token stops the loop and leaves the file alone.
 */
export class KeepFresh {
  private handle: unknown;
  private failures = 0;
  private warned = false;
  private stopped = false;
  /** Last scheduled delay (tests / diagnostics). */
  lastDelayMs: number | undefined;

  constructor(
    private readonly src: RefreshSource,
    private readonly now: () => number = Date.now,
    private readonly scheduler: Scheduler = realScheduler,
    private readonly warn: (m: string) => void = (m) => console.error(m),
    private readonly jitterMs: () => number = () => Math.floor(Math.random() * 60_000),
  ) {}

  get running(): boolean {
    return !this.stopped && this.handle !== undefined;
  }

  /** First refresh now (returns when it settles). */
  async start(): Promise<void> {
    if (!this.src.canRefresh()) {
      this.stop();
      return;
    }
    await this.run();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) this.scheduler.clearTimeout(this.handle);
    this.handle = undefined;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.lastDelayMs = ms;
    this.handle = this.scheduler.setTimeout(() => {
      this.handle = undefined;
      void this.run();
    }, ms);
  }

  /** One refresh attempt, then schedule the next one. Never throws. */
  async run(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.src.forceRefresh();
      this.failures = 0;
      this.warned = false;
      const exp = this.src.accessExpiresAt();
      const due = exp === undefined ? KEEP_FRESH_MIN_DELAY_MS : exp - this.now() - KEEP_FRESH_LEAD_MS - this.jitterMs();
      this.schedule(Math.max(KEEP_FRESH_MIN_DELAY_MS, due));
    } catch (e) {
      const code = errorCode(e);
      if (code === "login_required" || code === "no_refresh_token" || code === "not_configured") {
        this.warn(`access-token export: refresh stopped (${code}); the export file is left as is and will expire. Re-consent, then reload the MCP server.`);
        this.stop();
        return;
      }
      const step = KEEP_FRESH_BACKOFF_MS[Math.min(this.failures, KEEP_FRESH_BACKOFF_MS.length - 1)];
      this.failures++;
      if (!this.warned) {
        this.warned = true;
        this.warn(`access-token export: refresh failed (${code}); retrying with back-off.`);
      }
      this.schedule(Math.max(step, retryAfterMs(e)));
    }
  }
}
