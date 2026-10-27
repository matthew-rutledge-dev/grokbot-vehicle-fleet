/**
 * Vehicle command tools. Hidden and refused unless TESLA_FLEET_READ_ONLY is an
 * explicit off value. Each needs confirm=true AND user_request; otherwise a
 * dry-run preview is returned and nothing is sent. With TESLA_FLEET_DRY_RUN on,
 * even confirmed calls only return the exact request(s) that would be sent.
 *
 * Send pipeline: validate -> resolve VIN -> proxy configured -> vehicle online
 * (never auto-wake) -> virtual key paired (fleet_status, cached) -> POST via
 * proxy -> map result. No automatic retry; timeouts return "state unknown".
 */
import { BENIGN_COMMAND_REASONS, FleetApiError, LocalRefusal } from "../errors.js";
import { COMMAND_REQUEST_ERRORS } from "../http.js";
import { maskVin } from "../redact.js";
import type { ToolArgs, ToolContext } from "../context.js";
import { CONFIRM_PROPS, VIN_PROP } from "./schema.js";
import type { ToolDef } from "./types.js";

/** One POST to /api/1/vehicles/{vin}/command/{endpoint}. */
export type Step = { endpoint: string; body: Record<string, unknown> };
type Built = { steps: Step[]; preview?: Record<string, unknown> };

type CommandSpec = {
  name: string;
  description: string;
  endpoint: string;
  scope: string;
  requireExplicitVin?: boolean;
  properties?: Record<string, unknown>;
  required?: string[];
  build?: (args: ToolArgs) => { body: Record<string, unknown>; preview?: Record<string, unknown> };
  readBack: string;
};

export function bad(message: string): never {
  throw new LocalRefusal("invalid_arguments", `${message}; nothing was sent.`);
}

export function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) bad(`${name} must be a number`);
  return v as number;
}

export function int(v: unknown, name: string, min: number, max: number): number {
  const n = num(v, name);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

export function bool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") bad(`${name} must be true or false`);
  return v as boolean;
}

export const MIN_TEMP_C = 15;
export const MAX_TEMP_C = 28;
export const MIN_CHARGING_AMPS = 1;
export const MAX_CHARGING_AMPS = 48;

export function toCelsius(value: number, unit: unknown): number {
  const c = unit === "F" ? ((value - 32) * 5) / 9 : value;
  return Math.round(Math.min(MAX_TEMP_C, Math.max(MIN_TEMP_C, c)) * 2) / 2;
}

/** Seat positions (Fleet API remote_seat_heater_request). */
export const SEATS: Record<string, number> = {
  driver: 0, front_left: 0, passenger: 1, front_right: 1,
  rear_left: 2, rear_center: 4, rear_right: 5, third_row_left: 7, third_row_right: 8,
};

/**
 * Seat heater body. The Fleet API docs name the fields seat_position / seat_heater_level;
 * tesla-http-proxy has historically read heater / level. Both are sent so either reader works.
 */
export function seatHeaterBody(position: number, level: number): Record<string, unknown> {
  return { seat_position: position, seat_heater_level: level, heater: position, level };
}

const ON_PROP = { on: { type: "boolean" } } as const;

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
    description: "Start climate at the current set points. For a plain 'turn on the heat / warm up the car' use climate_warm_up.",
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
    name: "set_seat_heater", endpoint: "remote_seat_heater_request", scope: "vehicle_cmds", readBack: "get_climate",
    description: "Set one seat heater level 0-3 (0 = off). Climate must be on for it to take effect.",
    properties: {
      seat: { type: "string", enum: Object.keys(SEATS), description: "driver/front_left, passenger/front_right, rear_left, rear_center, rear_right, third_row_left, third_row_right." },
      level: { type: "integer", minimum: 0, maximum: 3 },
    },
    required: ["seat", "level"],
    build: (a) => {
      if (typeof a.seat !== "string" || !(a.seat in SEATS)) bad(`seat must be one of ${Object.keys(SEATS).join(", ")}`);
      return { body: seatHeaterBody(SEATS[a.seat as string], int(a.level, "level", 0, 3)) };
    },
  },
  {
    name: "set_steering_wheel_heater", endpoint: "remote_steering_wheel_heater_request", scope: "vehicle_cmds", readBack: "get_climate",
    description: "Turn the steering wheel heater on or off. Climate must be on.",
    properties: ON_PROP, required: ["on"],
    build: (a) => ({ body: { on: bool(a.on, "on") } }),
  },
  {
    name: "set_cabin_overheat_protection", endpoint: "set_cabin_overheat_protection", scope: "vehicle_cmds", readBack: "get_climate",
    description: "Cabin overheat protection on/off; fan_only=true uses the fan without A/C.",
    properties: { ...ON_PROP, fan_only: { type: "boolean", description: "Default false." } },
    required: ["on"],
    build: (a) => ({ body: { on: bool(a.on, "on"), fan_only: a.fan_only === undefined ? false : bool(a.fan_only, "fan_only") } }),
  },
  {
    name: "set_defrost_max", endpoint: "set_preconditioning_max", scope: "vehicle_cmds", readBack: "get_climate",
    description: "Max defrost / preconditioning on or off (front defrost and max heat).",
    properties: ON_PROP, required: ["on"],
    build: (a) => ({ body: { on: bool(a.on, "on") } }),
  },
  {
    name: "set_sentry_mode", endpoint: "set_sentry_mode", scope: "vehicle_cmds", readBack: "get_closures",
    description: "Sentry mode on or off (keeps the car awake while on).",
    properties: ON_PROP, required: ["on"],
    build: (a) => ({ body: { on: bool(a.on, "on") } }),
  },
  {
    name: "flash_lights", endpoint: "flash_lights", scope: "vehicle_cmds", readBack: "get_vehicle_state",
    description: "Briefly flash the headlights.",
  },
  {
    name: "honk_horn", endpoint: "honk_horn", scope: "vehicle_cmds", readBack: "get_vehicle_state",
    description: "Honk the horn once (noisy: make sure the user means it).",
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
    build: (a) => ({ body: { percent: int(a.percent, "percent", 50, 100) } }),
  },
  {
    name: "set_charging_amps", endpoint: "set_charging_amps", scope: "vehicle_charging_cmds", readBack: "get_battery_charge",
    description: `Set the charging current in amps (${MIN_CHARGING_AMPS}-${MAX_CHARGING_AMPS}; the car caps it at what the charger allows).`,
    properties: { charging_amps: { type: "integer", minimum: MIN_CHARGING_AMPS, maximum: MAX_CHARGING_AMPS } },
    required: ["charging_amps"],
    build: (a) => ({ body: { charging_amps: int(a.charging_amps, "charging_amps", MIN_CHARGING_AMPS, MAX_CHARGING_AMPS) } }),
  },
  {
    name: "charge_port_door_open", endpoint: "charge_port_door_open", scope: "vehicle_charging_cmds", readBack: "get_battery_charge",
    description: "Open the charge port door (also unlatches a connected cable on some models).",
  },
  {
    name: "charge_port_door_close", endpoint: "charge_port_door_close", scope: "vehicle_charging_cmds", readBack: "get_battery_charge",
    description: "Close the charge port door.",
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

export function requireIntent(args: ToolArgs): void {
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

/** Which auth-helper flag adds a scope. */
export function scopeHint(scope: string): string {
  const flag = scope === "energy_cmds" ? "--energy-commands" : scope === "energy_device_data" ? "--energy" : "--commands";
  return `Add the ${scope} scope: re-run node scripts/auth-helper.mjs url ${flag}, sign in once, then reload the MCP server.`;
}

function isTimeout(e: unknown): boolean {
  const n = (e as { name?: string })?.name;
  return n === "TimeoutError" || n === "AbortError";
}

const NOT_SENT_NET = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|ERR_TLS/;

/** Connection-level failure before any request reached the target: definitely not sent. */
export function connectFailure(e: unknown): { code: string; message: string } | undefined {
  const cause = (e as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (e as { code?: string })?.code;
  if (!code) return undefined;
  if (NOT_SENT_NET.has(code)) return { code: "proxy_unreachable", message: `Could not connect to the command proxy (${code}); nothing was sent.` };
  if (TLS_CODES.test(code)) return { code: "proxy_tls_error", message: `TLS check failed for the command proxy (${code}); nothing was sent. Check TESLA_COMMAND_PROXY_CA_CERT and the certificate's host name.` };
  return undefined;
}

/**
 * What a failed send means. not_sent: the connection never opened (refused, DNS, TLS).
 * unknown: the request may have reached the vehicle (timeout, 408, 5xx, reset mid-request,
 * or any other network error after connect). undefined: rethrow (local refusals, 4xx).
 */
export function classifySendFailure(e: unknown):
  | { kind: "not_sent"; code: string; message: string }
  | { kind: "unknown"; detail: string }
  | undefined {
  if (e instanceof LocalRefusal) return undefined;
  if (!e || typeof e !== "object" || !COMMAND_REQUEST_ERRORS.has(e)) return undefined; // failed before the command request
  if (isTimeout(e)) return { kind: "unknown", detail: "timeout" };
  if (e instanceof FleetApiError) {
    const st = e.info.status ?? 0;
    if (st === 408 || st >= 500) return { kind: "unknown", detail: `HTTP ${st}` };
    return undefined;
  }
  const cf = connectFailure(e);
  if (cf) return { kind: "not_sent", ...cf };
  const cause = (e as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (e as { code?: string })?.code;
  return { kind: "unknown", detail: code ? `network error ${code}` : "network error" };
}

/** Steps planned for the climate_warm_up preset (cold-dependent steps resolved at send time). */
export type WarmUpPlan = { steps: Step[]; conditional: Array<Step & { when: string }> };

export function planWarmUp(args: ToolArgs, ctx: ToolContext, outsideC?: number): WarmUpPlan {
  const d = ctx.config.climate;
  const temp = args.temp === undefined ? d.tempC : toCelsius(num(args.temp, "temp"), args.unit);
  const seatArg = args.seat_heat ?? "auto";
  if (!(seatArg === "auto" || seatArg === "off" || (typeof seatArg === "number" && Number.isInteger(seatArg) && seatArg >= 0 && seatArg <= 3))) {
    bad("seat_heat must be auto, off, or a level 0-3");
  }
  const defArg = args.defrost ?? "auto";
  if (!(defArg === "auto" || defArg === true || defArg === false)) bad("defrost must be auto, true or false");
  const seatsArg = args.seats ?? d.seats;
  if (!(seatsArg === "driver" || seatsArg === "front" || seatsArg === "none")) bad("seats must be driver, front or none");

  const steps: Step[] = [
    { endpoint: "auto_conditioning_start", body: {} },
    { endpoint: "set_temps", body: { driver_temp: temp, passenger_temp: temp } },
  ];
  const conditional: Array<Step & { when: string }> = [];
  const positions = seatsArg === "front" ? [SEATS.driver, SEATS.passenger] : seatsArg === "driver" ? [SEATS.driver] : [];
  const cold = outsideC !== undefined && outsideC < d.coldBelowC;
  const level = typeof seatArg === "number" ? seatArg : d.seatLevel;
  for (const p of positions) {
    const s = { endpoint: "remote_seat_heater_request", body: seatHeaterBody(p, level) };
    if (typeof seatArg === "number") steps.push(s);
    else if (seatArg === "auto") {
      if (outsideC === undefined) conditional.push({ ...s, when: `outside temp below ${d.coldBelowC} C` });
      else if (cold && level > 0) steps.push(s);
    }
  }
  if (seatArg !== "off" && d.wheelWhenCold && positions.includes(SEATS.driver)) {
    const s = { endpoint: "remote_steering_wheel_heater_request", body: { on: true } };
    if (typeof seatArg === "number" && seatArg > 0) steps.push(s);
    else if (seatArg === "auto") {
      if (outsideC === undefined) conditional.push({ ...s, when: `outside temp below ${d.coldBelowC} C` });
      else if (cold) steps.push(s);
    }
  }
  const defrost = { endpoint: "set_preconditioning_max", body: { on: true } };
  if (defArg === true) steps.push(defrost);
  else if (defArg === "auto") {
    if (outsideC === undefined) conditional.push({ ...defrost, when: `outside temp below ${d.defrostBelowC} C` });
    else if (outsideC < d.defrostBelowC) steps.push(defrost);
  }
  return { steps, conditional };
}

function needsOutsideTemp(args: ToolArgs): boolean {
  return (args.seat_heat ?? "auto") === "auto" || (args.defrost ?? "auto") === "auto";
}

type SendOpts = {
  name: string;
  scope: string;
  readBack: string;
  requireExplicitVin?: boolean;
  /** Static steps, or a planner that may read cached data first (warm-up). */
  plan: (vin: string | undefined, ctx: ToolContext) => Promise<Built>;
  previewPlan: () => Built & { conditional?: Array<Step & { when: string }> };
};

/** Dry-run request echo: VIN masked to the last 4, navigation destination not echoed. */
function requestOf(ctx: ToolContext, vin: string | undefined, s: Step, preview?: Record<string, unknown>) {
  const base = ctx.config.proxyUrl ?? "<TESLA_COMMAND_PROXY_URL>";
  const body = preview?.destination ? { destination: preview.destination } : s.body;
  return { method: "POST", url: `${base}/api/1/vehicles/${vin ? maskVin(vin) : "{vin}"}/command/${s.endpoint}`, body };
}

async function runVehicle(args: ToolArgs, ctx: ToolContext, o: SendOpts): Promise<Record<string, unknown>> {
  if (args.confirm !== true) {
    const p = o.previewPlan();
    const vin = offlineVin(args, ctx, o.requireExplicitVin);
    const single = p.steps.length === 1 && !p.conditional?.length;
    return {
      dryRun: true,
      sent: false,
      command: o.name,
      ...(single
        ? { endpoint: `POST /api/1/vehicles/{vin}/command/${p.steps[0].endpoint}`, body: p.preview?.destination ? { destination: p.preview.destination } : p.steps[0].body }
        : { steps: p.steps.map((s) => ({ endpoint: s.endpoint, body: s.body })), ...(p.conditional?.length ? { conditionalSteps: p.conditional } : {}) }),
      vinLast4: vin ? vin.slice(-4) : o.requireExplicitVin ? "(explicit vin required)" : "(resolved at send time)",
      proxyConfigured: Boolean(ctx.config.proxyUrl),
      checksBeforeSend: ["vehicle online (no auto-wake)", "virtual key paired", "local rate limit"],
      estimatedBillableCalls: `${p.steps.length + (p.conditional?.length ?? 0)} command(s) max + up to 3 small reads (state, fleet_status, cached data)`,
      toSend: "Ask the user to confirm, then call again with confirm=true and user_request.",
    };
  }
  requireIntent(args);
  if (ctx.config.dryRun) {
    const p = o.previewPlan();
    const vin = offlineVin(args, ctx, o.requireExplicitVin);
    if (o.requireExplicitVin && !vin) throw new LocalRefusal("vin_required", "This command needs an explicit vin (no default) because it can open the vehicle.");
    return {
      dryRun: true, dryRunMode: "TESLA_FLEET_DRY_RUN", sent: false, command: o.name,
      wouldSend: p.steps.map((s) => requestOf(ctx, vin, s, p.preview)),
      vinLast4: vin ? vin.slice(-4) : "(resolved at send time)",
      ...(p.conditional?.length ? { conditionalSteps: p.conditional.map((s) => ({ ...requestOf(ctx, vin, s), when: s.when })) } : {}),
      wouldCheckFirst: ["GET /api/1/vehicles/{vin} (must be online)", "POST /api/1/vehicles/fleet_status (key paired)"],
      proxyConfigured: Boolean(ctx.config.proxyUrl),
      note: "Validated only; no network call was made.",
    };
  }
  const vin = await ctx.fleet.resolveVin(args.vin, { requireExplicit: o.requireExplicitVin });
  if (!ctx.config.proxyUrl) {
    throw new LocalRefusal("proxy_not_configured", "TESLA_COMMAND_PROXY_URL (or TESLA_FLEET_PROXY_URL) is not set; nothing was sent.",
      "Run your own tesla-http-proxy and set TESLA_COMMAND_PROXY_URL (or its alias TESLA_FLEET_PROXY_URL), plus TESLA_COMMAND_PROXY_CA_CERT for a private CA (skill vehicle-fleet-setup).");
  }
  await ctx.fleet.requireOnline(vin);
  const fs = await ctx.fleet.fleetStatus(vin);
  if (fs.paired === false) {
    throw new LocalRefusal("virtual_key_missing", "This app's virtual key is not paired with the vehicle; nothing was sent.", pairingHint(ctx));
  }
  const { steps } = await o.plan(vin, ctx);
  const done: Array<Record<string, unknown>> = [];
  const multi = steps.length > 1;
  for (const s of steps) {
    try {
      const r = await ctx.fleet.command(vin, s.endpoint, s.body);
      const reason = r.reason ?? "";
      if (r.result === true) { done.push({ endpoint: s.endpoint, ok: true }); continue; }
      if (BENIGN_COMMAND_REASONS[reason]) { done.push({ endpoint: s.endpoint, ok: true, noChange: true, reason, message: BENIGN_COMMAND_REASONS[reason] }); continue; }
      const fail = { ok: false, sent: true as boolean | "partial", command: o.name, vinLast4: vin.slice(-4), reason, message: `Vehicle rejected the command: ${reason || "no reason given"}` };
      return multi ? { ...fail, ...(done.length ? { sent: "partial", failedStepSent: true } : {}), failedStep: s.endpoint, completedSteps: done } : fail;
    } catch (e) {
      const partial = multi ? { failedStep: s.endpoint, completedSteps: done } : {};
      const sentField = (failed: boolean | "unknown") => (done.length ? { sent: "partial", failedStepSent: failed } : { sent: failed });
      if (e instanceof FleetApiError && e.info.code === "virtual_key_missing") throw new FleetApiError({ ...e.info, hint: pairingHint(ctx) });
      if (e instanceof FleetApiError && e.info.code === "missing_scope") throw new FleetApiError({ ...e.info, hint: scopeHint(o.scope) });
      const f = classifySendFailure(e);
      if (f?.kind === "unknown") {
        return {
          ok: false, ...sentField("unknown"), command: o.name, vinLast4: vin.slice(-4), code: "state_unknown", cause: f.detail,
          message: `The command may or may not have run (${f.detail}). It was not retried; do not resend blindly.`,
          hint: `Read the state back with ${o.readBack} before doing anything else.`, ...partial,
        };
      }
      if (f?.kind === "not_sent") return { ok: false, ...sentField(false), command: o.name, code: f.code, error: f.message, ...partial };
      if (done.length) return { ok: false, ...sentField(false), command: o.name, error: e instanceof Error ? e.message : String(e), ...partial };
      throw e;
    }
  }
  const noChange = done.length > 0 && done.every((d) => d.noChange);
  if (!multi) {
    const d = done[0];
    return d.noChange
      ? { ok: true, sent: true, command: o.name, vinLast4: vin.slice(-4), noChange: true, reason: d.reason, message: d.message }
      : { ok: true, sent: true, command: o.name, vinLast4: vin.slice(-4), readBackWith: o.readBack };
  }
  return { ok: true, sent: true, command: o.name, vinLast4: vin.slice(-4), steps: done, ...(noChange ? { noChange: true } : {}), readBackWith: o.readBack };
}

function commandTool(spec: CommandSpec): ToolDef {
  const build = (args: ToolArgs): Built => {
    const b = spec.build ? spec.build(args) : { body: {} };
    const endpoint = (b.preview?.endpoint as string | undefined) ?? spec.endpoint;
    return { steps: [{ endpoint, body: b.body }], preview: b.preview };
  };
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
      const built = build(args); // validate before anything else
      return runVehicle(args, ctx, {
        name: spec.name, scope: spec.scope, readBack: spec.readBack, requireExplicitVin: spec.requireExplicitVin,
        plan: async () => built, previewPlan: () => built,
      });
    },
  };
}

const WARM_UP: ToolDef = {
  kind: "command",
  tool: {
    name: "climate_warm_up",
    description: "Preset for 'turn on the heat' / 'warm up the car': climate on + both set points to the default temperature; when it is cold outside (cached reading) also the default seat heater(s) and steering wheel heat; max defrost when it is very cold. Every argument is optional; defaults come from TESLA_FLEET_DEFAULT_* / *_OUTSIDE_BELOW_C variables. Several signed commands (scope vehicle_cmds); without confirm=true returns the plan.",
    inputSchema: {
      type: "object",
      properties: {
        ...VIN_PROP,
        temp: { type: "number", description: "Set point for both sides (default from TESLA_FLEET_DEFAULT_CLIMATE_TEMP_C)." },
        unit: { type: "string", enum: ["C", "F"], description: "Default C." },
        seat_heat: { description: "auto (default: only when cold), off, or a level 0-3 (always).", oneOf: [{ type: "string", enum: ["auto", "off"] }, { type: "integer", minimum: 0, maximum: 3 }] },
        seats: { type: "string", enum: ["driver", "front", "none"], description: "Which seats get heat (default from TESLA_FLEET_DEFAULT_HEATED_SEATS)." },
        defrost: { description: "auto (default: only when very cold), true or false.", oneOf: [{ type: "string", enum: ["auto"] }, { type: "boolean" }] },
        ...CONFIRM_PROPS,
      },
    },
  },
  handler: async (args, ctx) => {
    const preview = planWarmUp(args, ctx); // validates
    return runVehicle(args, ctx, {
      name: "climate_warm_up", scope: "vehicle_cmds", readBack: "get_climate",
      previewPlan: () => preview,
      plan: async (vin) => {
        let outside: number | undefined;
        if (needsOutsideTemp(args) && vin) {
          try {
            const { data } = await ctx.fleet.vehicleDataCached(vin);
            const t = (data.climate_state as Record<string, unknown> | undefined)?.outside_temp;
            if (typeof t === "number") outside = t;
          } catch {
            outside = undefined; // no cached reading: skip the cold-only extras
          }
        }
        const p = planWarmUp(args, ctx, outside ?? Number.POSITIVE_INFINITY);
        return { steps: p.steps };
      },
    });
  },
};

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
    if (ctx.config.dryRun) {
      const vin = offlineVin(args, ctx);
      return {
        dryRun: true, dryRunMode: "TESLA_FLEET_DRY_RUN", sent: false, command: "wake_vehicle",
        wouldSend: [{ method: "POST", url: `<fleet base>/api/1/vehicles/${vin ? maskVin(vin) : "{vin}"}/wake_up`, body: {} }],
        vinLast4: vin ? vin.slice(-4) : "(resolved at send time)",
        note: "Validated only; no network call was made.",
      };
    }
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

export const VEHICLE_COMMAND_TOOLS: ToolDef[] = [WAKE, WARM_UP, ...SPECS.map(commandTool)];
