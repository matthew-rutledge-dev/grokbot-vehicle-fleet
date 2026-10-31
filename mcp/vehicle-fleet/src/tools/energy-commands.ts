/**
 * Energy-site setting commands (Powerwall). Sent directly to the Fleet API
 * (POST /api/1/energy_sites/{id}/...), unsigned; no command proxy is needed (verified live).
 * Same gates as vehicle commands: hidden and refused unless read-only is explicitly
 * off, confirm=true + user_request, TESLA_FLEET_DRY_RUN honoured, no retries.
 * Scope: energy_cmds.
 */
import { FleetApiError, LocalRefusal } from "../errors.js";
import { ENERGY_COMMAND_TIMEOUT_MS } from "../fleet.js";
import type { ToolArgs, ToolContext } from "../context.js";
import { bad, bool, classifySendFailure, int, requireIntent, scopeHint } from "./commands.js";
import { SITE_PROP } from "./energy.js";
import { CONFIRM_PROPS } from "./schema.js";
import type { ToolDef } from "./types.js";

export const ENERGY_CMD_SCOPE = "energy_cmds";
export const OPERATION_MODES = ["self_consumption", "autonomous"] as const;
export const EXPORT_RULES = ["pv_only", "battery_ok", "never"] as const;

type EnergySpec = {
  name: string;
  path: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  build: (a: ToolArgs) => Record<string, unknown>;
  /**
   * Optional send-time check, run only for a confirmed live send (never for previews or
   * TESLA_FLEET_DRY_RUN). May throw LocalRefusal (nothing sent), return `skip` (a no-op
   * result, nothing sent) or `note` (merged into the send result).
   */
  precheck?: (siteId: string, body: Record<string, unknown>, ctx: ToolContext, deadline: number) => Promise<{ skip?: Record<string, unknown>; note?: Record<string, unknown> }>;
  /** Extra billable reads made by `precheck` and `readBack`, shown in previews. */
  extraReads?: string;
  /**
   * Optional post-send read-back, run only after Tesla accepted a confirmed live send. Never
   * resends; its fields are merged into the success result.
   */
  readBack?: (siteId: string, body: Record<string, unknown>, ctx: ToolContext, previous: unknown, deadline: number) => Promise<Record<string, unknown>>;
  /**
   * Overall time budget (ms from the start of a confirmed live call) for specs with extra reads,
   * so the whole call finishes inside the MCP client's tool timeout. See OFF_GRID_TOTAL_BUDGET_MS.
   */
  budgetMs?: number;
};

export const OFF_GRID_RESERVE_FIELD = "off_grid_vehicle_charging_reserve_percent";
/**
 * Allowed off-grid vehicle charging reserve: 10-95 %. Tesla's Powerwall 3 Device Setup Guide
 * (energylibrary.tesla.com, "Optional: Adjust Frequency Overrides" -> Frequency-Based Load Shed)
 * calls it the same setting as the app's vehicle-charging-during-outage threshold and gives
 * "between 10% and 95%". A live send of 96 was rejected with HTTP 400 "Invalid off grid vehicle
 * charging reserve values". Tesla documents no step size; any other rejection is
 * surfaced as invalid_value with Tesla's message.
 */
export const OFF_GRID_RESERVE_MIN = 10;
export const OFF_GRID_RESERVE_MAX = 95;

/**
 * set_off_grid_vehicle_charging_reserve send-time check: one fresh site_info read.
 * - components.off_grid_vehicle_charging_reserve_supported === false: refused (not_supported).
 * - top-level off_grid_vehicle_charging_reserve_percent equal to the request: no-op, nothing sent.
 * - read failed, or the value is absent/non-numeric: sent anyway (the user confirmed), marked
 *   precheck "unavailable" with precheckReason "read_failed" or "value_absent".
 * - read failed with login_required / no_refresh_token: the send would fail too, so that error is
 *   returned and nothing is sent.
 * - the read is capped at OFF_GRID_PRECHECK_TIMEOUT_MS and leaves room for the send; with no room
 *   for it at all it is skipped (precheck "unavailable", precheckReason "time_budget").
 */
async function offGridPrecheck(siteId: string, body: Record<string, unknown>, ctx: ToolContext, deadline: number) {
  let data: Record<string, unknown>;
  const timeoutMs = Math.min(OFF_GRID_PRECHECK_TIMEOUT_MS, deadline - ENERGY_COMMAND_TIMEOUT_MS - ctx.fleet.clock());
  if (timeoutMs < OFF_GRID_MIN_READ_MS) return { note: { precheck: "unavailable", precheckReason: "time_budget" } };
  try {
    data = (await ctx.fleet.energySiteInfo(siteId, true, timeoutMs)).data;
  } catch (e) {
    const code = e instanceof LocalRefusal ? e.code : e instanceof FleetApiError ? e.info.code : undefined;
    if (code === "login_required" || code === "no_refresh_token") throw e;
    return { note: { precheck: "unavailable", precheckReason: "read_failed" } };
  }
  const comps = isObj(data.components) ? data.components : {};
  if (comps.off_grid_vehicle_charging_reserve_supported === false) {
    throw new LocalRefusal("not_supported", "This energy site reports off-grid vehicle charging reserve as unsupported; nothing was sent.");
  }
  const current = data[OFF_GRID_RESERVE_FIELD];
  if (typeof current !== "number" || !Number.isFinite(current)) return { note: { precheck: "unavailable", precheckReason: "value_absent" } };
  if (current === body[OFF_GRID_RESERVE_FIELD]) {
    return { skip: { ok: true, sent: false, noop: true, [OFF_GRID_RESERVE_FIELD]: current, message: "Already set to this value; nothing was sent." } };
  }
  return { note: { precheck: "ok", previous: current } };
}

/** Off-grid reserve read-back: up to this many fresh site_info reads, this far apart (~15 s in all). */
export const OFF_GRID_READBACK_TRIES = 3;
export const OFF_GRID_READBACK_DELAY_MS = 5_000;
/**
 * Time limits for set_off_grid_vehicle_charging_reserve, so a confirmed call always returns inside
 * a 60 s MCP client tool timeout (the common default):
 * - the whole call (site lookup, pre-read, send, read-back) gets OFF_GRID_TOTAL_BUDGET_MS;
 * - the pre-read is capped at OFF_GRID_PRECHECK_TIMEOUT_MS and must leave room for the send
 *   (ENERGY_COMMAND_TIMEOUT_MS); if the time before the send already used too much, nothing is sent
 *   (budget_exhausted);
 * - each read-back read is capped at OFF_GRID_READBACK_TIMEOUT_MS, and a read-back read (with its
 *   pause) only starts if it fits in what is left; otherwise the read-back stops and reports
 *   "pending" (accepted, not yet confirmed). Never resent.
 * Worst case: 15 s site lookup + 10 s pre-read + 30 s send = 55 s, and the read-back only uses
 * what is left of the 55 s.
 */
export const OFF_GRID_TOTAL_BUDGET_MS = 55_000;
export const OFF_GRID_PRECHECK_TIMEOUT_MS = 10_000;
export const OFF_GRID_READBACK_TIMEOUT_MS = 5_000;
/** A read is not started with less time than this left. */
export const OFF_GRID_MIN_READ_MS = 1_000;

/** A finite number, or undefined for anything else (absent, null, string, NaN, Infinity, objects). */
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * After Tesla accepts an off-grid reserve change, the site can keep reporting the old value for a
 * while (seen in a field test: accepted, immediate read-back still old). Re-read a few times and
 * report honestly, never resending:
 * - "confirmed": the site reports the requested value.
 * - "pending": still the previous value (or no value) after the last read, or the time budget ran
 *   out before the reads were done (readBackReason "time_budget"); accepted, not yet visible.
 * - "mismatch": a finite value that is neither the requested nor the previous one (only when the
 *   pre-read gave a previous value; without one, a different value stays "pending").
 * - "unavailable": every read-back failed or returned something that is not a finite number
 *   (a string, NaN, Infinity, an object); such values are never echoed.
 */
async function offGridReadBack(siteId: string, body: Record<string, unknown>, ctx: ToolContext, previous: unknown, deadline: number): Promise<Record<string, unknown>> {
  const want = body[OFF_GRID_RESERVE_FIELD];
  const prev = finite(previous);
  let last: number | undefined;
  let reads = 0;
  let unusable = 0;
  let outOfTime = false;
  for (let i = 0; i < OFF_GRID_READBACK_TRIES; i++) {
    if (deadline - ctx.fleet.clock() < OFF_GRID_READBACK_DELAY_MS + OFF_GRID_MIN_READ_MS) {
      outOfTime = true;
      break;
    }
    await ctx.fleet.pause(OFF_GRID_READBACK_DELAY_MS);
    const timeoutMs = Math.min(OFF_GRID_READBACK_TIMEOUT_MS, deadline - ctx.fleet.clock());
    if (timeoutMs < OFF_GRID_MIN_READ_MS) {
      outOfTime = true;
      break;
    }
    reads++;
    let raw: unknown;
    try {
      raw = (await ctx.fleet.energySiteInfo(siteId, true, timeoutMs)).data[OFF_GRID_RESERVE_FIELD];
    } catch {
      unusable++;
      continue;
    }
    if (raw === undefined || raw === null) continue; // value absent: keep waiting (pending)
    const v = finite(raw);
    if (v === undefined) {
      unusable++; // present but not a finite number: never echoed, treated like a failed read
      continue;
    }
    last = v;
    if (v === want) return { readBack: "confirmed", readBackValue: v, readBackReads: reads };
    if (prev !== undefined && v !== prev) {
      return {
        readBack: "mismatch", readBackValue: v, readBackReads: reads,
        readBackMessage: `Tesla accepted the change, but the site now reports ${v}, not the requested ${String(want)}. Tell the user; do not resend without asking.`,
      };
    }
  }
  if (outOfTime) {
    return {
      readBack: "pending", readBackReason: "time_budget", readBackValue: last ?? null, readBackReads: reads,
      readBackMessage: `Tesla accepted the change; the read-back stopped after ${reads} read${reads === 1 ? "" : "s"} to stay inside the tool time limit${last === undefined ? "" : `, and the site still reported ${last}`}. Check again later with get_energy_site_info. Not resent.`,
    };
  }
  const waited = Math.round((OFF_GRID_READBACK_TRIES * OFF_GRID_READBACK_DELAY_MS) / 1000);
  if (reads > 0 && unusable === reads) {
    return { readBack: "unavailable", readBackReads: reads, readBackMessage: "Tesla accepted the change, but the read-back failed or returned no usable number; check later with get_energy_site_info." };
  }
  return {
    readBack: "pending", readBackValue: last ?? null, readBackReads: reads,
    readBackMessage: `Tesla accepted the change, but after about ${waited} s the site still reports ${last === undefined ? "no value" : String(last)}. Settings can take a while to show; check again later with get_energy_site_info. Not resent.`,
  };
}

const SPECS: EnergySpec[] = [
  {
    name: "set_backup_reserve", path: "backup",
    description: "Set the Powerwall backup reserve percent (0-100): the share kept for outages.",
    properties: { backup_reserve_percent: { type: "integer", minimum: 0, maximum: 100 } },
    required: ["backup_reserve_percent"],
    build: (a) => ({ backup_reserve_percent: int(a.backup_reserve_percent, "backup_reserve_percent", 0, 100) }),
  },
  {
    name: "set_off_grid_vehicle_charging_reserve", path: "off_grid_vehicle_charging_reserve",
    description: "Set the Powerwall off-grid vehicle charging reserve percent (whole number 10-95, the range in Tesla's installer docs; Tesla rejects others, e.g. 96): the share of Powerwall charge kept back from vehicle charging during a grid outage. Before sending, one fresh site_info read: refused (not_supported) when the site reports the feature unsupported; nothing is sent when the site already reports this value (noop). After Tesla accepts, re-reads site_info up to 3 times over about 15 s and reports readBack: confirmed, pending (accepted but the site still shows the old value; the Powerwall can report it late, or the 55 s time limit ran out: readBackReason time_budget), mismatch, or unavailable. Never resends.",
    properties: { [OFF_GRID_RESERVE_FIELD]: { type: "integer", minimum: OFF_GRID_RESERVE_MIN, maximum: OFF_GRID_RESERVE_MAX } },
    required: [OFF_GRID_RESERVE_FIELD],
    build: (a) => ({ [OFF_GRID_RESERVE_FIELD]: int(a[OFF_GRID_RESERVE_FIELD], OFF_GRID_RESERVE_FIELD, OFF_GRID_RESERVE_MIN, OFF_GRID_RESERVE_MAX) }),
    precheck: offGridPrecheck,
    readBack: offGridReadBack,
    budgetMs: OFF_GRID_TOTAL_BUDGET_MS,
    extraReads: `1 site_info read before + up to ${OFF_GRID_READBACK_TRIES} after (about ${(OFF_GRID_READBACK_TRIES * OFF_GRID_READBACK_DELAY_MS) / 1000} s read-back)`,
  },
  {
    name: "set_operation_mode", path: "operation",
    description: "Set the site operation mode: self_consumption (Self-Powered) or autonomous (Time-Based Control).",
    properties: { default_real_mode: { type: "string", enum: [...OPERATION_MODES] } },
    required: ["default_real_mode"],
    build: (a) => {
      if (!(OPERATION_MODES as readonly unknown[]).includes(a.default_real_mode)) bad(`default_real_mode must be ${OPERATION_MODES.join(" or ")}`);
      return { default_real_mode: a.default_real_mode };
    },
  },
  {
    name: "set_storm_mode", path: "storm_mode",
    description: "Turn Storm Watch on or off (charges to full ahead of severe weather alerts).",
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"],
    build: (a) => ({ enabled: bool(a.enabled, "enabled") }),
  },
  {
    name: "set_grid_import_export", path: "grid_import_export",
    description: "Grid charging and export rule. disallow_charge_from_grid_with_solar_installed=true stops grid charging; customer_preferred_export_rule: pv_only (solar only), battery_ok (solar and battery) or never. Pass at least one.",
    properties: {
      disallow_charge_from_grid_with_solar_installed: { type: "boolean" },
      customer_preferred_export_rule: { type: "string", enum: [...EXPORT_RULES] },
    },
    build: (a) => {
      const body: Record<string, unknown> = {};
      if (a.disallow_charge_from_grid_with_solar_installed !== undefined) {
        body.disallow_charge_from_grid_with_solar_installed = bool(a.disallow_charge_from_grid_with_solar_installed, "disallow_charge_from_grid_with_solar_installed");
      }
      if (a.customer_preferred_export_rule !== undefined) {
        if (!(EXPORT_RULES as readonly unknown[]).includes(a.customer_preferred_export_rule)) bad(`customer_preferred_export_rule must be ${EXPORT_RULES.join(", ")}`);
        body.customer_preferred_export_rule = a.customer_preferred_export_rule;
      }
      if (!Object.keys(body).length) bad("pass disallow_charge_from_grid_with_solar_installed and/or customer_preferred_export_rule");
      return body;
    },
  },
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Success = an empty body, or an object result: {} (what live calls return), {response: {}},
 * {code: 2xx, message} (docs), or
 * another plain result object, optionally inside the {response: ...} envelope. Failure =
 * an `error` key, result === false (with reason), a code >= 400, or a non-object body.
 * The request reached Tesla in every case, so sent is true (rejected) or "unknown".
 */
export type RawShape = "empty" | "object" | "response-wrapped" | "null" | "string" | "array" | "other";

/** Debug-safe description of the response body: its shape only, never values. */
export function rawShapeOf(raw: unknown): RawShape {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) return "empty";
  if (raw === null) return "null";
  if (typeof raw === "string") return "string";
  if (Array.isArray(raw)) return "array";
  if (isObj(raw)) return "response" in raw ? "response-wrapped" : "object";
  return "other";
}

export function interpretEnergyResponse(raw: unknown):
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; failure: Record<string, unknown> } {
  // An empty (0-byte or whitespace-only) 2xx body counts as success, like {} (0.3.0 behaviour).
  if (rawShapeOf(raw) === "empty") return { ok: true, result: {} };
  if (!isObj(raw)) {
    return { ok: false, failure: { sent: "unknown", code: "state_unknown", message: `Unexpected ${raw === null ? "null" : typeof raw} response body; the change may or may not have applied.` } };
  }
  if ("error" in raw) {
    const err = raw.error, desc = raw.error_description;
    return { ok: false, failure: { sent: true, code: "rejected", reason: typeof err === "string" ? err : "error", message: typeof desc === "string" ? desc : "Tesla returned an error; the change was not applied." } };
  }
  const r = "response" in raw ? raw.response : raw;
  if (!isObj(r)) {
    return { ok: false, failure: { sent: "unknown", code: "state_unknown", message: "Unexpected response shape; the change may or may not have applied." } };
  }
  if (r.result === false) {
    return { ok: false, failure: { sent: true, code: "rejected", reason: typeof r.reason === "string" ? r.reason : "", message: `Rejected by the site: ${typeof r.reason === "string" && r.reason ? r.reason : "no reason given"}` } };
  }
  if (typeof r.code === "number" && r.code >= 400) {
    return { ok: false, failure: { sent: true, code: "rejected", reason: String(r.code), message: typeof r.message === "string" ? r.message : "Rejected by the site" } };
  }
  return { ok: true, result: r };
}

/** Site id without a network call (dry-runs). */
function offlineSite(args: ToolArgs, ctx: ToolContext): string | undefined {
  const raw = typeof args.energy_site_id === "string" && args.energy_site_id.trim() ? args.energy_site_id.trim() : ctx.config.defaultEnergySiteId;
  if (raw === undefined) return undefined;
  if (!/^\d{1,20}$/.test(raw)) throw new LocalRefusal("bad_site_id", "energy_site_id must be a string of digits (e.g. \"1234567890\").");
  return raw;
}

function energyTool(spec: EnergySpec): ToolDef {
  return {
    kind: "command",
    tool: {
      name: spec.name,
      description: `${spec.description} Energy-site command sent to the Fleet API (scope ${ENERGY_CMD_SCOPE}). Without confirm=true returns a dry-run. Read the result back with get_energy_site_info.`,
      inputSchema: {
        type: "object",
        properties: { ...SITE_PROP, ...spec.properties, ...CONFIRM_PROPS },
        ...(spec.required ? { required: spec.required } : {}),
      },
    },
    handler: async (args, ctx) => {
      if (args.energy_site_id !== undefined && typeof args.energy_site_id !== "string") {
        throw new LocalRefusal("bad_site_id", "energy_site_id must be a string of digits (e.g. \"1234567890\"), not a number.");
      }
      const body = spec.build(args); // validate before anything else
      const endpoint = `POST /api/1/energy_sites/{energy_site_id}/${spec.path}`;
      if (args.confirm !== true) {
        return {
          dryRun: true, sent: false, command: spec.name, endpoint, body,
          estimatedBillableCalls: `1 command${spec.extraReads ? ` + ${spec.extraReads}` : ""} (+1 product list if no site id is set)`,
          toSend: "Ask the user to confirm, then call again with confirm=true and user_request.",
        };
      }
      requireIntent(args);
      if (ctx.config.dryRun) {
        const site = offlineSite(args, ctx);
        return {
          dryRun: true, dryRunMode: "TESLA_FLEET_DRY_RUN", sent: false, command: spec.name,
          wouldSend: [{ method: "POST", url: `<fleet base>/api/1/energy_sites/${site ?? "{energy_site_id}"}/${spec.path}`, body }],
          note: "Validated only; no network call was made.",
        };
      }
      const deadline = ctx.fleet.clock() + (spec.budgetMs ?? Number.POSITIVE_INFINITY);
      const siteId = await ctx.fleet.resolveSiteId(args.energy_site_id);
      let note: Record<string, unknown> = {};
      if (spec.precheck) {
        const pre = await spec.precheck(siteId, body, ctx, deadline);
        if (pre.skip) return { command: spec.name, ...pre.skip };
        note = pre.note ?? {};
      }
      if (deadline - ctx.fleet.clock() < ENERGY_COMMAND_TIMEOUT_MS) {
        throw new LocalRefusal("budget_exhausted", `Nothing was sent: the steps before the send took too long to leave room for it inside the tool time limit (${Math.round((spec.budgetMs ?? 0) / 1000)} s). Try again.`);
      }
      try {
        const raw = await ctx.fleet.energyCommand(siteId, spec.path, body);
        const outcome = interpretEnergyResponse(raw);
        const rawShape = rawShapeOf(raw);
        if (outcome.ok) {
          const rb = spec.readBack ? await spec.readBack(siteId, body, ctx, note.previous, deadline) : {};
          return { ok: true, sent: true, command: spec.name, ...note, result: outcome.result, rawShape, ...rb, readBackWith: "get_energy_site_info" };
        }
        return { ok: false, command: spec.name, ...note, ...outcome.failure, rawShape, hint: "Read the current value with get_energy_site_info before doing anything else; it was not retried." };
      } catch (e) {
        if (e instanceof FleetApiError && e.info.status === 403) {
          throw new FleetApiError({ ...e.info, code: e.info.code === "missing_scope" ? "missing_energy_cmds_scope" : e.info.code, hint: e.info.code === "missing_scope" ? scopeHint(ENERGY_CMD_SCOPE) : e.info.hint });
        }
        const f = classifySendFailure(e, "fleet");
        if (f?.kind === "unknown") {
          return { ok: false, sent: "unknown", command: spec.name, code: "state_unknown", cause: f.detail, message: `The change may or may not have applied (${f.detail}). It was not retried; do not resend blindly.`, hint: "Read it back with get_energy_site_info." };
        }
        if (f?.kind === "not_sent") return { ok: false, sent: false, command: spec.name, code: f.code, error: f.message };
        throw e;
      }
    },
  };
}

export const ENERGY_COMMAND_TOOLS: ToolDef[] = SPECS.map(energyTool);
