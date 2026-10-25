/**
 * Local Fleet API usage counter.
 *
 * Counts every HTTP response this server receives from the Fleet API (direct)
 * and from the installer's command proxy, by Tesla pricing category, in UTC
 * calendar-month buckets (Tesla bills per calendar month from the 1st).
 *
 * Tesla's rule: every response with status < 500 is billable; >= 500 is not.
 * Both are counted; only < 500 goes into the estimate.
 *
 * - data / command / wake: Tesla's published pricing categories.
 * - other: endpoints whose pricing category is not documented here (vehicle
 *   list, vehicle state, fleet_status, region lookup, /status). Kept apart and
 *   NOT priced in the estimate; a "what if billed as data" figure is shown.
 * - auth: token refresh calls (authentication is not billed), for info only.
 *
 * Totals only: no VINs, tokens, URLs or vehicle data are stored. The file sits
 * next to the token store (usage.json), written atomically under a lock.
 * Recording never breaks a tool call; failures are reported once on stderr.
 */
import path from "node:path";
import fs from "node:fs";
import { atomicWriteJson, withFileLock } from "./tokenstore.js";

export const CATEGORIES = ["data", "command", "wake", "other", "auth"] as const;
export type UsageCategory = (typeof CATEGORIES)[number];

/** billable = responses < 500; notBilled = responses >= 500; noResponse = network error / timeout. */
export type Counter = { billable: number; notBilled: number; noResponse: number };
export type MonthBucket = Record<UsageCategory, Counter>;
export type UsageFile = { version: 1; months: Record<string, MonthBucket>; updated_at?: string };

export type Rates = {
  dataPerUsd: number;
  commandsPerUsd: number;
  wakesPerUsd: number;
  monthlyDiscountUsd: number;
};

/** Tesla's published Fleet API rates (Billing and Limits page). Overridable via env. */
export const DEFAULT_RATES: Rates = { dataPerUsd: 500, commandsPerUsd: 1000, wakesPerUsd: 50, monthlyDiscountUsd: 10 };

/** Months kept in the file (older buckets are pruned). */
export const KEEP_MONTHS = 13;

export const USAGE_FILE_NAME = "usage.json";

export function usagePathFor(tokenStorePath: string): string {
  return path.join(path.dirname(tokenStorePath), USAGE_FILE_NAME);
}

/** "YYYY-MM" for the UTC calendar month containing t. */
export function monthKey(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" of the UTC month before t's month. */
export function previousMonthKey(t: number): string {
  const d = new Date(t);
  return monthKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

export function emptyBucket(): MonthBucket {
  const b = {} as MonthBucket;
  for (const c of CATEGORIES) b[c] = { billable: 0, notBilled: 0, noResponse: 0 };
  return b;
}

function normalizeBucket(raw: unknown): MonthBucket {
  const b = emptyBucket();
  if (!raw || typeof raw !== "object") return b;
  for (const c of CATEGORIES) {
    const v = (raw as Record<string, unknown>)[c] as Record<string, unknown> | undefined;
    if (!v || typeof v !== "object") continue;
    for (const k of ["billable", "notBilled", "noResponse"] as const) {
      const n = v[k];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) b[c][k] = Math.floor(n);
    }
  }
  return b;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function estimate(b: MonthBucket, rates: Rates) {
  const dataUsd = b.data.billable / rates.dataPerUsd;
  const commandUsd = b.command.billable / rates.commandsPerUsd;
  const wakeUsd = b.wake.billable / rates.wakesPerUsd;
  const gross = dataUsd + commandUsd + wakeUsd;
  const otherAsData = b.other.billable / rates.dataPerUsd;
  return {
    byCategoryUsd: { data: round2(dataUsd), command: round2(commandUsd), wake: round2(wakeUsd) },
    beforeDiscountUsd: round2(gross),
    afterDiscountUsd: round2(Math.max(0, gross - rates.monthlyDiscountUsd)),
    otherNotPriced: {
      billableResponses: b.other.billable,
      ifBilledAsDataUsd: round2(otherAsData),
      afterDiscountIfBilledAsDataUsd: round2(Math.max(0, gross + otherAsData - rates.monthlyDiscountUsd)),
    },
  };
}

export class UsageTracker {
  private chain: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
    private readonly warn: (msg: string) => void = (m) => console.error(m),
  ) {}

  read(): UsageFile {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, months: {} };
      throw e;
    }
    const raw = JSON.parse(text) as Partial<UsageFile>;
    if (raw.version !== 1) throw new Error("usage file has an unknown version");
    const months: Record<string, MonthBucket> = {};
    for (const [k, v] of Object.entries(raw.months ?? {})) {
      if (/^\d{4}-\d{2}$/.test(k)) months[k] = normalizeBucket(v);
    }
    return { version: 1, months, updated_at: raw.updated_at };
  }

  /**
   * Count one response (status) or one failed request (status undefined).
   * Serialised in-process and locked across processes. Never throws.
   */
  record(category: UsageCategory, status: number | undefined): Promise<void> {
    const t = this.now();
    this.chain = this.chain.then(() => this.apply(category, status, t)).catch((e) => {
      if (!this.warned) {
        this.warned = true;
        this.warn(`usage counter: could not update ${path.basename(this.filePath)} (${e instanceof Error ? e.message : String(e)}); tool calls are unaffected.`);
      }
    });
    return this.chain;
  }

  private async apply(category: UsageCategory, status: number | undefined, t: number): Promise<void> {
    await withFileLock(this.filePath, async () => {
      let data: UsageFile;
      try {
        data = this.read();
      } catch {
        data = { version: 1, months: {} }; // unreadable/corrupt file: start over rather than fail
      }
      const key = monthKey(t);
      const bucket = data.months[key] ?? emptyBucket();
      const c = bucket[category];
      if (status === undefined) c.noResponse++;
      else if (status < 500) c.billable++;
      else c.notBilled++;
      data.months[key] = bucket;
      const keep = Object.keys(data.months).sort().slice(-KEEP_MONTHS);
      const months: Record<string, MonthBucket> = {};
      for (const k of keep) months[k] = data.months[k];
      atomicWriteJson(this.filePath, { version: 1, months, updated_at: new Date(t).toISOString() });
    });
  }

  /** Wait for pending writes (tests, shutdown). */
  flush(): Promise<void> {
    return this.chain;
  }

  report(rates: Rates): Record<string, unknown> {
    const t = this.now();
    let data: UsageFile;
    let fileStatus = "ok";
    try {
      data = this.read();
      if (Object.keys(data.months).length === 0) fileStatus = "no calls recorded yet";
    } catch {
      data = { version: 1, months: {} };
      fileStatus = "unreadable (will be recreated on the next call)";
    }
    const month = (key: string) => {
      const b = data.months[key] ?? emptyBucket();
      return { month: key, counts: b, estimate: estimate(b, rates) };
    };
    return {
      ok: true,
      localEstimate: true,
      note: "LOCAL ESTIMATE: counts only Fleet API calls made by this server (not Home Assistant, other apps, or other machines). The billing and usage page of your app on the developer portal is the source of truth.",
      billingRule: "Responses with HTTP status < 500 are billable; >= 500 are not billed (counted as notBilled). noResponse = network error or timeout (no status seen).",
      categories: {
        data: "device data reads (vehicle_data, vehicle_data_cached, location)",
        command: "commands sent via your command proxy",
        wake: "wake_up",
        other: "endpoints with no documented pricing category here (vehicle list/state, fleet_status, region lookup, /status). Not priced in the estimate; see otherNotPriced.",
        auth: "token refresh; authentication is not billed (info only)",
      },
      monthBoundary: "UTC calendar month (Tesla bills from the 1st)",
      rates,
      thisMonth: month(monthKey(t)),
      lastMonth: month(previousMonthKey(t)),
      usageFile: { name: USAGE_FILE_NAME, status: fileStatus, updatedAt: data.updated_at },
    };
  }
}
