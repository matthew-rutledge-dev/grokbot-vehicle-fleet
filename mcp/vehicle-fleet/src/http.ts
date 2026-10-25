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
};

export type HttpResponse = { status: number; body: unknown; headers: Headers };

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
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
    let body: string | undefined;
    if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    } else {
      headers["Content-Type"] = "application/json";
      if (opts.json !== undefined) body = JSON.stringify(opts.json);
    }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
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
      await this.usage?.record(category, undefined);
      throw e;
    }
    await this.usage?.record(category, res.status);
    if (category !== "auth" && res.status < 500) this.billable++;
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: "non_json_response", error_description: text.slice(0, 200) };
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
