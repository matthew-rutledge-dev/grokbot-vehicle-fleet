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
};

const SPECS: EnergySpec[] = [
  {
    name: "set_backup_reserve", path: "backup",
    description: "Set the Powerwall backup reserve percent (0-100): the share kept for outages.",
    properties: { backup_reserve_percent: { type: "integer", minimum: 0, maximum: 100 } },
    required: ["backup_reserve_percent"],
    build: (a) => ({ backup_reserve_percent: int(a.backup_reserve_percent, "backup_reserve_percent", 0, 100) }),
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
          estimatedBillableCalls: "1 command (+1 product list if no site id is set)",
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
      try {
        const r = await ctx.fleet.energyCommand(siteId, spec.path, body);
        const code = typeof r.code === "number" ? r.code : undefined;
        if (code !== undefined && code >= 400) {
          return { ok: false, sent: true, command: spec.name, code, message: typeof r.message === "string" ? r.message : "Rejected by the site" };
        }
        // Live responses are an empty object ({}); some docs show {code: 201, message: "Updated"}. Both are success.
        return { ok: true, sent: true, command: spec.name, result: r, readBackWith: "get_energy_site_info" };
      } catch (e) {
        if (e instanceof FleetApiError && e.info.status === 403) {
          throw new FleetApiError({ ...e.info, code: e.info.code === "missing_scope" ? "missing_energy_cmds_scope" : e.info.code, hint: e.info.code === "missing_scope" ? scopeHint(ENERGY_CMD_SCOPE) : e.info.hint });
        }
        const f = classifySendFailure(e);
        if (f?.kind === "unknown") {
          return { ok: false, sent: "unknown", command: spec.name, code: "state_unknown", cause: f.detail, message: `The change may or may not have applied (${f.detail}). It was not retried; do not resend blindly.`, hint: "Read it back with get_energy_site_info." };
        }
        if (f?.kind === "not_sent") return { ok: false, sent: false, command: spec.name, code: "fleet_api_unreachable", error: f.message.replace("the command proxy", "the Fleet API").replace(" Check TESLA_COMMAND_PROXY_CA_CERT and the certificate's host name.", "") };
        throw e;
      }
    },
  };
}

export const ENERGY_COMMAND_TOOLS: ToolDef[] = SPECS.map(energyTool);
