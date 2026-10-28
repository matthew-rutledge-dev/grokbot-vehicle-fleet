/** Read tools: no confirm, never wake the vehicle. */
import { configPresence } from "../config.js";
import { FleetApiError, LocalRefusal } from "../errors.js";
import { describeReadOnly } from "../readonly.js";
import { maskVin, roundCoord } from "../redact.js";
import type { ToolArgs, ToolContext } from "../context.js";
import {
  CHARGE_FIELDS, CHARGE_SCHEDULE_FIELDS, CLIMATE_FIELDS, CLOSURE_FIELDS, MEDIA_INFO_FIELDS, PRECONDITION_SCHEDULE_FIELDS,
  SECURITY_FIELDS, STATUS_FIELDS, TIRE_FIELDS,
  blockTimestamp, closureSummary, daysOf, hhmm, pick, securitySummary, statusSummary, tireSummary,
} from "./extract.js";
import { LIVE_PROP, VIN_PROP } from "./schema.js";
import type { ToolDef } from "./types.js";

export const RULES_SUMMARY = [
  "Read-only unless TESLA_FLEET_READ_ONLY is explicitly 0/false/no/off.",
  "Every command needs confirm=true plus user_request; without confirm you get a dry-run.",
  "Never send commands from routines, schedules, triggers, or on the agent's own initiative.",
  "HomeLink (garage/gate), windows, valet and other access commands: only when the person explicitly asks right now; never automated (no geofence or arrival triggers).",
  "Nothing wakes the vehicle except wake_vehicle (confirm-gated, costs a wake).",
  "Reads default to cached data; live reads only when the vehicle is already online.",
  "Do not poll. Every Fleet API response below 500 is billed.",
  "Vehicle commands go only through your signing proxy (HTTPS, optional CA pin); never directly. No automatic retries.",
  "Energy-site commands go directly to the Fleet API and need the energy_cmds scope.",
  "TESLA_FLEET_DRY_RUN=1 validates confirmed commands and returns the exact request without sending it.",
  "Location is on by default (opt out with TESLA_FLEET_ENABLE_LOCATION=0) and coarse (~1 km) unless precise is asked for.",
];

type Section = "charge" | "climate" | "closures" | "tires" | "status" | "security";
const ALL_SECTIONS: Section[] = ["charge", "climate", "closures", "tires", "status", "security"];
const SECTION_ENDPOINTS: Record<Section, string[]> = {
  charge: ["charge_state"],
  climate: ["climate_state"],
  closures: ["vehicle_state", "closures_state"],
  tires: ["vehicle_state"],
  status: ["vehicle_state"],
  security: ["vehicle_state"],
};

function shape(section: Section, data: Record<string, unknown>): Record<string, unknown> {
  switch (section) {
    case "charge": {
      const b = data.charge_state;
      return { timestamp: blockTimestamp(b), ...pick(b, CHARGE_FIELDS) };
    }
    case "climate": {
      const b = data.climate_state;
      return { timestamp: blockTimestamp(b), ...pick(b, CLIMATE_FIELDS) };
    }
    case "closures": {
      const merged = { ...pick(data.vehicle_state, CLOSURE_FIELDS), ...pick(data.closures_state, CLOSURE_FIELDS) };
      return { timestamp: blockTimestamp(data.vehicle_state), ...closureSummary(merged), raw: merged };
    }
    case "tires": {
      const f = pick(data.vehicle_state, TIRE_FIELDS);
      return { timestamp: blockTimestamp(data.vehicle_state), tires: tireSummary(f), unit: "bar (psi added)" };
    }
    case "status": {
      const f = pick(data.vehicle_state, STATUS_FIELDS);
      return { timestamp: blockTimestamp(data.vehicle_state), ...statusSummary(f) };
    }
    case "security": {
      const f = pick(data.vehicle_state, SECURITY_FIELDS);
      return { timestamp: blockTimestamp(data.vehicle_state), ...securitySummary(f) };
    }
  }
}

async function readSections(args: ToolArgs, ctx: ToolContext, sections: Section[]) {
  const vin = await ctx.fleet.resolveVin(args.vin);
  const live = args.live === true;
  let data: Record<string, unknown>;
  let ageSec: number;
  if (live) {
    await ctx.fleet.requireOnline(vin);
    const endpoints = [...new Set(sections.flatMap((s) => SECTION_ENDPOINTS[s]))];
    ({ data, ageSec } = await ctx.fleet.vehicleDataLive(vin, endpoints));
  } else {
    try {
      ({ data, ageSec } = await ctx.fleet.vehicleDataCached(vin));
    } catch (e) {
      if (e instanceof FleetApiError && [404, 412].includes(e.info.status)) {
        return {
          ok: false, vinLast4: vin.slice(-4), source: "cached", code: e.info.code,
          message: e.info.status === 404 ? "No cached data for this vehicle yet." : "This vehicle does not support cached data.",
          hint: "Call again with live=true if the vehicle is online (check get_vehicle_state); never wakes.",
        };
      }
      throw e;
    }
  }
  const out: Record<string, unknown> = {
    ok: true, vinLast4: vin.slice(-4), source: live ? "live" : "cached", servedFromMemorySec: ageSec,
  };
  for (const s of sections) out[s] = shape(s, data);
  return out;
}

const sectionTool = (name: string, section: Section, title: string): ToolDef => ({
  kind: "read",
  tool: {
    name,
    description: `${title}. Defaults to cached data (never wakes); live=true only when already online. No confirm needed.`,
    inputSchema: { type: "object", properties: { ...VIN_PROP, ...LIVE_PROP } },
  },
  handler: (args, ctx) => readSections(args, ctx, [section]),
});

export const READ_TOOLS: ToolDef[] = [
  {
    kind: "read",
    tool: {
      name: "describe_boundary",
      description: "Shows what this server will and will not do: read-only state, location on/off (on by default) and default precision, NHTSA recalls on/off, dry-run mode, proxy configured, which plugin variables are set (never values), token store status, billable calls this session (get_api_usage has monthly totals), and the safety rules. No network call.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async (_args, ctx) => ({
      readOnly: ctx.config.readOnly.readOnly,
      readOnlyStatus: describeReadOnly(ctx.config.readOnly),
      locationEnabled: ctx.config.locationEnabled,
      locationDefaultPrecision: ctx.config.locationPrecision,
      nhtsaRecallsEnabled: ctx.config.nhtsaEnabled,
      proxyConfigured: Boolean(ctx.config.proxyUrl),
      proxyCaConfigured: Boolean(ctx.config.proxyCaCertPath),
      regionConfigured: ctx.config.region ?? (ctx.config.baseUrl ? "custom base URL" : "auto-detect"),
      variables: configPresence(ctx.env),
      configProblems: ctx.config.problems,
      auth: ctx.tokens.status(),
      billableCallsThisSession: ctx.fleet.billableCalls,
      rules: RULES_SUMMARY,
      dryRunMode: ctx.config.dryRun,
      climateDefaults: ctx.config.climate,
      energy: "Energy sites (Powerwall/solar, Wall Connector via site live_status): reads need energy_device_data; settings commands (backup reserve, operation mode, storm mode, grid import/export) need energy_cmds and are hidden unless read-only is off.",
      experimental: {
        playVideoOnScreen: "EXPERIMENTAL command (hidden unless read-only is off): signed locally with the virtual key and sent via Fleet API signed_command; opens a URL on the car screen (video player or web browser, no auto-play); field-tested on one car only.",
        commandKeyConfigured: Boolean(ctx.config.commandKeyFile),
        videoHostAllowlistEntries: ctx.config.videoHostAllowlist.length,
        auditLog: "on (JSONL; full VIN for confirmed account cars, URL host + keyed path hash only)",
        signedExtrasEnabled: ctx.config.experimentalEnabled,
        signedExtras: "dashcam_save_clip and remote_boombox: listed only when read-only is off AND TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS is on.",
      },
      valet: {
        enabled: ctx.config.valetEnabled,
        pinConfigured: ctx.config.valetPinConfigured,
        rule: "set_valet_mode / reset_valet_pin: listed only when read-only is off AND TESLA_FLEET_ENABLE_VALET is on. The PIN comes only from TESLA_FLEET_VALET_PIN and is never shown.",
      },
    }),
  },
  {
    kind: "read",
    tool: {
      name: "get_api_usage",
      description: "LOCAL ESTIMATE of Fleet API usage and cost from calls made by THIS server only (not Home Assistant or other apps): this and last UTC month, per pricing category (data, command, wake; plus other = not priced, auth = not billed), responses <500 billable vs >=500 not billed, estimated USD before and after the monthly discount. The developer portal billing page is the source of truth. No network call.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async (_a, ctx) => {
      await ctx.usage.flush();
      return ctx.usage.report(ctx.config.rates);
    },
  },
  {
    kind: "read",
    tool: {
      name: "api_status",
      description: "Fleet API health (GET /status, unauthenticated; counted as other by get_api_usage).",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async (_a, ctx) => ({ ok: true, status: await ctx.fleet.apiStatus() }),
  },
  {
    kind: "read",
    tool: {
      name: "list_vehicles",
      description: "Vehicles on the account with connectivity state (online/asleep/offline). Does not wake anything.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async (_a, ctx) => {
      const list = await ctx.fleet.listVehicles();
      return {
        ok: true,
        vehicles: list.map((v) => ({ vin: v.vin, vinLast4: v.vin?.slice(-4), display_name: v.display_name, state: v.state })),
      };
    },
  },
  {
    kind: "read",
    tool: {
      name: "get_vehicle_state",
      description: "Connectivity state of one vehicle (online/asleep/offline). Cheap pre-check before live reads. Never wakes.",
      inputSchema: { type: "object", properties: { ...VIN_PROP } },
    },
    handler: async (args, ctx) => {
      const vin = await ctx.fleet.resolveVin(args.vin);
      const v = await ctx.fleet.getVehicle(vin, true);
      return { ok: true, vinLast4: vin.slice(-4), state: v?.state, display_name: v?.display_name };
    },
  },
  {
    kind: "read",
    tool: {
      name: "get_fleet_status",
      description: "Whether this app's virtual key is paired, whether signed commands are required, firmware, key count (POST fleet_status; cached 10 min).",
      inputSchema: { type: "object", properties: { ...VIN_PROP } },
    },
    handler: async (args, ctx) => {
      const vin = await ctx.fleet.resolveVin(args.vin);
      return { ok: true, vinLast4: vin.slice(-4), ...(await ctx.fleet.fleetStatus(vin)) };
    },
  },
  sectionTool("get_battery_charge", "charge", "Battery level, range, charge limit and charging state"),
  sectionTool("get_climate", "climate", "Cabin/outside temperature, climate on/off, set points, seat/wheel heat"),
  sectionTool("get_closures", "closures", "Locked state, doors, trunks/frunk, windows, sentry mode"),
  sectionTool("get_tires", "tires", "Tire pressures (TPMS, bar + psi), psi below the recommended cold pressure, and soft/hard warnings"),
  sectionTool("get_vehicle_status", "status", "Firmware version, software update available / downloading / installing (version, %), odometer (mi + km) and service mode"),
  sectionTool("get_security_status", "security", "Valet Mode on/off and whether a valet PIN is needed, Speed Limit Mode (active, limit, PIN set), and whether a HomeLink device is nearby (never the PIN itself)"),
  {
    kind: "read",
    tool: {
      name: "get_media_state",
      description: "Media now playing, playback status, source and volume (0 to audio_volume_max, usually 11; adjust_volume takes 0-10). Live only (cached data has no media): the vehicle must already be online; one billable data call; never wakes.",
      inputSchema: { type: "object", properties: { ...VIN_PROP } },
    },
    handler: async (args, ctx) => {
      const vin = await ctx.fleet.resolveVin(args.vin);
      await ctx.fleet.requireOnline(vin);
      const { data, ageSec } = await ctx.fleet.vehicleDataLive(vin, ["vehicle_state"]);
      const vs = (data.vehicle_state ?? {}) as Record<string, unknown>;
      const info = pick(vs.media_info ?? data.media_info, MEDIA_INFO_FIELDS);
      const state = pick(vs.media_state ?? data.media_state, ["remote_control_enabled"]);
      return {
        ok: true, vinLast4: vin.slice(-4), source: "live", servedFromMemorySec: ageSec,
        media: Object.keys(info).length ? info : "not reported (nothing playing, or not available on this car)",
        ...(Object.keys(state).length ? { remoteControlEnabled: state.remote_control_enabled } : {}),
      };
    },
  },
  {
    kind: "read",
    tool: {
      name: "get_schedules",
      description: "Charge schedules and preconditioning (departure) schedules saved in the car: name, days, start/end or departure time (HH:MM, car local time), on/off, one-time. Schedule locations are left out. Read-only: this server never changes schedules. Live only: the vehicle must already be online; one billable data call; never wakes.",
      inputSchema: { type: "object", properties: { ...VIN_PROP } },
    },
    handler: async (args, ctx) => {
      const vin = await ctx.fleet.resolveVin(args.vin);
      await ctx.fleet.requireOnline(vin);
      const { data, ageSec } = await ctx.fleet.vehicleDataLive(vin, ["charge_schedule_data", "preconditioning_schedule_data"]);
      const cs = (data.charge_schedule_data ?? {}) as Record<string, unknown>;
      const ps = (data.preconditioning_schedule_data ?? {}) as Record<string, unknown>;
      const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).slice(0, 50) : []);
      return {
        ok: true, vinLast4: vin.slice(-4), source: "live", servedFromMemorySec: ageSec,
        chargeSchedules: list(cs.charge_schedules).map((e) => {
          const x = pick(e, CHARGE_SCHEDULE_FIELDS);
          return { ...x, days: daysOf(x.days_of_week), start: x.start_enabled ? hhmm(x.start_time) : undefined, end: x.end_enabled ? hhmm(x.end_time) : undefined };
        }),
        preconditionSchedules: list(ps.precondition_schedules).map((e) => {
          const x = pick(e, PRECONDITION_SCHEDULE_FIELDS);
          return { ...x, days: daysOf(x.days_of_week), departure: hhmm(x.precondition_time) };
        }),
        note: "Times are minutes after midnight in the car's local time (shown as HH:MM). Schedule locations are not returned.",
      };
    },
  },
  {
    kind: "read",
    tool: {
      name: "get_vehicle_snapshot",
      description: "Several sections in ONE call (cheaper than separate reads): any of charge, climate, closures, tires, status, security. Cached by default; live=true only when online. Never wakes.",
      inputSchema: {
        type: "object",
        properties: {
          ...VIN_PROP,
          ...LIVE_PROP,
          sections: {
            type: "array",
            items: { type: "string", enum: ALL_SECTIONS },
            description: "Default: all six.",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const allowed = ALL_SECTIONS;
      const req = Array.isArray(args.sections) ? (args.sections as unknown[]).filter((s): s is Section => allowed.includes(s as Section)) : allowed;
      return readSections(args, ctx, req.length ? req : allowed);
    },
  },
  {
    kind: "location",
    tool: {
      name: "get_location",
      description: "Vehicle location (live location_data; vehicle must already be online; never wakes; needs the vehicle_location scope). Coarse (2 decimals, ~1 km) by default; precision=precise (5 decimals, ~1 m, plus heading) only when the user explicitly asks. The vehicle shows a location-sharing indicator on each read. Hidden when TESLA_FLEET_ENABLE_LOCATION is off.",
      inputSchema: {
        type: "object",
        properties: {
          ...VIN_PROP,
          precision: { type: "string", enum: ["coarse", "precise"], description: "Default coarse (or TESLA_FLEET_DEFAULT_LOCATION_PRECISION)." },
        },
      },
    },
    handler: async (args, ctx) => {
      // Validate before any network call (token refresh, vehicle list, state).
      if (args.precision !== undefined && args.precision !== "coarse" && args.precision !== "precise") {
        throw new LocalRefusal("invalid_arguments", "precision must be coarse or precise; nothing was read.");
      }
      const vin = await ctx.fleet.resolveVin(args.vin);
      const v = await ctx.fleet.requireOnline(vin);
      if (v.granular_access?.hide_private) {
        return { ok: false, vinLast4: vin.slice(-4), code: "location_hidden", message: "This vehicle share hides location (hide_private)." };
      }
      const precision = (args.precision as "coarse" | "precise" | undefined) ?? ctx.config.locationPrecision;
      let data: Record<string, unknown>;
      try {
        ({ data } = await ctx.fleet.vehicleDataLive(vin, ["location_data", "drive_state"]));
      } catch (e) {
        if (e instanceof FleetApiError && e.info.code === "missing_scope") {
          throw new FleetApiError({ ...e.info, code: "missing_location_scope", message: "The token is missing the vehicle_location scope needed for location.",
            hint: "Add the vehicle_location scope: re-run node scripts/auth-helper.mjs url (it is in the default scopes), sign in once, then reload the MCP server. To hide location instead, set TESLA_FLEET_ENABLE_LOCATION=0." });
        }
        throw e;
      }
      const d = (data.drive_state ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        vinLast4: maskVin(vin).slice(-4),
        precision,
        latitude: roundCoord(d.latitude, precision),
        longitude: roundCoord(d.longitude, precision),
        heading: precision === "precise" ? d.heading : undefined,
        gps_as_of: typeof d.gps_as_of === "number" ? new Date((d.gps_as_of as number) * 1000).toISOString() : undefined,
        note: "Location is not stored by this plugin. The vehicle shows a location-sharing indicator.",
      };
    },
  },
];
