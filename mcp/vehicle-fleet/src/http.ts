/**
 * Small HTTP layer over undici fetch: JSON envelope, timeouts, error mapping,
 * honest User-Agent. No DNS caching (default resolver), per Tesla best practices.
 * The fetch implementation is injectable so tests never touch the network.
 */
import { fetch as undiciFetch, type Dispatcher } from "undici";
import { mapFleetError } from "./errors.js";
import type { UsageCategory, UsageTracker } from "./usage.js";
import { USER_AGENT } from "./version.js";

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  status: number;
  headers: Headers;
  text(): Promise<string>;
}>;

export const defaultFetch: FetchLike = (url, init) =>
  undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as ReturnType<FetchLike>;

export type RequestOptions = {
  method: "GET" | "POST";
  url: string;
  token?: string;
  json?: unknown;
  form?: Record<string, string>;
  dispatcher?: Dispatcher;
  timeoutMs?: number;
  /** A public, non-Tesla endpoint (e.g. NHTSA): never sent a token, not counted as Fleet API usage. */
  external?: boolean;
};

export type HttpResponse = { status: number; body: unknown; headers: Headers };

/**
 * Errors raised by a "command" category request (the command itself, not token refresh or
 * pre-checks). Only these can mean "maybe sent"; see classifySendFailure.
 */
export const COMMAND_REQUEST_ERRORS = new WeakSet<object>();

export class Http {
  /** Count of responses < 500 from Fleet API / proxy endpoints (every category except auth) this session. */
  billable = 0;
  constructor(
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly usage?: UsageTracker,
  ) {}

  /**
   * One HTTP request. `category` is the Tesla pricing category used by the
   * local usage counter (see usage.ts); every response is counted.
   */
  async request(opts: RequestOptions, category: UsageCategory): Promise<HttpResponse> {
    try {
      return await this.send(opts, category);
    } catch (e) {
      if (category === "command" && e && typeof e === "object") COMMAND_REQUEST_ERRORS.add(e);
      throw e;
    }
  }

  private async send(opts: RequestOptions, category: UsageCategory): Promise<HttpResponse> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
    let body: string | undefined;
    if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    if (opts.token && !opts.external) headers.Authorization = `Bearer ${opts.token}`;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(opts.url, {
        method: opts.method,
        headers,
        body,
        dispatcher: opts.dispatcher,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      if (!opts.external) await this.usage?.record(category, undefined);
      throw e;
    }
    if (!opts.external) {
      await this.usage?.record(category, res.status);
      if (category !== "auth" && res.status < 500) this.billable++;
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Plain-text success bodies (e.g. GET /status -> "ok") stay text; errors get a structured shape.
        parsed = res.status < 400 ? text.slice(0, 200) : { error: "non_json_response", error_description: text.slice(0, 200) };
      }
    }
    if (res.status >= 400) throw mapFleetError(res.status, parsed, res.headers);
    return { status: res.status, body: parsed, headers: res.headers };
  }
}

/** Unwrap the Fleet API `{ response: ... }` envelope. */
export function unwrap<T = unknown>(body: unknown): T {
  if (body && typeof body === "object" && "response" in (body as object)) {
    return (body as { response: T }).response;
  }
  return body as T;
}
