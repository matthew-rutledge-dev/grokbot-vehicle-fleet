/**
 * Command tools. Hidden and refused unless TESLA_FLEET_READ_ONLY is an
 * explicit off value. Each needs confirm=true AND user_request; otherwise a
 * dry-run preview is returned and nothing is sent.
 *
 * Send pipeline: validate -> resolve VIN -> proxy configured -> vehicle online
 * (never auto-wake) -> virtual key paired (fleet_status, cached) -> POST via
 * proxy -> map result. No automatic retry; timeouts return "state unknown".
 */
import { BENIGN_COMMAND_REASONS, FleetApiError, LocalRefusal } from "../errors.js";
import { maskVin } from "../redact.js";
import type { ToolArgs, ToolContext } from "../context.js";
import { CONFIRM_PROPS, VIN_PROP } from "./schema.js";
import type { ToolDef } from "./types.js";

type Built = { body: Record<string, unknown>; preview?: Record<string, unknown> };

type CommandSpec = {
  name: string;
  description: string;
  endpoint: string;
  scope: string;
  requireExplicitVin?: boolean;
  properties?: Record<string, unknown>;
  required?: string[];
  build?: (args: ToolArgs) => Built;
  readBack: string;
};

function bad(message: string): never {
  throw new LocalRefusal("invalid_arguments", message);
}

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) bad(`${name} must be a number`);
  return v as number;
}

export const MIN_TEMP_C = 15;
export const MAX_TEMP_C = 28;

export function toCelsius(value: number, unit: unknown): number {
  const c = unit === "F" ? ((value - 32) * 5) / 9 : value;
  return Math.round(Math.min(MAX_TEMP_C, Math.max(MIN_TEMP_C, c)) * 2) / 2;
}

const SPECS: CommandSpec[] = [
  {
    name: "door_lock", endpoint: "door_lock", scope: "vehicle_cmds", readBack: "get_closures",
    description: "Lock the vehicle.",
  },
  {
    name: "door_unlock", endpoint: "door_unlock", scope: "vehicle_cmds", readBack: "get_closures",
    requireExplicitVin: true,
    description: "Unlock the vehicle. Needs an explicit vin. Make sure the user really wants the car unlocked.",
  },
  {
    name: "actuate_trunk", endpoint: "actuate_trunk", scope: "vehicle_cmds", readBack: "get_closures",
    requireExplicitVin: true,
    description: "Open the front trunk (frunk) or open/close the rear trunk. Needs an explicit vin. The frunk usually cannot be closed remotely.",
    properties: { which_trunk: { type: "string", enum: ["front", "rear"] } },
    required: ["which_trunk"],
    build: (a) => {
      if (a.which_trunk !== "front" && a.which_trunk !== "rear") bad("which_trunk must be front or rear");
      return { body: { which_trunk: a.which_trunk } };
    },
  },
  {
    name: "climate_start", endpoint: "auto_conditioning_start", scope: "vehicle_cmds", readBack: "get_climate",
    description: "Start climate preconditioning.",
  },
  {
    name: "climate_stop", endpoint: "auto_conditioning_stop", scope: "vehicle_cmds", readBack: "get_climate",
    description: "Stop climate preconditioning.",
  },
  {
    name: "set_temps", endpoint: "set_temps", scope: "vehicle_cmds", readBack: "get_climate",
    description: `Set cabin temperature set points (sent in Celsius, clamped to ${MIN_TEMP_C}-${MAX_TEMP_C} C).`,
    properties: {
      driver_temp: { type: "number" },
      passenger_temp: { type: "number", description: "Default: same as driver_temp." },
      unit: { type: "string", enum: ["C", "F"], description: "Default C." },
    },
    required: ["driver_temp"],
    build: (a) => {
      const d = toCelsius(num(a.driver_temp, "driver_temp"), a.unit);
      const p = a.passenger_temp === undefined ? d : toCelsius(num(a.passenger_temp, "passenger_temp"), a.unit);
      return { body: { driver_temp: d, passenger_temp: p } };
    },
  },
  {
    name: "charge_start", endpoint: "charge_start", scope: "vehicle_charging_cmds", readBack: "get_battery_charge",
    description: "Start charging (vehicle must be plugged in).",
  },
  {
    name: "charge_stop", endpoint: "charge_stop", scope: "vehicle_charging_cmds", readBack: "get_battery_charge",
    description: "Stop charging.",
  },
  {
    name: "set_charge_limit", endpoint: "set_charge_limit", scope: "vehicle_charging_cmds", readBack: "get_battery_charge",
    description: "Set the charge limit percent (50-100). Does not start charging.",
    properties: { percent: { type: "integer", minimum: 50, maximum: 100 } },
    required: ["percent"],
    build: (a) => {
      const p = num(a.percent, "percent");
      if (!Number.isInteger(p) || p < 50 || p > 100) bad("percent must be an integer from 50 to 100");
      return { body: { percent: p } };
    },
  },
  {
    name: "share_navigation", endpoint: "navigation_request", scope: "vehicle_cmds", readBack: "get_vehicle_state",
    description: "Send a destination to the vehicle's navigation: either an address/place text, or lat+lon.",
    properties: {
      destination: { type: "string", description: "Address or place name." },
      lat: { type: "number" },
      lon: { type: "number" },
    },
    build: (a) => {
      if (typeof a.lat === "number" || typeof a.lon === "number") {
        const lat = num(a.lat, "lat");
        const lon = num(a.lon, "lon");
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) bad("lat/lon out of range");
        return { body: { lat, lon, order: 0 }, preview: { endpoint: "navigation_gps_request", destination: "[coordinates]" } };
      }
      if (typeof a.destination !== "string" || !a.destination.trim()) bad("pass destination text or lat+lon");
      return {
        body: {
          type: "share_ext_content_raw",
          locale: "en-US",
          timestamp_ms: String(Date.now()),
          value: { "android.intent.extra.TEXT": (a.destination as string).trim() },
        },
        preview: { destination: "[address text, not echoed]" },
      };
    },
  },
];

/** VIN without any network call (for dry-runs). */
function offlineVin(args: ToolArgs, ctx: ToolContext, explicit?: boolean): string | undefined {
  if (typeof args.vin === "string" && args.vin.trim()) return args.vin.trim().toUpperCase();
  return explicit ? undefined : ctx.config.defaultVin?.toUpperCase();
}

function requireIntent(args: ToolArgs): void {
  if (typeof args.user_request !== "string" || args.user_request.trim().length < 3) {
    throw new LocalRefusal("user_request_required",
      "confirm=true needs user_request: a short quote of the human's explicit request in this conversation. Nothing was sent.",
      "Commands are never sent from routines, schedules, triggers, or on the agent's own initiative.");
  }
}

function pairingHint(ctx: ToolContext): string {
  const domain = ctx.config.keyDomain ?? "<your-domain>";
  return `Pair the app's virtual key in the Tesla app: https://www.tesla.com/_ak/${domain}`;
}

function isTimeout(e: unknown): boolean {
  const n = (e as { name?: string })?.name;
  return n === "TimeoutError" || n === "AbortError";
}

function commandTool(spec: CommandSpec): ToolDef {
  return {
    kind: "command",
    tool: {
      name: spec.name,
      description: `${spec.description} Signed via your tesla-http-proxy (scope ${spec.scope}). Without confirm=true returns a dry-run. Requires the vehicle to be online already (never auto-wakes).`,
      inputSchema: {
        type: "object",
        properties: { ...VIN_PROP, ...(spec.properties ?? {}), ...CONFIRM_PROPS },
        ...(spec.required ? { required: spec.required } : {}),
      },
    },
    handler: async (args, ctx) => {
      const built = spec.build ? spec.build(args) : { body: {} };
      const endpoint = (built.preview?.endpoint as string | undefined) ?? spec.endpoint;
      if (args.confirm !== true) {
        const vin = offlineVin(args, ctx, spec.requireExplicitVin);
        return {
          dryRun: true,
          sent: false,
          command: spec.name,
          endpoint: `POST /api/1/vehicles/{vin}/command/${endpoint}`,
          vinLast4: vin ? vin.slice(-4) : spec.requireExplicitVin ? "(explicit vin required)" : "(resolved at send time)",
          body: built.preview?.destination ? { destination: built.preview.destination } : built.body,
          proxyConfigured: Boolean(ctx.config.proxyUrl),
          checksBeforeSend: ["vehicle online (no auto-wake)", "virtual key paired", "local rate limit"],
          estimatedBillableCalls: "1 command + up to 2 small reads (state, fleet_status)",
          toSend: "Ask the user to confirm, then call again with confirm=true and user_request.",
        };
      }
      requireIntent(args);
      const vin = await ctx.fleet.resolveVin(args.vin, { requireExplicit: spec.requireExplicitVin });
      if (!ctx.config.proxyUrl) {
        throw new LocalRefusal("proxy_not_configured", "TESLA_COMMAND_PROXY_URL is not set; nothing was sent.",
          "Run your own tesla-http-proxy and set TESLA_COMMAND_PROXY_URL (skill vehicle-fleet-setup).");
      }
      await ctx.fleet.requireOnline(vin);
      const fs = await ctx.fleet.fleetStatus(vin);
      if (fs.paired === false) {
        throw new LocalRefusal("virtual_key_missing", "This app's virtual key is not paired with the vehicle; nothing was sent.", pairingHint(ctx));
      }
      try {
        const r = await ctx.fleet.command(vin, endpoint, built.body);
        const reason = r.reason ?? "";
        if (r.result === true) return { ok: true, sent: true, command: spec.name, vinLast4: vin.slice(-4), readBackWith: spec.readBack };
        if (BENIGN_COMMAND_REASONS[reason]) {
          return { ok: true, sent: true, command: spec.name, vinLast4: vin.slice(-4), noChange: true, reason, message: BENIGN_COMMAND_REASONS[reason] };
        }
        return { ok: false, sent: true, command: spec.name, vinLast4: vin.slice(-4), reason, message: `Vehicle rejected the command: ${reason || "no reason given"}` };
      } catch (e) {
        if (isTimeout(e) || (e instanceof FleetApiError && e.info.status === 408)) {
          return {
            ok: false, sent: "unknown", command: spec.name, vinLast4: maskVin(vin).slice(-4), code: "state_unknown",
            message: "The command may or may not have run (timeout/unavailable). It was not retried.",
            hint: `Read the state back with ${spec.readBack} before doing anything else.`,
          };
        }
        if (e instanceof FleetApiError && e.info.code === "virtual_key_missing") {
          throw new FleetApiError({ ...e.info, hint: pairingHint(ctx) });
        }
        throw e;
      }
    },
  };
}

const WAKE: ToolDef = {
  kind: "command",
  tool: {
    name: "wake_vehicle",
    description: "Wake the vehicle (POST wake_up; billed as a wake, limited to 3/min). Only when the user explicitly asks. Without confirm=true returns a dry-run. Does nothing if already online.",
    inputSchema: { type: "object", properties: { ...VIN_PROP, ...CONFIRM_PROPS } },
  },
  handler: async (args, ctx) => {
    if (args.confirm !== true) {
      const vin = offlineVin(args, ctx);
      return {
        dryRun: true, sent: false, command: "wake_vehicle", endpoint: "POST /api/1/vehicles/{vin}/wake_up",
        vinLast4: vin ? vin.slice(-4) : "(resolved at send time)",
        estimatedBillableCalls: "1 wake + up to 12 state checks over 60 s (skipped if already online)",
        toSend: "Ask the user to confirm, then call again with confirm=true and user_request.",
      };
    }
    requireIntent(args);
    const vin = await ctx.fleet.resolveVin(args.vin);
    const before = await ctx.fleet.getVehicle(vin, true);
    if (before?.state === "online") return { ok: true, sent: false, vinLast4: vin.slice(-4), state: "online", message: "Already online; no wake sent." };
    const r = await ctx.fleet.wakeUp(vin);
    return {
      ok: r.state === "online", sent: true, vinLast4: vin.slice(-4), state: r.state, waitedSec: r.waitedSec,
      message: r.state === "online" ? "Vehicle is online." : "Wake sent but the vehicle is not online yet; do not resend in a loop.",
    };
  },
};

export const COMMAND_TOOLS: ToolDef[] = [WAKE, ...SPECS.map(commandTool)];
