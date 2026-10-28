/**
 * Append-only JSONL audit log for experimental signed commands.
 * Entries never hold a full VIN (last 6 only), a full URL, a query string,
 * a token or key material: callers pass already-reduced fields. URL paths are
 * recorded only as a KEYED hash (HMAC-SHA256 with a per-install random salt
 * kept next to the log as "<log>.salt", 0600), so a short or guessable path
 * cannot be recovered by hashing candidates without that file.
 *
 * POSIX: the log and salt are kept at 0600 and the log directory at 0700,
 * including files and folders that already existed (tightened when this user
 * owns them; a directory owned by someone else that others can write to is
 * refused). Windows: best effort, no ACL changes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type AuditEvent = "refused" | "dry_run" | "attempt" | "result" | "failure";

export type AuditEntry = {
  tool: string;
  event: AuditEvent;
  vinLast6?: string | null;
  [k: string]: unknown;
};

/** Last 6 of a VIN for audit entries; null when unknown. */
export function vinLast6(vin: string | undefined | null): string | null {
  if (!vin) return null;
  const v = String(vin).trim().toUpperCase();
  return v.length >= 6 ? v.slice(-6) : null;
}

const POSIX = process.platform !== "win32" && typeof process.getuid === "function";
const SALT_RE = /^[0-9a-f]{64}$/;

class AuditPathError extends Error {}

async function tightenDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!POSIX) return;
  const st = await fs.promises.stat(dir);
  if (!st.isDirectory()) throw new AuditPathError("audit directory is not a directory");
  if (st.uid === process.getuid!()) {
    if (st.mode & 0o077) await fs.promises.chmod(dir, 0o700);
  } else if (st.mode & 0o022) {
    throw new AuditPathError("audit directory is writable by other users");
  }
}

async function tightenFile(file: string): Promise<void> {
  if (!POSIX) return;
  const st = await fs.promises.lstat(file);
  if (!st.isFile()) throw new AuditPathError("audit path is not a regular file");
  if (st.uid !== process.getuid!()) throw new AuditPathError("audit file is owned by another user");
  if (st.mode & 0o077) await fs.promises.chmod(file, 0o600);
}

export class AuditLog {
  private chain: Promise<unknown> = Promise.resolve();
  private warned = false;
  private salt?: Buffer;

  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
    private readonly warn: (m: string) => void = (m) => process.stderr.write(`${m}\n`),
  ) {}

  get saltPath(): string {
    return `${this.filePath}.salt`;
  }

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    this.warn("vehicle-fleet: could not write the audit log (TESLA_FLEET_AUDIT_LOG); experimental signed commands are refused until it is writable.");
  }

  /** Directory 0700, salt created (0600) or loaded and checked. */
  private async prepare(): Promise<Buffer> {
    await tightenDir(path.dirname(this.filePath));
    if (this.salt) return this.salt;
    try {
      await fs.promises.writeFile(this.saltPath, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
    await tightenFile(this.saltPath);
    const hex = (await fs.promises.readFile(this.saltPath, "utf8")).trim();
    if (!SALT_RE.test(hex)) throw new AuditPathError("audit salt file is malformed");
    this.salt = Buffer.from(hex, "hex");
    return this.salt;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Keyed hash (16 hex chars) of a value such as a URL path + query; null if the salt is unavailable. */
  keyedHash(value: string): Promise<string | null> {
    return this.serial(async () => {
      try {
        const salt = await this.prepare();
        return crypto.createHmac("sha256", salt).update(value).digest("hex").slice(0, 16);
      } catch {
        this.warnOnce();
        return null;
      }
    });
  }

  /** True when the log (and its salt) can be written right now; touches nothing else. */
  checkWritable(): Promise<boolean> {
    return this.serial(async () => {
      try {
        await this.prepare();
        const fh = await fs.promises.open(this.filePath, "a", 0o600);
        await fh.close();
        await tightenFile(this.filePath);
        return true;
      } catch {
        this.warnOnce();
        return false;
      }
    });
  }

  /** Append one entry. Resolves true when written, false on any error (one stderr warning, no path). */
  write(entry: AuditEntry): Promise<boolean> {
    const line = `${JSON.stringify({ ts: new Date(this.now()).toISOString(), ...entry })}\n`;
    return this.serial(async () => {
      try {
        await this.prepare();
        const fh = await fs.promises.open(this.filePath, "a", 0o600);
        try {
          await tightenFile(this.filePath); // before any new content lands in a pre-existing loose file
          await fh.appendFile(line);
        } finally {
          await fh.close();
        }
        return true;
      } catch {
        this.warnOnce();
        return false;
      }
    });
  }
}
