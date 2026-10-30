/**
 * EXPERIMENTAL signed-path extras (opt-in): dashcam_save_clip (VehicleAction 47) and remote_boombox
 * (VehicleAction 64). Listed only when read-only is off AND TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS
 * is on. The stock tesla-http-proxy cannot send either (no dashcam endpoint; remote_boombox returns
 * "command not implemented"), so they are signed locally with the virtual key
 * (TESLA_FLEET_COMMAND_KEY_FILE) and POSTed to Fleet API signed_command, like play_video_on_screen.
 *
 * Same gates as play_video_on_screen: confirm=true + user_request, TESLA_FLEET_DRY_RUN, online and
 * key-paired checks (never wakes), audit line written before any billable call, no retry.
 * play_video_on_screen (field-tested) keeps its own handler in video.ts unchanged.
 */
import { auditVin, type AuditEvent } from "../audit.js";
import { FleetApiError, LocalRefusal } from "../errors.js";
import { maskVin } from "../redact.js";
import { SignedCommandError } from "../signed/crypto.js";
import { SignedCommandClient, SignedPhaseError } from "../signed/client.js";
import { encodeBoomboxAction, encodeDashcamSaveClipAction, VEHICLE_ACTION } from "../signed/messages.js";
import type { ToolArgs, ToolContext } from "../context.js";
import { bad, classifySendFailure, offlineVin, pairingHint, requireIntent, scopeHint } from "./commands.js";
import { CONFIRM_PROPS, VIN_PROP } from "./schema.js";
import type { ToolDef } from "./types.js";
import { KEY_TEXT, keyAclWarning, keyCode, loadKey, signedClientOptions, statKey } from "./video.js";

const TRANSPORT = "signed_command (Fleet API, signed locally)";

type Extra = {
  tool: string;
  /** Action field name, for output and audit. */
  actionName: string;
  vehicleAction: number;
  /** Validates args and builds the CarServer.Action bytes. */
  build: (args: ToolArgs) => { action: Buffer; info?: Record<string, unknown> };
  /** Noun for messages ("dashcam save", "boombox sound"). */
  noun: string;
  /** Optional clearer code/hint for a known vehicle rejection reason. */
  explainRejection?: (reason: string) => { code: string; hint: string } | undefined;
};

async function audit(ctx: ToolContext, x: Extra, e: { event: AuditEvent; [k: string]: unknown }): Promise<boolean> {
  return ctx.audit.write({ ...e, tool: x.tool, experimental: true });
}

async function refuse(ctx: ToolContext, x: Extra, base: Record<string, unknown>, err: LocalRefusal): Promise<never> {
  await audit(ctx, x, { ...base, event: "refused", code: err.code });
  throw err;
}

async function runExtra(x: Extra, args: ToolArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const preVin = offlineVin(args, ctx);
  const fullVin = ctx.config.auditFullVin;
  const base: Record<string, unknown> = { vin: auditVin(preVin, { confirmed: false, fullVin }) };
  let built: { action: Buffer; info?: Record<string, unknown> };
  try {
    built = x.build(args);
  } catch (e) {
    if (e instanceof LocalRefusal) return refuse(ctx, x, base, e);
    throw e;
  }
  if (built.info) Object.assign(base, built.info);
  const actionInfo = { vehicleAction: x.vehicleAction, name: x.actionName, payloadBytes: built.action.length };

  if (args.confirm !== true) {
    const keySt = statKey(ctx.config.commandKeyFile);
    await audit(ctx, x, { ...base, event: "dry_run", mode: "no_confirm" });
    return {
      dryRun: true, sent: false, command: x.tool, experimental: true, transport: TRANSPORT, action: actionInfo, ...(built.info ?? {}),
      vinLast4: preVin ? preVin.slice(-4) : "(resolved at send time)",
      commandKey: KEY_TEXT[keySt],
      ...(await keyAclWarning(ctx.config.commandKeyFile, keySt)),
      wouldCheckFirst: ["GET /api/1/vehicles/{vin} (must be online)", "POST /api/1/vehicles/fleet_status (key paired)"],
      estimatedBillableCalls: `2 commands (session handshake + ${x.actionName}) after the 2 checks`,
      toSend: "Ask the user to confirm, then call again with confirm=true and user_request.",
    };
  }
  try {
    requireIntent(args);
  } catch (e) {
    if (e instanceof LocalRefusal) return refuse(ctx, x, base, e);
    throw e;
  }

  const keyed = loadKey(ctx.config.commandKeyFile);
  if (ctx.config.dryRun) {
    await audit(ctx, x, { ...base, event: "dry_run", mode: "TESLA_FLEET_DRY_RUN" });
    const url = `<fleet base>/api/1/vehicles/${preVin ? maskVin(preVin) : "{vin}"}/signed_command`;
    return {
      dryRun: true, dryRunMode: "TESLA_FLEET_DRY_RUN", sent: false, command: x.tool, experimental: true,
      transport: TRANSPORT, action: actionInfo, ...(built.info ?? {}),
      wouldSend: [
        { method: "POST", url, body: { routable_message: "<session_info_request, base64>" } },
        { method: "POST", url, body: { routable_message: `<HMAC-signed CarServer.Action ${x.actionName}, base64>` } },
      ],
      vinLast4: preVin ? preVin.slice(-4) : "(resolved at send time)",
      commandKey: KEY_TEXT[keyed.status],
      ...(await keyAclWarning(ctx.config.commandKeyFile, keyed.status)),
      note: "Validated only; no network call was made.",
    };
  }
  if (!keyed.key) {
    return refuse(ctx, x, base, new LocalRefusal(keyCode(keyed.status), `${KEY_TEXT[keyed.status]} Nothing was sent.`,
      keyed.status === "insecure_permissions" || keyed.status === "wrong_owner"
        ? "chmod 600 the key file and make sure it is owned by the user that runs this server."
        : "Run this server on the host that holds the virtual-key private key and set TESLA_FLEET_COMMAND_KEY_FILE to its path. Never copy the key into a repo."));
  }
  const auditDown = () => new LocalRefusal("audit_log_unavailable", "The audit log could not be written, so this experimental command was not sent.",
    "Fix TESLA_FLEET_AUDIT_LOG (or the token store directory) permissions and try again.");
  if (!(await ctx.audit.checkWritable())) throw auditDown();

  let vin: string;
  try {
    vin = await ctx.fleet.resolveVin(args.vin);
    const fromList = !(typeof args.vin === "string" && args.vin.trim()) && !ctx.config.defaultVin;
    base.vin = auditVin(vin, { confirmed: fromList, fullVin });
    await ctx.fleet.requireOnline(vin);
    base.vin = auditVin(vin, { confirmed: true, fullVin });
    const fsx = await ctx.fleet.fleetStatus(vin);
    if (fsx.paired === false) throw new LocalRefusal("virtual_key_missing", "This app's virtual key is not paired with the vehicle; nothing was sent.", pairingHint(ctx));
  } catch (e) {
    if (e instanceof LocalRefusal) return refuse(ctx, x, base, e);
    await audit(ctx, x, { ...base, event: "failure", stage: "pre_checks", sent: false, code: e instanceof FleetApiError ? e.info.code : "error" });
    throw e;
  }
  if (!(await audit(ctx, x, { ...base, event: "attempt", transport: "signed_command" }))) throw auditDown();

  const client = new SignedCommandClient(keyed.key, (v, b64) => ctx.fleet.signedCommand(v, b64), signedClientOptions.value);
  const vinLast4 = vin.slice(-4);
  const head = { command: x.tool, experimental: true, vinLast4, ...(built.info ?? {}) };
  try {
    const r = await client.sendInfotainmentAction(vin, built.action);
    if (r.status === "ok") {
      const verified = r.authenticatedResponse;
      await audit(ctx, x, { ...base, event: "result", outcome: verified ? "accepted" : "accepted_unverified", authenticatedResponse: verified });
      return {
        ok: true, sent: true, ...head, authenticatedResponse: verified,
        message: verified
          ? `The vehicle accepted the ${x.noun} (authenticated reply). EXPERIMENTAL: acceptance does not prove it happened; ask the user.`
          : `A reply reporting success came back, but it was not encrypted, so it could not be verified. Treat the ${x.noun} as UNVERIFIED and ask the user.`,
      };
    }
    if (r.status === "rejected") {
      await audit(ctx, x, { ...base, event: "result", outcome: "rejected", reason: r.reason ?? null, authenticatedResponse: r.authenticatedResponse });
      const known = r.reason ? x.explainRejection?.(r.reason) : undefined;
      return { ok: false, sent: true, ...head, code: known?.code ?? "vehicle_rejected", reason: r.reason ?? "no reason given", message: `Vehicle rejected the ${x.noun}: ${r.reason ?? "no reason given"}.`, ...(known ? { hint: known.hint } : {}) };
    }
    await audit(ctx, x, { ...base, event: "result", outcome: "fault", fault: r.fault });
    return {
      ok: false, sent: true, executed: false, ...head, code: "vehicle_protocol_fault", fault: r.fault,
      message: `The vehicle refused the signed message (${r.fault}); the action was not executed. Do not resend blindly.`,
      ...(r.fault === "invalid_command" || r.fault === "decoding" ? { hint: `This firmware may not support ${x.actionName}.` } : {}),
    };
  } catch (e) {
    const phase = e instanceof SignedPhaseError ? e.phase : "command";
    const inner = e instanceof SignedPhaseError ? e.inner : e;
    if (inner instanceof FleetApiError) {
      if (inner.info.code === "virtual_key_missing") inner.info.hint = pairingHint(ctx);
      if (inner.info.code === "missing_scope") inner.info.hint = scopeHint("vehicle_cmds");
    }
    const code = inner instanceof SignedCommandError ? inner.code : inner instanceof FleetApiError ? inner.info.code : inner instanceof LocalRefusal ? inner.code : "error";
    if (phase === "before_send") {
      await audit(ctx, x, { ...base, event: "failure", stage: "handshake", sent: false, code });
      if (inner instanceof LocalRefusal || inner instanceof FleetApiError) throw inner;
      if (inner instanceof SignedCommandError) {
        throw new LocalRefusal(inner.code, `${inner.message} The ${x.noun} was not sent.`, inner.code === "virtual_key_missing" ? pairingHint(ctx) : undefined);
      }
      const f = classifySendFailure(inner, "fleet");
      throw new LocalRefusal(f?.kind === "not_sent" ? f.code : "handshake_failed",
        `Session handshake failed (${f?.kind === "unknown" ? f.detail : inner instanceof Error ? inner.message : String(inner)}); the ${x.noun} was not sent.`);
    }
    if (inner instanceof LocalRefusal) {
      await audit(ctx, x, { ...base, event: "failure", stage: "command", sent: false, code: inner.code });
      throw inner;
    }
    const f = classifySendFailure(inner, "fleet");
    if (f?.kind === "unknown" || inner instanceof SignedCommandError) {
      const detail = f?.kind === "unknown" ? f.detail : `${(inner as SignedCommandError).code}: ${(inner as Error).message}`;
      await audit(ctx, x, { ...base, event: "failure", stage: "command", sent: "unknown", code: "state_unknown", cause: f?.kind === "unknown" ? f.detail : code });
      return {
        ok: false, sent: "unknown", ...head, code: "state_unknown", cause: detail,
        message: `The ${x.noun} may or may not have reached the vehicle (${detail}). It was not retried; do not resend blindly.`,
      };
    }
    await audit(ctx, x, {
      ...base, event: "failure", stage: "command", sent: false, code: f?.kind === "not_sent" ? f.code : code,
      ...(inner instanceof FleetApiError ? { rejectedBy: "fleet_api", httpStatus: inner.info.status } : {}),
    });
    if (f?.kind === "not_sent") return { ok: false, sent: false, ...head, code: f.code, error: f.message };
    throw inner;
  }
}

const COMMON = "Signed locally with the virtual key (TESLA_FLEET_COMMAND_KEY_FILE) and sent via Fleet API signed_command, not the proxy: 2 billed command requests (handshake + command). Without confirm=true returns a dry-run. Requires the vehicle to be online already (never auto-wakes). Every call is audit-logged. Field numbers are community-documented (not in Tesla's published protos).";

const DASHCAM: Extra = {
  tool: "dashcam_save_clip", actionName: "dashcamSaveClipAction", vehicleAction: VEHICLE_ACTION.DASHCAM_SAVE_CLIP, noun: "dashcam save",
  build: () => ({ action: encodeDashcamSaveClipAction() }),
};

/** Tesla Fleet API docs, remote_boombox: 0 = random fart, 2000 = locate ping. Nothing else is sent. */
export const BOOMBOX_SOUNDS: Record<string, number> = { fart: 0, locate_ping: 2000 };

const BOOMBOX: Extra = {
  tool: "remote_boombox", actionName: "boomboxAction", vehicleAction: VEHICLE_ACTION.BOOMBOX, noun: "boombox sound",
  build: (a) => {
    if (typeof a.sound !== "string" || !Object.hasOwn(BOOMBOX_SOUNDS, a.sound)) bad("sound must be fart or locate_ping");
    const id = BOOMBOX_SOUNDS[a.sound as string];
    return { action: encodeBoomboxAction(id), info: { sound: a.sound, soundId: id } };
  },
  // The car's own check (seen in field tests here, and reported in teslamotors/vehicle-command#266).
  // Phrase match, not an exact match: any reason containing this phrase (case-insensitive) maps.
  explainRejection: (reason) => /locate ping only allowed in robotaxi mode/i.test(reason)
    ? { code: "locate_ping_robotaxi_only", hint: "The car only plays locate_ping in robotaxi mode under 10 mph. Ask before trying sound fart instead; do not retry locate_ping." }
    : undefined,
};

function extraTool(x: Extra, title: string, description: string, props: Record<string, unknown> = {}, required?: string[]): ToolDef {
  return {
    kind: "command",
    optIn: "experimental",
    tool: {
      name: x.tool,
      title,
      description: `EXPERIMENTAL, OPT-IN (TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS). ${description} ${COMMON}`,
      inputSchema: { type: "object", properties: { ...VIN_PROP, ...props, ...CONFIRM_PROPS }, ...(required ? { required } : {}) },
    },
    handler: (args, ctx) => runExtra(x, args, ctx),
  };
}

export const EXPERIMENTAL_SIGNED_TOOLS: ToolDef[] = [
  extraTool(DASHCAM, "Save dashcam clip (experimental)",
    "Save the last few minutes of dashcam footage on the car's USB drive (VehicleAction 47). Field-tested once on one car (a manual-save entry appeared)."),
  extraTool(BOOMBOX, "Play boombox sound (experimental)",
    "Play a sound through the car's external speaker (VehicleAction 64): fart (sound id 0) or locate_ping (sound id 2000), the two ids in Tesla's Fleet API docs. locate_ping only works in robotaxi mode under 10 mph: owner cars refuse it (code locate_ping_robotaxi_only, reason 'RemoteBoombox locate ping only allowed in robotaxi mode under 10 mph'), including with the owner outside the parked car and the phone key inside (field-tested here; also reported by others), so on an owner's car use fart. fart (id 0, an empty BoomboxAction) is field-tested here: accepted and heard from outside the car. The refusal is recognised by a case-insensitive phrase match on 'locate ping only allowed in robotaxi mode' anywhere in the car's reason text, so small wording changes around it still map. No unsigned REST fallback: Fleet API answers remote_boombox with 403 on cars that require signed commands, and the stock proxy has no handler. Noisy and public: only when the person asks.",
    { sound: { type: "string", enum: Object.keys(BOOMBOX_SOUNDS) } }, ["sound"]),
];
