/** Read tools: no confirm, never wake the vehicle. */
import { configPresence } from "../config.js";
import { FleetApiError } from "../errors.js";
import { describeReadOnly } from "../readonly.js";
import { maskVin, roundCoord } from "../redact.js";
import type { ToolArgs, ToolContext } from "../context.js";
import {
  CHARGE_FIELDS, CLIMATE_FIELDS, CLOSURE_FIELDS, TIRE_FIELDS,
  blockTimestamp, closureSummary, pick, tireSummary,
} from "./extract.js";
import { LIVE_PROP, VIN_PROP } from "./schema.js";
import type { ToolDef } from "./types.js";

export const RULES_SUMMARY = [
  "Read-only unless TESLA_FLEET_READ_ONLY is explicitly 0/false/no/off.",
  "Every command needs confirm=true plus user_request; without confirm you get a dry-run.",
  "Never send commands from routines, schedules, triggers, or on the agent's own initiative.",
  "Nothing wakes the vehicle except wake_vehicle (confirm-gated, costs a wake).",
  "Reads default to cached data; live reads only when the vehicle is already online.",
  "Do not poll. Every Fleet API response below 500 is billed.",
  "Location is off unless TESLA_FLEET_ENABLE_LOCATION is on, and coarse by default.",
];

type Section = "charge" | "climate" | "closures" | "tires";
const SECTION_ENDPOINTS: Record<Section, string[]> = {
  charge: ["charge_state"],
  climate: ["climate_state"],
  closures: ["vehicle_state", "closures_state"],
  tires: ["vehicle_state"],
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
      description: "Shows what this server will and will not do: read-only state, location opt-in, proxy configured, which plugin variables are set (never values), token store status, billable calls this session, and the safety rules. No network call.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async (_args, ctx) => ({
      readOnly: ctx.config.readOnly.readOnly,
      readOnlyStatus: describeReadOnly(ctx.config.readOnly),
      locationEnabled: ctx.config.locationEnabled,
      proxyConfigured: Boolean(ctx.config.proxyUrl),
      proxyCaConfigured: Boolean(ctx.config.proxyCaCertPath),
      regionConfigured: ctx.config.region ?? (ctx.config.baseUrl ? "custom base URL" : "auto-detect"),
      variables: configPresence(ctx.env),
      configProblems: ctx.config.problems,
      auth: ctx.tokens.status(),
      billableCallsThisSession: ctx.fleet.billableCalls,
      rules: RULES_SUMMARY,
      outOfScope: "Energy products (Powerwall/solar) are not supported in v0.1 (TODO).",
    }),
  },
  {
    kind: "read",
    tool: {
      name: "api_status",
      description: "Fleet API health (GET /status, unauthenticated, not billed).",
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
  sectionTool("get_tires", "tires", "Tire pressures (TPMS, bar + psi) and warnings"),
  {
    kind: "read",
    tool: {
      name: "get_vehicle_snapshot",
      description: "Several sections in ONE call (cheaper than separate reads): any of charge, climate, closures, tires. Cached by default; live=true only when online. Never wakes.",
      inputSchema: {
        type: "object",
        properties: {
          ...VIN_PROP,
          ...LIVE_PROP,
          sections: {
            type: "array",
            items: { type: "string", enum: ["charge", "climate", "closures", "tires"] },
            description: "Default: all four.",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const allowed: Section[] = ["charge", "climate", "closures", "tires"];
      const req = Array.isArray(args.sections) ? (args.sections as unknown[]).filter((s): s is Section => allowed.includes(s as Section)) : allowed;
      return readSections(args, ctx, req.length ? req : allowed);
    },
  },
  {
    kind: "location",
    tool: {
      name: "get_location",
      description: "Vehicle location (live location_data; vehicle must already be online; never wakes). Coarse (~1 km) by default; precision=precise only when the user explicitly asks. The vehicle shows a location-sharing indicator on each read. Listed only when TESLA_FLEET_ENABLE_LOCATION is on.",
      inputSchema: {
        type: "object",
        properties: {
          ...VIN_PROP,
          precision: { type: "string", enum: ["coarse", "precise"], description: "Default coarse." },
        },
      },
    },
    handler: async (args, ctx) => {
      const vin = await ctx.fleet.resolveVin(args.vin);
      const v = await ctx.fleet.requireOnline(vin);
      if (v.granular_access?.hide_private) {
        return { ok: false, vinLast4: vin.slice(-4), code: "location_hidden", message: "This vehicle share hides location (hide_private)." };
      }
      const precision = args.precision === "precise" ? "precise" : "coarse";
      const { data } = await ctx.fleet.vehicleDataLive(vin, ["location_data", "drive_state"]);
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
