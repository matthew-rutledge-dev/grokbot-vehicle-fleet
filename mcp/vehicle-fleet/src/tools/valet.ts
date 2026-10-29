/**
 * Valet Mode commands (opt-in). Listed only when read-only is off AND TESLA_FLEET_ENABLE_VALET is on.
 *
 * The 4-digit PIN comes only from TESLA_FLEET_VALET_PIN, read at send time. It is never a tool
 * argument, never stored in Config, never logged, and never shown in a preview, dry-run or result
 * (previews show a placeholder). Through the stock tesla-http-proxy (pkg/proxy/command.go):
 * set_valet_mode on needs { on: true, password }, off needs only { on: false } (the signed
 * command carries no PIN), and reset_valet_pin needs valet mode to be off.
 */
import { readEnv } from "../env.js";
import { ENV } from "../config.js";
import { LocalRefusal } from "../errors.js";
import type { ToolArgs, ToolContext } from "../context.js";
import { bad, bool, runVehicle, type Built } from "./commands.js";
import { CONFIRM_PROPS, VIN_PROP } from "./schema.js";
import type { ToolDef } from "./types.js";

const PIN_SHOWN = "[from TESLA_FLEET_VALET_PIN, never shown]";
const PIN_RE = /^\d{4}$/;

/** Read and check the PIN at send time. Errors never include the value. */
export function valetPin(ctx: ToolContext): string {
  const pin = readEnv(ENV.VALET_PIN, ctx.env);
  if (pin === undefined) {
    throw new LocalRefusal("valet_pin_not_configured", "TESLA_FLEET_VALET_PIN is not set; nothing was sent.",
      "Put the 4-digit valet PIN in TESLA_FLEET_VALET_PIN (secret store / env), never in chat or a tool argument.");
  }
  if (!PIN_RE.test(pin)) {
    throw new LocalRefusal("valet_pin_invalid", "TESLA_FLEET_VALET_PIN must be exactly 4 digits; nothing was sent.");
  }
  return pin;
}

const PIN_ARG_NAMES = new Set(["pin", "password", "valetpin", "passcode", "passwd", "pincode", "valetpassword"]);

function refusePinArg(args: ToolArgs): void {
  // Case- and separator-insensitive: PIN, Password, valet-pin, valetPin, pass_code ...
  for (const k of Object.keys(args)) {
    if (PIN_ARG_NAMES.has(k.toLowerCase().replace(/[^a-z]/g, ""))) {
      bad("a PIN or password argument is not accepted (the PIN comes only from TESLA_FLEET_VALET_PIN)");
    }
  }
}

const SET_VALET: ToolDef = {
  kind: "command",
  optIn: "valet",
  tool: {
    name: "set_valet_mode",
    description: "OPT-IN (TESLA_FLEET_ENABLE_VALET). Turn Valet Mode on or off. On uses the 4-digit PIN from TESLA_FLEET_VALET_PIN (never pass, say or show the PIN); the car must be in Park. Valet Mode caps speed and power, locks the frunk and glovebox, hides Home/Work and blocks HomeLink. Off needs no PIN for a signed command. Needs an explicit vin. Without confirm=true returns a dry-run.",
    inputSchema: { type: "object", properties: { ...VIN_PROP, on: { type: "boolean" }, ...CONFIRM_PROPS }, required: ["on"] },
  },
  handler: async (args, ctx) => {
    refusePinArg(args);
    const on = bool(args.on, "on");
    const preview: Built = on
      ? { steps: [{ endpoint: "set_valet_mode", body: { on: true } }], preview: { body: { on: true, password: PIN_SHOWN } } }
      : { steps: [{ endpoint: "set_valet_mode", body: { on: false } }] };
    return runVehicle(args, ctx, {
      name: "set_valet_mode", scope: "vehicle_cmds", readBack: "get_security_status", requireExplicitVin: true,
      notes: on ? [`PIN: ${ctx.config.valetPinConfigured ? "configured" : "NOT configured (TESLA_FLEET_VALET_PIN); a confirmed call will be refused"}.`] : undefined,
      previewPlan: () => preview,
      plan: async () => (on
        ? { steps: [{ endpoint: "set_valet_mode", body: { on: true, password: valetPin(ctx) } }], preview: preview.preview }
        : preview),
    });
  },
};

const RESET_VALET_PIN: ToolDef = {
  kind: "command",
  optIn: "valet",
  tool: {
    name: "reset_valet_pin",
    description: "OPT-IN (TESLA_FLEET_ENABLE_VALET). Clear the saved Valet Mode PIN (Valet Mode must be off). The next set_valet_mode on uses TESLA_FLEET_VALET_PIN. Needs an explicit vin. Without confirm=true returns a dry-run.",
    inputSchema: { type: "object", properties: { ...VIN_PROP, ...CONFIRM_PROPS } },
  },
  handler: async (args, ctx) => {
    refusePinArg(args);
    const built: Built = { steps: [{ endpoint: "reset_valet_pin", body: {} }] };
    return runVehicle(args, ctx, {
      name: "reset_valet_pin", scope: "vehicle_cmds", readBack: "get_security_status", requireExplicitVin: true,
      previewPlan: () => built, plan: async () => built,
    });
  },
};

export const VALET_TOOLS: ToolDef[] = [SET_VALET, RESET_VALET_PIN];
