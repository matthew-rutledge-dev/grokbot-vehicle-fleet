/**
 * TokenManager: OAuth refresh against fleet-auth (documented token host).
 *
 * - Access token lives in memory only; renewed within 60 s of expiry
 *   (Tesla best practice: renew within a minute of expiration).
 * - Single-flight: concurrent tool calls share one refresh.
 * - Refresh tokens are single use (3-month life; previous valid 24 h), so the
 *   rotated token is persisted atomically, under a lock, BEFORE the new access
 *   token is used.
 * - TESLA_REFRESH_TOKEN seeds the store only when its hash has not been seen
 *   before (first run, or the operator pasted a fresh token after re-consent).
 */
import type { Config } from "./config.js";
import { FleetApiError, LocalRefusal } from "./errors.js";
import type { Http } from "./http.js";
import type { RateLimiter } from "./ratelimit.js";
import { sha256, type StoredTokens, type TokenStore } from "./tokenstore.js";

export const REFRESH_BUFFER_MS = 60_000;
const SEEN_MAX = 20;

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number };

export class TokenManager {
  private access?: { token: string; exp: number };
  private refreshing?: Promise<string>;

  constructor(
    private readonly config: Config,
    private readonly store: TokenStore,
    private readonly http: Http,
    private readonly limiter: RateLimiter,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.access && this.now() < this.access.exp - REFRESH_BUFFER_MS) return this.access.token;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  /** Drop the in-memory access token (e.g. after a 401 with no body). */
  invalidate(): void {
    this.access = undefined;
  }

  /** Persist resolved region/base URL next to the refresh token. */
  async saveRegion(region: string | undefined, baseUrl: string): Promise<void> {
    await this.store.withLock(async () => {
      const data = this.store.read() ?? { version: 1 };
      this.store.write({ ...data, region, base_url: baseUrl });
    });
  }

  storedBaseUrl(): string | undefined {
    try {
      return this.store.read()?.base_url;
    } catch {
      return undefined;
    }
  }

  /** Non-secret status for describe_boundary. */
  status(): Record<string, unknown> {
    let data: StoredTokens | undefined;
    let readable = true;
    try {
      data = this.store.read();
    } catch {
      readable = false;
    }
    return {
      tokenStore: readable ? (data ? "present" : "missing") : "unreadable",
      refreshTokenStored: Boolean(data?.refresh_token),
      needsReauth: Boolean(data?.needs_reauth),
      accessTokenInMemory: Boolean(this.access),
    };
  }

  private async refresh(): Promise<string> {
    const clientId = this.config.clientId;
    if (!clientId) throw new LocalRefusal("not_configured", "TESLA_CLIENT_ID is not set.", "Set the plugin variable.");

    return this.store.withLock(async () => {
      const data: StoredTokens = this.store.read() ?? { version: 1 };
      const seen = new Set(data.seen_seed_sha256 ?? []);
      const seed = this.config.refreshTokenSeed;
      if (seed) {
        const h = sha256(seed);
        const current = data.refresh_token ? sha256(data.refresh_token) : undefined;
        if (!seen.has(h) && h !== current) {
          if (data.refresh_token) seen.add(sha256(data.refresh_token));
          data.refresh_token = seed;
          data.needs_reauth = false;
        }
        seen.add(h);
      }
      if (!data.refresh_token) {
        throw new LocalRefusal("no_refresh_token", "No refresh token available.",
          "Run scripts/auth-helper.mjs or set TESLA_REFRESH_TOKEN (skill vehicle-fleet-setup).");
      }
      if (data.needs_reauth) {
        throw new LocalRefusal("login_required", "The stored refresh token was rejected earlier; re-consent is needed.",
          "Run scripts/auth-helper.mjs, then reload the MCP server.");
      }

      this.limiter.take("auth");
      const used = data.refresh_token;
      let tok: TokenResponse;
      try {
        const res = await this.http.request(
          {
            method: "POST",
            url: `${this.config.authBaseUrl}/oauth2/v3/token`,
            form: { grant_type: "refresh_token", client_id: clientId, refresh_token: used },
          },
          "auth", // authentication endpoints are not billed; counted for info only
        );
        tok = (res.body ?? {}) as TokenResponse;
      } catch (e) {
        if (e instanceof FleetApiError && (e.info.code === "login_required" || e.info.status === 401)) {
          this.store.write({ ...data, seen_seed_sha256: trim(seen), needs_reauth: true });
        }
        throw e;
      }
      if (!tok.access_token) throw new Error("token response had no access_token");

      const next = tok.refresh_token ?? used;
      if (next !== used) seen.add(sha256(used));
      // Persist the rotated refresh token BEFORE using the new access token.
      this.store.write({
        ...data,
        refresh_token: next,
        refresh_issued_at: new Date(this.now()).toISOString(),
        seen_seed_sha256: trim(seen),
        needs_reauth: false,
      });
      this.access = { token: tok.access_token, exp: this.now() + (tok.expires_in ?? 3600) * 1000 };
      return tok.access_token;
    });
  }
}

function trim(seen: Set<string>): string[] {
  return [...seen].slice(-SEEN_MAX);
}
