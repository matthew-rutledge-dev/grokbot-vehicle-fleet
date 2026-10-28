/**
 * EXPERIMENTAL: play_video_on_screen. Asks the vehicle to open a video URL on
 * its center screen via CarServer VehicleAction.videoRequestAction (57), a
 * community-documented action that is not in Tesla's published protos and that
 * stock tesla-http-proxy has no endpoint for. Sent with the local
 * signed_command helper (src/signed), so it needs the virtual-key private key
 * on this host (TESLA_FLEET_COMMAND_KEY_FILE).
 *
 * Gating: a command tool (hidden and refused unless TESLA_FLEET_READ_ONLY is
 * explicitly off); confirm=true + user_request; hosts not on
 * TESLA_FLEET_VIDEO_HOST_ALLOWLIST also need allow_unlisted_host=true (an
 * unset allowlist means every host needs it); TESLA_FLEET_DRY_RUN honoured.
 * Every call is audited (src/audit.ts): the full VIN only for a car confirmed
 * on the account (TESLA_FLEET_AUDIT_FULL_VIN=0: last 6; unconfirmed: last 4),
 * the URL host and a keyed path hash, never the full URL.
 */
import fs from "node:fs";
import { auditVin, type AuditEvent } from "../audit.js";
import { FleetApiError, LocalRefusal } from "../errors.js";
import { maskVin } from "../redact.js";
import { loadPrivateKeyPem, SignedCommandError } from "../signed/crypto.js";
import { SignedCommandClient, SignedPhaseError, type SignedClientOptions } from "../signed/client.js";
import { encodeVideoRequestAction, VEHICLE_ACTION } from "../signed/messages.js";
import type { ToolArgs, ToolContext } from "../context.js";
import { classifySendFailure, offlineVin, pairingHint, requireIntent, scopeHint } from "./commands.js";
import { CONFIRM_PROPS, VIN_PROP } from "./schema.js";
import type { ToolDef } from "./types.js";
import { hostAllowed, MAX_VIDEO_URL_LENGTH, validateVideoUrl, type VideoUrl } from "./videourl.js";

export const PLAY_VIDEO_TOOL = "play_video_on_screen";
const TRANSPORT = "signed_command (Fleet API, signed locally)";

/** Test seam: signed-client options (clock / randomness). */
export const signedClientOptions: { value: SignedClientOptions } = { value: {} };

type KeyStatus = "ok" | "present" | "not_configured" | "unreadable" | "insecure_permissions" | "wrong_owner" | "invalid";

const POSIX = process.platform !== "win32" && typeof process.getuid === "function";

/**
 * Metadata-only check of the key file (never reads it). POSIX: must be a regular file owned by
 * this user with no group/other permission bits (chmod 600). Windows: existence only.
 */
export function statKey(file: string | undefined): KeyStatus {
  if (!file) return "not_configured";
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return "unreadable";
  }
  if (!st.isFile()) return "unreadable";
  if (POSIX) {
    if (st.uid !== process.getuid!()) return "wrong_owner";
    if (st.mode & 0o077) return "insecure_permissions";
  }
  return "present";
}

/** statKey, then read + parse (send paths only). */
function loadKey(file: string | undefined): { status: KeyStatus; key?: ReturnType<typeof loadPrivateKeyPem> } {
  const st = statKey(file);
  if (st !== "present") return { status: st };
  let pem: string;
  try {
    pem = fs.readFileSync(file!, "utf8");
  } catch {
    return { status: "unreadable" };
  }
  try {
    return { status: "ok", key: loadPrivateKeyPem(pem) };
  } catch {
    return { status: "invalid" };
  }
}

const KEY_TEXT: Record<KeyStatus, string> = {
  ok: "Command key loaded.",
  present: "Command key file present with private permissions (not read in a preview).",
  not_configured: "TESLA_FLEET_COMMAND_KEY_FILE is not set.",
  unreadable: "TESLA_FLEET_COMMAND_KEY_FILE could not be read (missing file or permissions).",
  insecure_permissions: "TESLA_FLEET_COMMAND_KEY_FILE is readable or writable by other users; run chmod 600 on it.",
  wrong_owner: "TESLA_FLEET_COMMAND_KEY_FILE is owned by another user; it must be owned by the user running this server (and chmod 600).",
  invalid: "TESLA_FLEET_COMMAND_KEY_FILE is not a P-256 EC private key in PEM format.",
};

/** Refusal code for a key status (wrong owner shares the permissions code). */
function keyCode(st: KeyStatus): string {
  return st === "wrong_owner" ? "command_key_insecure_permissions" : `command_key_${st}`;
}

function urlInfo(v: VideoUrl, pathHash: string): Record<string, unknown> {
  return { host: v.host, ...(v.port ? { port: v.port } : {}), pathHash };
}

async function audit(ctx: ToolContext, e: { event: AuditEvent; [k: string]: unknown }): Promise<boolean> {
  return ctx.audit.write({ ...e, tool: PLAY_VIDEO_TOOL, experimental: true });
}

/** Refuse locally (nothing sent) and audit it. */
async function refuse(ctx: ToolContext, base: Record<string, unknown>, err: LocalRefusal): Promise<never> {
  await audit(ctx, { ...base, event: "refused", code: err.code });
  throw err;
}

export const PLAY_VIDEO: ToolDef = {
  kind: "command",
  tool: {
    name: PLAY_VIDEO_TOOL,
    description: "EXPERIMENTAL: ask the vehicle to open a video URL on its center screen (CarServer videoRequestAction, community-documented, unverified on live vehicles; it may be rejected by Fleet API or the car, or do nothing). https only, public host names only (no IPs, localhost or private names, no credentials), max " + MAX_VIDEO_URL_LENGTH + " characters. Hosts not on TESLA_FLEET_VIDEO_HOST_ALLOWLIST also need allow_unlisted_host=true after the user explicitly approves that host (unset allowlist = every host). Signed locally with the virtual key (TESLA_FLEET_COMMAND_KEY_FILE) and sent via Fleet API signed_command, not the proxy: 2 billed command requests (handshake + command). Without confirm=true returns a dry-run. Requires the vehicle to be online already (never auto-wakes). Every call is audit-logged (host and a keyed path hash only). Non-default ports only when the allowlist entry names the port. The key file must be chmod 600 and owned by the server's user.",
    inputSchema: {
      type: "object",
      properties: {
        ...VIN_PROP,
        url: { type: "string", description: "https URL of the video. Sent to the vehicle as is; never logged or echoed (host + path hash only)." },
        allow_unlisted_host: {
          type: "boolean",
          description: "Second, separate approval: true only when the user explicitly approved sending a host that is not on TESLA_FLEET_VIDEO_HOST_ALLOWLIST. Ignored without confirm=true.",
        },
        ...CONFIRM_PROPS,
      },
      required: ["url"],
    },
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    const preVin = offlineVin(args, ctx);
    // Not yet confirmed on the account: last 4 only.
    const fullVin = ctx.config.auditFullVin;
    const base: Record<string, unknown> = { vin: auditVin(preVin, { confirmed: false, fullVin }) };

    let video: VideoUrl;
    try {
      video = validateVideoUrl(args.url);
    } catch (e) {
      if (e instanceof LocalRefusal) return refuse(ctx, base, e);
      throw e;
    }
    const pathHash = (await ctx.audit.keyedHash(video.pathAndQuery)) ?? "unavailable";
    const listed = hostAllowed(video.host, ctx.config.videoHostAllowlist, video.port);
    const allowUnlisted = args.allow_unlisted_host === true;
    Object.assign(base, { url: urlInfo(video, pathHash), hostAllowlisted: listed, allowUnlistedHost: allowUnlisted });
    if (video.port && !listed) {
      // A non-default port is never covered by allow_unlisted_host: only an allowlist entry that names it.
      return refuse(ctx, base, new LocalRefusal("video_port_not_allowed",
        `Port ${video.port} is not allowed for ${video.host}; nothing was sent.`,
        `Use the default https port, or add ${video.host}:${video.port} to TESLA_FLEET_VIDEO_HOST_ALLOWLIST.`));
    }
    const action = encodeVideoRequestAction(video.url);
    const actionInfo = { vehicleAction: VEHICLE_ACTION.VIDEO_REQUEST, name: "videoRequestAction", payloadBytes: action.length };

    if (args.confirm !== true) {
      await audit(ctx, { ...base, event: "dry_run", mode: "no_confirm" });
      return {
        dryRun: true, sent: false, command: PLAY_VIDEO_TOOL, experimental: true, transport: TRANSPORT,
        action: actionInfo, video: urlInfo(video, pathHash), hostAllowlisted: listed,
        ...(listed ? {} : { needsAllowUnlistedHost: true }),
        vinLast4: preVin ? preVin.slice(-4) : "(resolved at send time)",
        commandKey: KEY_TEXT[statKey(ctx.config.commandKeyFile)],
        wouldCheckFirst: ["GET /api/1/vehicles/{vin} (must be online)", "POST /api/1/vehicles/fleet_status (key paired)"],
        estimatedBillableCalls: "2 commands (session handshake + videoRequestAction) after the 2 checks",
        toSend: listed
          ? "Ask the user to confirm, then call again with confirm=true and user_request."
          : `Host ${video.host} is not on TESLA_FLEET_VIDEO_HOST_ALLOWLIST: ask the user to approve this host explicitly, then call again with confirm=true, allow_unlisted_host=true and user_request.`,
      };
    }

    try {
      requireIntent(args);
    } catch (e) {
      if (e instanceof LocalRefusal) return refuse(ctx, base, e);
      throw e;
    }
    if (!listed && !allowUnlisted) {
      return refuse(ctx, base, new LocalRefusal("video_host_not_allowlisted",
        `Host ${video.host} is not on TESLA_FLEET_VIDEO_HOST_ALLOWLIST; nothing was sent.`,
        "Ask the user to approve this host explicitly, then call again with allow_unlisted_host=true; or add the host to TESLA_FLEET_VIDEO_HOST_ALLOWLIST."));
    }

    const keyed = loadKey(ctx.config.commandKeyFile);
    if (ctx.config.dryRun) {
      await audit(ctx, { ...base, event: "dry_run", mode: "TESLA_FLEET_DRY_RUN" });
      return {
        dryRun: true, dryRunMode: "TESLA_FLEET_DRY_RUN", sent: false, command: PLAY_VIDEO_TOOL, experimental: true,
        transport: TRANSPORT, action: actionInfo, video: urlInfo(video, pathHash), hostAllowlisted: listed,
        wouldSend: [
          { method: "POST", url: `<fleet base>/api/1/vehicles/${preVin ? maskVin(preVin) : "{vin}"}/signed_command`, body: { routable_message: "<session_info_request, base64>" } },
          { method: "POST", url: `<fleet base>/api/1/vehicles/${preVin ? maskVin(preVin) : "{vin}"}/signed_command`, body: { routable_message: "<HMAC-signed CarServer.Action videoRequestAction, base64>" } },
        ],
        vinLast4: preVin ? preVin.slice(-4) : "(resolved at send time)",
        commandKey: KEY_TEXT[keyed.status],
        note: "Validated only; no network call was made.",
      };
    }

    if (!keyed.key) {
      return refuse(ctx, base, new LocalRefusal(keyCode(keyed.status), `${KEY_TEXT[keyed.status]} Nothing was sent.`,
        keyed.status === "insecure_permissions" || keyed.status === "wrong_owner"
          ? "chmod 600 the key file and make sure it is owned by the user that runs this server."
          : "Run this server on the host that holds the virtual-key private key (the same key your tesla-http-proxy uses) and set TESLA_FLEET_COMMAND_KEY_FILE to its path. Never copy the key into a repo."));
    }

    // Before any billable call: the attempt line must be writable, or nothing is sent.
    if (!(await ctx.audit.checkWritable())) {
      throw new LocalRefusal("audit_log_unavailable", "The audit log could not be written, so this experimental command was not sent.",
        "Fix TESLA_FLEET_AUDIT_LOG (or the token store directory) permissions and try again.");
    }

    let vin: string;
    try {
      vin = await ctx.fleet.resolveVin(args.vin);
      // Picked from the account's vehicle list (no vin passed, no default): confirmed. Otherwise confirmed by the online check below.
      const fromList = !(typeof args.vin === "string" && args.vin.trim()) && !ctx.config.defaultVin;
      base.vin = auditVin(vin, { confirmed: fromList, fullVin });
      await ctx.fleet.requireOnline(vin);
      base.vin = auditVin(vin, { confirmed: true, fullVin });
      const fsx = await ctx.fleet.fleetStatus(vin);
      if (fsx.paired === false) throw new LocalRefusal("virtual_key_missing", "This app's virtual key is not paired with the vehicle; nothing was sent.", pairingHint(ctx));
    } catch (e) {
      if (e instanceof LocalRefusal) return refuse(ctx, base, e);
      await audit(ctx, { ...base, event: "failure", stage: "pre_checks", sent: false, code: e instanceof FleetApiError ? e.info.code : "error" });
      throw e;
    }

    if (!(await audit(ctx, { ...base, event: "attempt", transport: "signed_command" }))) {
      throw new LocalRefusal("audit_log_unavailable", "The audit log could not be written, so this experimental command was not sent.",
        "Fix TESLA_FLEET_AUDIT_LOG (or the token store directory) permissions and try again.");
    }

    const client = new SignedCommandClient(keyed.key, (v, b64) => ctx.fleet.signedCommand(v, b64), signedClientOptions.value);
    const vinLast4 = vin.slice(-4);
    try {
      const r = await client.sendInfotainmentAction(vin, action);
      if (r.status === "ok") {
        const verified = r.authenticatedResponse;
        await audit(ctx, { ...base, event: "result", outcome: verified ? "accepted" : "accepted_unverified", authenticatedResponse: verified });
        return {
          ok: true, sent: true, command: PLAY_VIDEO_TOOL, experimental: true, vinLast4, video: urlInfo(video, pathHash),
          authenticatedResponse: verified,
          message: verified
            ? "The vehicle accepted the video request (authenticated reply). EXPERIMENTAL: acceptance does not prove the video played; ask the user what the screen shows."
            : "A reply reporting success came back, but it was not encrypted, so it could not be verified as the vehicle's answer (firmware before 2024.38?). Treat the outcome as UNVERIFIED and ask the user what the screen shows.",
        };
      }
      if (r.status === "rejected") {
        await audit(ctx, { ...base, event: "result", outcome: "rejected", reason: r.reason ?? null, authenticatedResponse: r.authenticatedResponse });
        return {
          ok: false, sent: true, command: PLAY_VIDEO_TOOL, experimental: true, vinLast4, code: "vehicle_rejected",
          reason: r.reason ?? "no reason given", message: `Vehicle rejected the video request: ${r.reason ?? "no reason given"}.`,
        };
      }
      await audit(ctx, { ...base, event: "result", outcome: "fault", fault: r.fault });
      return {
        ok: false, sent: true, executed: false, command: PLAY_VIDEO_TOOL, experimental: true, vinLast4, code: "vehicle_protocol_fault", fault: r.fault,
        message: `The vehicle refused the signed message (${r.fault}); the action was not executed. Do not resend blindly.`,
        ...(r.fault === "invalid_command" || r.fault === "decoding" ? { hint: "This firmware may not support videoRequestAction." } : {}),
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
        await audit(ctx, { ...base, event: "failure", stage: "handshake", sent: false, code });
        if (inner instanceof LocalRefusal || inner instanceof FleetApiError) throw inner;
        if (inner instanceof SignedCommandError) {
          throw new LocalRefusal(inner.code, `${inner.message} The video request was not sent.`,
            inner.code === "virtual_key_missing" ? pairingHint(ctx) : undefined);
        }
        const f = classifySendFailure(inner, "fleet");
        throw new LocalRefusal(f?.kind === "not_sent" ? f.code : "handshake_failed",
          `Session handshake failed (${f?.kind === "unknown" ? f.detail : inner instanceof Error ? inner.message : String(inner)}); the video request was not sent.`);
      }
      if (inner instanceof LocalRefusal) { // e.g. the local command rate limit: never left this host
        await audit(ctx, { ...base, event: "failure", stage: "command", sent: false, code: inner.code });
        throw inner;
      }
      const f = classifySendFailure(inner, "fleet");
      // Timeout / 408 / 5xx, or the request reached Fleet API but the reply was unusable (bad body, failed
      // authentication, undecodable): the command may have been delivered, so the state is unknown.
      if (f?.kind === "unknown" || inner instanceof SignedCommandError) {
        const detail = f?.kind === "unknown" ? f.detail : `${(inner as SignedCommandError).code}: ${(inner as Error).message}`;
        await audit(ctx, { ...base, event: "failure", stage: "command", sent: "unknown", code: "state_unknown", cause: f?.kind === "unknown" ? f.detail : code });
        return {
          ok: false, sent: "unknown", command: PLAY_VIDEO_TOOL, experimental: true, vinLast4,
          code: "state_unknown", cause: detail,
          message: `The video request may or may not have reached the vehicle (${detail}). It was not retried; do not resend blindly.`,
        };
      }
      // not_sent: connection never opened. A Fleet API 4xx is a refusal by Fleet API before the car acted.
      await audit(ctx, {
        ...base, event: "failure", stage: "command", sent: false, code: f?.kind === "not_sent" ? f.code : code,
        ...(inner instanceof FleetApiError ? { rejectedBy: "fleet_api", httpStatus: inner.info.status } : {}),
      });
      if (f?.kind === "not_sent") return { ok: false, sent: false, command: PLAY_VIDEO_TOOL, experimental: true, code: f.code, error: f.message };
      throw inner;
    }
  },
};
