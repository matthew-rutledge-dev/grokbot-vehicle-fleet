/**
 * Token store: one JSON file, mode 0600 (dir 0700), atomic writes
 * (tmp + fsync + rename) under an exclusive lock file so two server processes
 * never spend the same single-use refresh token. Access tokens are NOT stored.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type StoredTokens = {
  version: 1;
  refresh_token?: string;
  refresh_issued_at?: string;
  /** sha256 of TESLA_REFRESH_TOKEN values already adopted or superseded. */
  seen_seed_sha256?: string[];
  region?: string;
  base_url?: string;
  needs_reauth?: boolean;
  updated_at?: string;
};

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const LOCK_STALE_MS = 30_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Atomic JSON write: temp file + fsync + rename; file 0600, directory 0700. */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

/** Run fn while holding an exclusive `<filePath>.lock` (stale locks are broken after 30 s). */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const lock = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the lock on ${path.basename(filePath)}`);
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

export class TokenStore {
  constructor(readonly filePath: string) {}

  read(): StoredTokens | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    const data = JSON.parse(text) as StoredTokens;
    if (data.version !== 1) throw new Error("token store has an unknown version");
    return data;
  }

  write(data: StoredTokens): void {
    atomicWriteJson(this.filePath, { ...data, version: 1, updated_at: new Date().toISOString() });
  }

  /** Run fn while holding an exclusive lock file next to the store. */
  withLock<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
    return withFileLock(this.filePath, fn, timeoutMs);
  }
}
