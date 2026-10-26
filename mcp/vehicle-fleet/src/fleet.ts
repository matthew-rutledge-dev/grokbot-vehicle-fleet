/**
 * Fleet API client: reads go to the Fleet API base URL; commands go to the
 * installer's own tesla-http-proxy (VIN in the path), with a configured CA.
 * TLS verification is never disabled.
 */
import fs from "node:fs";
import { Agent, type Dispatcher } from "undici";
import type { TokenManager } from "./auth.js";
import { TtlCache } from "./cache.js";
import { REGION_BASE_URLS, type Config } from "./config.js";
import { FleetApiError, LocalRefusal } from "./errors.js";
import { unwrap, type Http } from "./http.js";
import type { RateLimiter } from "./ratelimit.js";
import type { UsageCategory } from "./usage.js";

export type VehicleSummary = {
  vin: string;
  display_name?: string;
  state?: string;
  granular_access?: { hide_private?: boolean };
};

export type FleetStatus = {
  paired?: boolean;
  commandProtocolRequired?: boolean;
  firmware?: string;
  totalKeys?: number;
};

export const STATE_TTL_MS = 30_000;
export const LIVE_TTL_MS = 60_000;
export const CACHED_TTL_MS = 60_000;
export const FLEET_STATUS_TTL_MS = 10 * 60_000;
/** Vehicle list reused for VIN resolution (the set of cars rarely changes). */
export const VEHICLE_LIST_TTL_MS = 5 * 60_000;
export const ENERGY_LIVE_TTL_MS = 60_000;
export const ENERGY_INFO_TTL_MS = 10 * 60_000;
export const ENERGY_HISTORY_TTL_MS = 5 * 60_000;

/** One energy product from GET /api/1/products (fields used here only). */
export type EnergyProduct = { energy_site_id: number | string; site_name?: string; resource_type?: string } & Record<string, unknown>;

/** Build the proxy dispatcher. Uses the configured CA only; certificate verification is never disabled. */
export function buildProxyDispatcher(caPath: string | undefined): Dispatcher | undefined {
  if (!caPath) return undefined; // system trust store
  const ca = fs.readFileSync(caPath, "utf8");
  return new Agent({ connect: { ca } });
}

export type FleetClientOptions = {
  sleep?: (ms: number) => Promise<void>;
  wakePollMs?: number;
  wakeTimeoutMs?: number;
};

export class FleetClient {
  private baseUrl?: string;
  private proxyDispatcher?: Dispatcher;
  private proxyDispatcherLoaded = false;
  readonly cache = new TtlCache();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly wakePollMs: number;
  private readonly wakeTimeoutMs: number;

  constructor(
    private readonly config: Config,
    private readonly http: Http,
    private readonly tokens: TokenManager,
    private readonly limiter: RateLimiter,
    opts: FleetClientOptions = {},
  ) {
    this.baseUrl = config.baseUrl;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.wakePollMs = opts.wakePollMs ?? 5_000;
    this.wakeTimeoutMs = opts.wakeTimeoutMs ?? 60_000;
  }

  get billableCalls(): number {
    return this.http.billable;
  }

  /** Authenticated call with one retry after a bodiless 401 (expired access token). */
  private async call(category: UsageCategory, method: "GET" | "POST", url: string, json?: unknown, dispatcher?: Dispatcher, timeoutMs?: number) {
    const token = await this.tokens.getAccessToken();
    try {
      return await this.http.request({ method, url, token, json, dispatcher, timeoutMs }, category);
    } catch (e) {
      if (e instanceof FleetApiError && e.info.status === 401 && e.info.code === "unauthorized") {
        this.tokens.invalidate();
        const fresh = await this.tokens.getAccessToken();
        return this.http.request({ method, url, token: fresh, json, dispatcher, timeoutMs }, category);
      }
      throw e;
    }
  }

  /** Base URL: explicit config > region > stored > auto-detect via /api/1/users/region. */
  async resolveBaseUrl(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    const stored = this.tokens.storedBaseUrl();
    if (stored) return (this.baseUrl = stored);
    let lastErr: unknown;
    for (const region of ["na", "eu"]) {
      try {
        const res = await this.call("other", "GET", `${REGION_BASE_URLS[region]}/api/1/users/region`);
        const r = unwrap<{ region?: string; fleet_api_base_url?: string }>(res.body);
        const url = r?.fleet_api_base_url;
        if (!url || !/^https:\/\/fleet-api\.prd\.[a-z]+\.vn\.cloud\.tesla\.(com|cn)$/.test(url)) {
          throw new Error("region endpoint returned an unexpected base URL");
        }
        this.baseUrl = url;
        await this.tokens.saveRegion(r.region, url);
        return url;
      } catch (e) {
        lastErr = e;
        if (e instanceof FleetApiError && [412, 421].includes(e.info.status)) continue;
        throw e;
      }
    }
    throw lastErr;
  }

  async apiStatus(): Promise<string> {
    const base = await this.resolveBaseUrlNoAuth();
    const res = await this.http.request({ method: "GET", url: `${base}/status`, timeoutMs: 10_000 }, "other");
    return typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? "ok");
  }

  private async resolveBaseUrlNoAuth(): Promise<string> {
    return this.baseUrl ?? this.tokens.storedBaseUrl() ?? REGION_BASE_URLS.na;
  }

  /** GET /api/1/vehicles. fresh=false reuses a list fetched in the last 5 min. */
  async listVehicles(fresh = true): Promise<VehicleSummary[]> {
    if (!fresh) {
      const hit = this.cache.get<VehicleSummary[]>("vehicles", VEHICLE_LIST_TTL_MS);
      if (hit) return hit.value;
    }
    const base = await this.resolveBaseUrl();
    const res = await this.call("other", "GET", `${base}/api/1/vehicles`);
    const list = unwrap<VehicleSummary[]>(res.body) ?? [];
    for (const v of list) this.cache.set(`state:${v.vin}`, v);
    this.cache.set("vehicles", list);
    return list;
  }

  /** Resolve the VIN: explicit > TESLA_DEFAULT_VIN > the only vehicle on the account. */
  async resolveVin(vin: unknown, opts: { requireExplicit?: boolean } = {}): Promise<string> {
    if (typeof vin === "string" && vin.trim()) return vin.trim().toUpperCase();
    if (opts.requireExplicit) {
      throw new LocalRefusal("vin_required", "This command needs an explicit vin (no default) because it can open the vehicle.");
    }
    if (this.config.defaultVin) return this.config.defaultVin.toUpperCase();
    const list = await this.listVehicles(false);
    if (list.length === 1) return list[0].vin;
    if (list.length === 0) throw new LocalRefusal("no_vehicles", "No vehicles on this account.");
    throw new LocalRefusal("vin_ambiguous", "More than one vehicle; pass vin.", undefined, {
      vehicles: list.map((v) => ({ vinLast4: v.vin.slice(-4), display_name: v.display_name })),
    });
  }

  /** Connectivity state from GET /api/1/vehicles/{vin} (cached 30 s). */
  async getVehicle(vin: string, fresh = false): Promise<VehicleSummary> {
    if (!fresh) {
      const hit = this.cache.get<VehicleSummary>(`state:${vin}`, STATE_TTL_MS);
      if (hit) return hit.value;
    }
    const base = await this.resolveBaseUrl();
    const res = await this.call("other", "GET", `${base}/api/1/vehicles/${encodeURIComponent(vin)}`);
    const v = unwrap<VehicleSummary>(res.body);
    this.cache.set(`state:${vin}`, v);
    return v;
  }

  /** Throws LocalRefusal unless the vehicle is online. Never wakes. */
  async requireOnline(vin: string): Promise<VehicleSummary> {
    const v = await this.getVehicle(vin, true);
    if (v?.state !== "online") {
      throw new LocalRefusal("vehicle_not_online", `Vehicle is ${v?.state ?? "unknown"}; nothing was sent.`,
        "Use cached data, try later, or ask the user to confirm wake_vehicle (costs a wake).", { state: v?.state });
    }
    return v;
  }

  async fleetStatus(vin: string): Promise<FleetStatus> {
    const hit = this.cache.get<FleetStatus>(`fleet_status:${vin}`, FLEET_STATUS_TTL_MS);
    if (hit) return hit.value;
    const base = await this.resolveBaseUrl();
    const res = await this.call("other", "POST", `${base}/api/1/vehicles/fleet_status`, { vins: [vin] });
    const r = unwrap<Record<string, unknown>>(res.body) ?? {};
    const paired = Array.isArray(r.key_paired_vins) ? (r.key_paired_vins as string[]) : undefined;
    const unpaired = Array.isArray(r.unpaired_vins) ? (r.unpaired_vins as string[]) : undefined;
    const info = ((r.vehicle_info ?? {}) as Record<string, Record<string, unknown>>)[vin] ?? {};
    const out: FleetStatus = {
      paired: paired?.includes(vin) ? true : unpaired?.includes(vin) ? false : undefined,
      commandProtocolRequired: typeof info.vehicle_command_protocol_required === "boolean"
        ? (info.vehicle_command_protocol_required as boolean) : undefined,
      firmware: typeof info.firmware_version === "string" ? (info.firmware_version as string) : undefined,
      totalKeys: typeof info.total_number_of_keys === "number" ? (info.total_number_of_keys as number) : undefined,
    };
    this.cache.set(`fleet_status:${vin}`, out);
    return out;
  }

  /** Live vehicle_data for the given endpoints. Caller must ensure online first. */
  async vehicleDataLive(vin: string, endpoints: string[]): Promise<{ data: Record<string, unknown>; ageSec: number }> {
    const key = `live:${vin}:${[...endpoints].sort().join(";")}`;
    const hit = this.cache.get<Record<string, unknown>>(key, LIVE_TTL_MS);
    if (hit) return { data: hit.value, ageSec: hit.ageSec };
    this.limiter.take("data", vin);
    const base = await this.resolveBaseUrl();
    const q = encodeURIComponent(endpoints.join(";"));
    const res = await this.call("data", "GET", `${base}/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data?endpoints=${q}`);
    const data = unwrap<Record<string, unknown>>(res.body) ?? {};
    this.cache.set(key, data);
    return { data, ageSec: 0 };
  }

  /** vehicle_data_cached: last reported data; never wakes, works asleep. */
  async vehicleDataCached(vin: string): Promise<{ data: Record<string, unknown>; ageSec: number }> {
    const key = `cached:${vin}`;
    const hit = this.cache.get<Record<string, unknown>>(key, CACHED_TTL_MS);
    if (hit) return { data: hit.value, ageSec: hit.ageSec };
    this.limiter.take("data", vin);
    const base = await this.resolveBaseUrl();
    const res = await this.call("data", "GET", `${base}/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data_cached`);
    const data = unwrap<Record<string, unknown>>(res.body) ?? {};
    this.cache.set(key, data);
    return { data, ageSec: 0 };
  }

  // ---- Energy sites (Powerwall / solar / Wall Connector via site live_status). Read-only. ----

  /** Energy products from GET /api/1/products (vehicles filtered out). fresh=false reuses a 5-min list. */
  async listEnergySites(fresh = true): Promise<EnergyProduct[]> {
    if (!fresh) {
      const hit = this.cache.get<EnergyProduct[]>("energy_sites", VEHICLE_LIST_TTL_MS);
      if (hit) return hit.value;
    }
    const base = await this.resolveBaseUrl();
    const res = await this.call("other", "GET", `${base}/api/1/products`);
    const all = unwrap<Array<Record<string, unknown>>>(res.body) ?? [];
    const sites = all.filter((p) => p && p.energy_site_id !== undefined && p.energy_site_id !== null) as EnergyProduct[];
    this.cache.set("energy_sites", sites);
    return sites;
  }

  /** Site id: explicit > TESLA_DEFAULT_ENERGY_SITE_ID > the only energy site on the account. */
  async resolveSiteId(id: unknown): Promise<string> {
    const clean = (v: string) => {
      if (!/^\d{1,20}$/.test(v)) throw new LocalRefusal("bad_site_id", "energy_site_id must be digits only (e.g. 1234567890).");
      return v;
    };
    if ((typeof id === "string" && id.trim()) || typeof id === "number") return clean(String(id).trim());
    if (this.config.defaultEnergySiteId) return clean(this.config.defaultEnergySiteId);
    const sites = await this.listEnergySites(false);
    const ids = [...new Set(sites.map((s) => String(s.energy_site_id)))];
    if (ids.length === 1) return ids[0];
    if (ids.length === 0) throw new LocalRefusal("no_energy_sites", "No energy sites on this account (or the token lacks energy_device_data).");
    throw new LocalRefusal("site_ambiguous", "More than one energy site; pass energy_site_id.", undefined, {
      sites: sites.map((s) => ({ energy_site_id: String(s.energy_site_id), site_name: s.site_name, resource_type: s.resource_type })),
    });
  }

  private async energyGet(key: string, ttl: number, siteId: string, path: string): Promise<{ data: Record<string, unknown>; ageSec: number }> {
    const hit = this.cache.get<Record<string, unknown>>(key, ttl);
    if (hit) return { data: hit.value, ageSec: hit.ageSec };
    this.limiter.take("data", `site:${siteId}`);
    const base = await this.resolveBaseUrl();
    const res = await this.call("data", "GET", `${base}/api/1/energy_sites/${encodeURIComponent(siteId)}/${path}`);
    const data = unwrap<Record<string, unknown>>(res.body) ?? {};
    this.cache.set(key, data);
    return { data, ageSec: 0 };
  }

  /** GET /energy_sites/{id}/live_status (cached 60 s). Includes wall_connectors when present. */
  energyLiveStatus(siteId: string) {
    return this.energyGet(`energy_live:${siteId}`, ENERGY_LIVE_TTL_MS, siteId, "live_status");
  }

  /** GET /energy_sites/{id}/site_info (cached 10 min). */
  energySiteInfo(siteId: string) {
    return this.energyGet(`energy_info:${siteId}`, ENERGY_INFO_TTL_MS, siteId, "site_info");
  }

  /** GET /energy_sites/{id}/calendar_history with an already-validated, bounded query (cached 5 min). */
  energyHistory(siteId: string, query: Record<string, string>) {
    const q = new URLSearchParams(query).toString();
    return this.energyGet(`energy_hist:${siteId}:${q}`, ENERGY_HISTORY_TTL_MS, siteId, `calendar_history?${q}`);
  }

  /** POST wake_up, then poll connectivity state (bounded). Only via the wake_vehicle tool. */
  async wakeUp(vin: string): Promise<{ state?: string; waitedSec: number }> {
    this.limiter.take("wake", vin);
    const base = await this.resolveBaseUrl();
    const res = await this.call("wake", "POST", `${base}/api/1/vehicles/${encodeURIComponent(vin)}/wake_up`);
    let v = unwrap<VehicleSummary>(res.body);
    let waited = 0;
    while (v?.state !== "online" && waited < this.wakeTimeoutMs) {
      await this.sleep(this.wakePollMs);
      waited += this.wakePollMs;
      v = await this.getVehicle(vin, true);
    }
    this.cache.deletePrefix(`live:${vin}`);
    return { state: v?.state, waitedSec: Math.round(waited / 1000) };
  }

  private proxy(): Dispatcher | undefined {
    if (!this.proxyDispatcherLoaded) {
      this.proxyDispatcher = buildProxyDispatcher(this.config.proxyCaCertPath);
      this.proxyDispatcherLoaded = true;
    }
    return this.proxyDispatcher;
  }

  /** Signed command through the installer's tesla-http-proxy. */
  async command(vin: string, name: string, body: Record<string, unknown>): Promise<{ result?: boolean; reason?: string }> {
    if (!this.config.proxyUrl) {
      throw new LocalRefusal("proxy_not_configured", "TESLA_COMMAND_PROXY_URL is not set; nothing was sent.",
        "Run your own tesla-http-proxy and set TESLA_COMMAND_PROXY_URL (skill vehicle-fleet-setup).");
    }
    this.limiter.take("command", vin);
    const url = `${this.config.proxyUrl}/api/1/vehicles/${encodeURIComponent(vin)}/command/${name}`;
    const res = await this.call("command", "POST", url, body, this.proxy(), 30_000);
    this.cache.deletePrefix(`live:${vin}`);
    this.cache.deletePrefix(`cached:${vin}`);
    return unwrap<{ result?: boolean; reason?: string }>(res.body) ?? {};
  }
}
