/** In-memory TTL cache. Never written to disk; cleared when the process exits. */
export class TtlCache {
  private map = new Map<string, { at: number; value: unknown }>();
  constructor(private readonly now: () => number = Date.now) {}

  get<T>(key: string, ttlMs: number): { value: T; ageSec: number } | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    const age = this.now() - hit.at;
    if (age > ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return { value: hit.value as T, ageSec: Math.round(age / 1000) };
  }

  set(key: string, value: unknown): void {
    this.map.set(key, { at: this.now(), value });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }
}
