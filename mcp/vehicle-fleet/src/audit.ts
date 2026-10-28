/**
 * Append-only JSONL audit log for experimental signed commands.
 * Entries never hold a full VIN (last 6 only), a full URL, a query string,
 * a token or key material: callers pass already-reduced fields.
 * File created 0600 in a 0700 directory (POSIX; best effort on Windows).
 */
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

export class AuditLog {
  private chain: Promise<unknown> = Promise.resolve();
  private warned = false;

  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
    private readonly warn: (m: string) => void = (m) => process.stderr.write(`${m}\n`),
  ) {}

  /** Append one entry. Resolves true when written, false on any error (one stderr warning, no path). */
  write(entry: AuditEntry): Promise<boolean> {
    const line = `${JSON.stringify({ ts: new Date(this.now()).toISOString(), ...entry })}\n`;
    const p = this.chain.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await fs.promises.appendFile(this.filePath, line, { mode: 0o600 });
        return true;
      } catch {
        if (!this.warned) {
          this.warned = true;
          this.warn("vehicle-fleet: could not write the audit log (TESLA_FLEET_AUDIT_LOG); experimental signed commands are refused until it is writable.");
        }
        return false;
      }
    });
    this.chain = p;
    return p;
  }
}
