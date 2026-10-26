/**
 * Energy-site read tools (Powerwall / solar; Wall Connector data via site live_status).
 * Read-only: no energy commands. Needs the energy_device_data scope.
 */
import { FleetApiError, LocalRefusal } from "../errors.js";
import type { ToolArgs, ToolContext } from "../context.js";
import { pick } from "./extract.js";
import type { ToolDef } from "./types.js";

export const ENERGY_SCOPE = "energy_device_data";

export const SITE_PROP = {
  energy_site_id: {
    type: "string",
    description: "Energy site id (digits, e.g. 1234567890). Optional: falls back to TESLA_DEFAULT_ENERGY_SITE_ID or the only energy site on the account (see list_energy_sites).",
  },
} as const;

export const PRODUCT_FIELDS = [
  "site_name", "resource_type", "percentage_charged", "energy_left", "total_pack_energy", "battery_power",
  "storm_mode_enabled", "backup_capable",
] as const;

export const LIVE_STATUS_FIELDS = [
  "solar_power", "battery_power", "load_power", "grid_power", "generator_power", "grid_services_power",
  "percentage_charged", "energy_left", "total_pack_energy", "backup_capable", "grid_status", "island_status",
  "grid_services_active", "storm_mode_active",
] as const;

export const WALL_CONNECTOR_FIELDS = [
  "din", "vin", "wall_connector_state", "wall_connector_fault_state", "wall_connector_power", "ocpp_status",
  "powershare_session_state",
] as const;

export const SITE_INFO_FIELDS = [
  "site_name", "backup_reserve_percent", "default_real_mode", "installation_date", "installation_time_zone",
  "version", "battery_count", "nameplate_power", "nameplate_energy", "max_site_meter_power_ac",
  "min_site_meter_power_ac", "vpp_backup_reserve_percent",
] as const;

export const SITE_COMPONENT_FIELDS = [
  "battery", "solar", "grid", "backup", "load_meter", "storm_mode_capable", "off_grid_vehicle_charging_reserve_supported",
  "customer_preferred_export_rule", "disallow_charge_from_grid_with_solar_installed", "battery_type", "solar_type",
] as const;

export const USER_SETTINGS_FIELDS = ["storm_mode_enabled", "off_grid_vehicle_charging_enabled", "sync_grid_alert_enabled"] as const;

const SCOPE_HINT = `Energy tools need the ${ENERGY_SCOPE} scope. Re-run the auth helper with energy enabled (node scripts/auth-helper.mjs url --energy) and sign in once more.`;

/** Turn a 403 into a clear missing-scope refusal; rethrow everything else. */
async function withScopeHint<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FleetApiError && e.info.status === 403) {
      throw new LocalRefusal("missing_energy_scope", "Tesla refused the energy request (403): the token probably lacks the energy scope.", SCOPE_HINT);
    }
    throw e;
  }
}

// ---- calendar_history query validation (bounded, no unbounded history pulls) ----

export const HISTORY_KINDS = ["energy", "backup"] as const;
export const HISTORY_PERIODS = ["day", "week", "month", "year"] as const;
/** Max days between start_date and end_date per period. */
export const MAX_SPAN_DAYS: Record<(typeof HISTORY_PERIODS)[number], number> = { day: 31, week: 92, month: 366, year: 366 };
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "+HH:MM"/"-HH:MM" offset of tz at local midday on date (DST-correct for that day). */
export function tzOffset(date: string, tz: string): string {
  const probe = new Date(`${date}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

function todayIn(tz: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type HistoryQuery = { kind: string; period: string; start_date: string; end_date: string; time_zone: string };

/** Validate and build a bounded calendar_history query. Throws LocalRefusal (nothing sent) on bad input. */
export function buildHistoryQuery(args: ToolArgs, now: Date = new Date()): HistoryQuery {
  const kind = typeof args.kind === "string" ? args.kind : "energy";
  if (!(HISTORY_KINDS as readonly string[]).includes(kind)) throw new LocalRefusal("bad_history_args", "kind must be energy or backup.");
  const period = typeof args.period === "string" ? args.period : "day";
  if (!(HISTORY_PERIODS as readonly string[]).includes(period)) throw new LocalRefusal("bad_history_args", "period must be day, week, month or year.");
  const tz = typeof args.time_zone === "string" && args.time_zone.trim() ? args.time_zone.trim() : "UTC";
  if (!validTimeZone(tz)) throw new LocalRefusal("bad_history_args", "time_zone must be an IANA zone such as America/New_York.");
  const end = typeof args.end_date === "string" && args.end_date.trim() ? args.end_date.trim() : todayIn(tz, now);
  const start = typeof args.start_date === "string" && args.start_date.trim() ? args.start_date.trim() : end;
  for (const d of [start, end]) {
    if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
      throw new LocalRefusal("bad_history_args", "start_date and end_date must be YYYY-MM-DD.");
    }
  }
  const span = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;
  if (span < 0) throw new LocalRefusal("bad_history_args", "start_date must not be after end_date.");
  const max = MAX_SPAN_DAYS[period as keyof typeof MAX_SPAN_DAYS];
  if (span > max) throw new LocalRefusal("bad_history_args", `Range too long for period=${period}: at most ${max} days; nothing was sent.`);
  if (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${todayIn(tz, now)}T00:00:00Z`) > DAY_MS) {
    throw new LocalRefusal("bad_history_args", "end_date is in the future.");
  }
  return {
    kind,
    period,
    start_date: `${start}T00:00:00${tzOffset(start, tz)}`,
    end_date: `${end}T23:59:59${tzOffset(end, tz)}`,
    time_zone: tz,
  };
}

const SERIES_CAP = 400;
const EVENTS_CAP = 100;

/** Sum every numeric field across the time series (Wh). */
export function sumSeries(series: Array<Record<string, unknown>>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const e of series) {
    for (const [k, v] of Object.entries(e)) if (typeof v === "number" && Number.isFinite(v)) totals[k] = (totals[k] ?? 0) + v;
  }
  for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 100) / 100;
  return totals;
}

function siteHandler(fn: (siteId: string, args: ToolArgs, ctx: ToolContext) => Promise<Record<string, unknown>>) {
  return (args: ToolArgs, ctx: ToolContext) => withScopeHint(async () => fn(await ctx.fleet.resolveSiteId(args.energy_site_id), args, ctx));
}

export const ENERGY_TOOLS: ToolDef[] = [
  {
    kind: "read",
    tool: {
      name: "list_energy_sites",
      description: `Energy products on the account (Powerwall / solar): energy_site_id, name, type, battery % (GET /api/1/products; vehicles filtered out). Needs ${ENERGY_SCOPE}. Read-only.`,
      inputSchema: { type: "object", properties: {} },
    },
    handler: (_a, ctx) => withScopeHint(async () => {
      const sites = await ctx.fleet.listEnergySites(true);
      return {
        ok: true,
        sites: sites.map((s) => ({ energy_site_id: String(s.energy_site_id), ...pick(s, PRODUCT_FIELDS), components: pick(s.components, ["battery", "solar", "grid"]) })),
        note: sites.length ? undefined : `No energy sites returned. If you have one, the token probably lacks ${ENERGY_SCOPE}. ${SCOPE_HINT}`,
      };
    }),
  },
  {
    kind: "read",
    tool: {
      name: "get_energy_live_status",
      description: `Live site power flows (W): solar, battery, home load, grid, generator; battery %, grid/island status, storm watch, plus Wall Connector state and power from the site's wall_connectors list. One billable data call (cached 60 s). Needs ${ENERGY_SCOPE}. Read-only; do not poll.`,
      inputSchema: { type: "object", properties: { ...SITE_PROP } },
    },
    handler: siteHandler(async (siteId, _a, ctx) => {
      const { data, ageSec } = await ctx.fleet.energyLiveStatus(siteId);
      const wcs = Array.isArray(data.wall_connectors) ? (data.wall_connectors as unknown[]) : [];
      return {
        ok: true,
        energy_site_id: siteId,
        servedFromMemorySec: ageSec,
        timestamp: typeof data.timestamp === "string" ? data.timestamp : undefined,
        unit: "W (power), Wh (energy)",
        ...pick(data, LIVE_STATUS_FIELDS),
        wall_connectors: wcs.map((w) => pick(w, WALL_CONNECTOR_FIELDS)),
      };
    }),
  },
  {
    kind: "read",
    tool: {
      name: "get_energy_site_info",
      description: `Site configuration: backup reserve %, operation mode, storm watch enabled, export rule, grid charging, battery count, nameplate power/energy, firmware, installation time zone. One billable data call (cached 10 min). Needs ${ENERGY_SCOPE}. Read-only (changing settings is not supported).`,
      inputSchema: { type: "object", properties: { ...SITE_PROP } },
    },
    handler: siteHandler(async (siteId, _a, ctx) => {
      const { data, ageSec } = await ctx.fleet.energySiteInfo(siteId);
      const comps = (data.components ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        energy_site_id: siteId,
        servedFromMemorySec: ageSec,
        ...pick(data, SITE_INFO_FIELDS),
        user_settings: pick(data.user_settings, USER_SETTINGS_FIELDS),
        components: pick(comps, SITE_COMPONENT_FIELDS),
        wallConnectorCount: Array.isArray(comps.wall_connectors) ? (comps.wall_connectors as unknown[]).length : undefined,
      };
    }),
  },
  {
    kind: "read",
    tool: {
      name: "get_energy_history",
      description: `Energy totals (kind=energy: solar, home, grid import/export, battery charge/discharge, Wh) or backup events (kind=backup) for a bounded date range. period day (max 31 days), week (92), month/year (366). Dates YYYY-MM-DD in time_zone (default UTC; pass the site's zone, e.g. America/New_York). Default range: today. Returns totals; include_series=true adds the time series (capped). One billable data call (cached 5 min). Needs ${ENERGY_SCOPE}.`,
      inputSchema: {
        type: "object",
        properties: {
          ...SITE_PROP,
          kind: { type: "string", enum: [...HISTORY_KINDS], description: "Default energy." },
          period: { type: "string", enum: [...HISTORY_PERIODS], description: "Default day." },
          start_date: { type: "string", description: "YYYY-MM-DD (default: end_date)." },
          end_date: { type: "string", description: "YYYY-MM-DD (default: today in time_zone)." },
          time_zone: { type: "string", description: "IANA zone, default UTC." },
          include_series: { type: "boolean", description: "Also return the time series (energy) or event list (backup), capped." },
        },
      },
    },
    handler: (args, ctx) => withScopeHint(async () => {
      const q = buildHistoryQuery(args); // validate before any network call
      const siteId = await ctx.fleet.resolveSiteId(args.energy_site_id);
      const { data, ageSec } = await ctx.fleet.energyHistory(siteId, q);
      const base = { ok: true, energy_site_id: siteId, servedFromMemorySec: ageSec, query: q };
      if (q.kind === "backup") {
        const events = Array.isArray(data.events) ? (data.events as Array<Record<string, unknown>>) : [];
        return {
          ...base,
          total_events: typeof data.total_events === "number" ? data.total_events : events.length,
          totalDurationSec: Math.round(events.reduce((a, e) => a + (typeof e.duration === "number" ? e.duration : 0), 0) / 1000),
          events: args.include_series === true ? events.slice(0, EVENTS_CAP).map((e) => pick(e, ["timestamp", "duration"])) : undefined,
        };
      }
      const series = Array.isArray(data.time_series) ? (data.time_series as Array<Record<string, unknown>>) : [];
      return {
        ...base,
        unit: "Wh",
        entries: series.length,
        first: series[0]?.timestamp,
        last: series[series.length - 1]?.timestamp,
        totals: sumSeries(series),
        series: args.include_series === true ? series.slice(0, SERIES_CAP) : undefined,
        seriesTruncated: args.include_series === true && series.length > SERIES_CAP ? true : undefined,
      };
    }),
  },
];
