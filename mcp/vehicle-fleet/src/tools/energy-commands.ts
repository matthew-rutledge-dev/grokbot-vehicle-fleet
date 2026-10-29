/**
 * Energy-site setting commands (Powerwall). Sent directly to the Fleet API
 * (POST /api/1/energy_sites/{id}/...), unsigned; no command proxy is needed (verified live).
 * Same gates as vehicle commands: hidden and refused unless read-only is explicitly
 * off, confirm=true + user_request, TESLA_FLEET_DRY_RUN honoured, no retries.
 * Scope: energy_cmds.
 */
import { FleetApiError, LocalRefusal } from "../errors.js";
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
  precheck?: (siteId: string, body: Record<string, unknown>, ctx: ToolContext) => Promise<{ skip?: Record<string, unknown>; note?: Record<string, unknown> }>;
  /** Extra billable reads made by `precheck`, shown in previews. */
  extraReads?: string;
};

export const OFF_GRID_RESERVE_FIELD = "off_grid_vehicle_charging_reserve_percent";

/**
 * set_off_grid_vehicle_charging_reserve send-time check: one fresh site_info read.
 * - components.off_grid_vehicle_charging_reserve_supported === false: refused (not_supported).
 * - top-level off_grid_vehicle_charging_reserve_percent equal to the request: no-op, nothing sent.
 * - read failed, or the value is absent/non-numeric: sent anyway (the user confirmed), marked
 *   precheck "unavailable" with precheckReason "read_failed" or "value_absent".
 * - read failed with login_required / no_refresh_token: the send would fail too, so that error is
 *   returned and nothing is sent.
 */
async function offGridPrecheck(siteId: string, body: Record<string, unknown>, ctx: ToolContext) {
  let data: Record<string, unknown>;
  try {
    data = (await ctx.fleet.energySiteInfo(siteId, true)).data;
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
    description: "Set the Powerwall off-grid vehicle charging reserve percent (0-100): the share of Powerwall charge kept back from vehicle charging during a grid outage. Before sending, one fresh site_info read: refused (not_supported) when the site reports the feature unsupported; nothing is sent when the site already reports this value (noop).",
    properties: { [OFF_GRID_RESERVE_FIELD]: { type: "integer", minimum: 0, maximum: 100 } },
    required: [OFF_GRID_RESERVE_FIELD],
    build: (a) => ({ [OFF_GRID_RESERVE_FIELD]: int(a[OFF_GRID_RESERVE_FIELD], OFF_GRID_RESERVE_FIELD, 0, 100) }),
    precheck: offGridPrecheck,
    extraReads: "1 site_info read",
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
      const siteId = await ctx.fleet.resolveSiteId(args.energy_site_id);
      let note: Record<string, unknown> = {};
      if (spec.precheck) {
        const pre = await spec.precheck(siteId, body, ctx);
        if (pre.skip) return { command: spec.name, ...pre.skip };
        note = pre.note ?? {};
      }
      try {
        const raw = await ctx.fleet.energyCommand(siteId, spec.path, body);
        const outcome = interpretEnergyResponse(raw);
        const rawShape = rawShapeOf(raw);
        if (outcome.ok) return { ok: true, sent: true, command: spec.name, ...note, result: outcome.result, rawShape, readBackWith: "get_energy_site_info" };
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
