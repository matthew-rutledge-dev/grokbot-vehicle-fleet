/**
 * Local token buckets at or below Tesla's documented limits (per device, per
 * account): realtime data 60/min, wakes 3/min, commands 30/min; auth well
 * under 20 req/s. Refusing locally avoids spending a billed 429.
 */
import { LocalRefusal } from "./errors.js";

export type BucketKind = "data" | "wake" | "command" | "auth";

export const LIMITS: Record<BucketKind, { capacity: number; perMs: number }> = {
  data: { capacity: 60, perMs: 60_000 },
  wake: { capacity: 3, perMs: 60_000 },
  command: { capacity: 30, perMs: 60_000 },
  auth: { capacity: 5, perMs: 1_000 },
};

class Bucket {
  private tokens: number;
  private last: number;
  constructor(private readonly capacity: number, private readonly perMs: number, now: number) {
    this.tokens = capacity;
    this.last = now;
  }
  take(now: number): number | undefined {
    const refill = ((now - this.last) / this.perMs) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + refill);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return undefined;
    }
    return Math.ceil(((1 - this.tokens) / this.capacity) * this.perMs / 1000);
  }
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Take one token or throw LocalRefusal("rate_limited_locally"). key = VIN or "global". */
  take(kind: BucketKind, key = "global"): void {
    const id = `${kind}:${key}`;
    let b = this.buckets.get(id);
    if (!b) {
      b = new Bucket(LIMITS[kind].capacity, LIMITS[kind].perMs, this.now());
      this.buckets.set(id, b);
    }
    const wait = b.take(this.now());
    if (wait !== undefined) {
      throw new LocalRefusal("rate_limited_locally",
        `Local ${kind} rate limit reached (Tesla limit per vehicle); nothing was sent.`,
        "Wait and try again; do not loop.", { retryAfterSec: wait });
    }
  }
}
