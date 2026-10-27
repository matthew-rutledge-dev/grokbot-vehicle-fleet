/** Fleet API error mapping (developer.tesla.com, Conventions -> Response Codes). */

export type FleetErrorInfo = {
  status: number;
  code: string;
  message: string;
  hint?: string;
  retryAfterSec?: number;
  /** Tesla bills every response below 500 (Billing and Limits). */
  billed: boolean;
};

export class FleetApiError extends Error {
  readonly info: FleetErrorInfo;
  constructor(info: FleetErrorInfo) {
    super(info.message);
    this.name = "FleetApiError";
    this.info = info;
  }
}

/** Local refusal that never reached the network (not billed). */
export class LocalRefusal extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly extra?: Record<string, unknown>;
  constructor(code: string, message: string, hint?: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = "LocalRefusal";
    this.code = code;
    this.hint = hint;
    this.extra = extra;
  }
}

function parseRetryAfter(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  for (const h of ["retry-after", "ratelimit-reset"]) {
    const v = headers.get(h);
    if (v && /^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function mapFleetError(
  status: number,
  body: unknown,
  headers?: Headers,
): FleetApiError {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const err = str(b.error);
  const desc = str(b.error_description);
  const text = `${err} ${desc}`.toLowerCase();
  const billed = status < 500;
  const base = { status, billed };
  const mk = (code: string, message: string, hint?: string, extra: Partial<FleetErrorInfo> = {}) =>
    new FleetApiError({ ...base, code, message, hint, ...extra });

  switch (status) {
    case 401:
      if (text.includes("login_required"))
        return mk("login_required", "Refresh token expired, already used, revoked, or the password was reset.",
          "Re-consent with scripts/auth-helper.mjs (skill vehicle-fleet-setup), then reload the MCP server.");
      if (text.includes("mobile_access_disabled"))
        return mk("mobile_access_disabled", "The vehicle has remote (mobile) access turned off.",
          "Enable mobile access in the vehicle's settings.");
      return mk("unauthorized", "Access token rejected or expired.");
    case 402:
      return mk("payment_required", "The developer account needs a payment method or a higher billing limit.",
        "Check billing on the developer portal.");
    case 403:
      if (text.includes("command protocol"))
        return mk("command_protocol_required", "This vehicle requires signed commands (Vehicle Command Protocol).",
          "Set TESLA_COMMAND_PROXY_URL to your own tesla-http-proxy.");
      if (/scope/.test(text))
        return mk("missing_scope", "Not authorized: the token is missing an OAuth scope this endpoint needs.",
          "Re-consent with the scopes this tool needs (see skill vehicle-fleet-troubleshoot).");
      return mk("forbidden", "Forbidden: the Fleet API refused this request for this account or resource.",
        "Check that the account owns or shares this vehicle or site; if it persists, see skill vehicle-fleet-troubleshoot.");
    case 404:
      return mk("not_found", desc || err || "Resource not found (or no cached data for this vehicle).");
    case 408:
      return mk("vehicle_unavailable", "Vehicle is asleep, offline, or has poor connectivity (this request was still billed).",
        "Do not retry in a loop. Ask the user before calling wake_vehicle, or try again later.");
    case 412:
      if (text.includes("regist"))
        return mk("partner_not_registered", "The developer app is not registered in this region.",
          "Call the partner register endpoint for this region (skill vehicle-fleet-setup).");
      return mk("precondition_failed", desc || err || "Precondition failed (e.g. cached data not supported for this vehicle).");
    case 421:
      return mk("wrong_region", "This account is not in the configured Fleet API region.",
        "Unset TESLA_FLEET_BASE_URL/TESLA_FLEET_REGION to auto-detect, or set the right region.");
    case 422:
      if (text.includes("not_paired") || text.includes("unsigned") || text.includes("key"))
        return mk("virtual_key_missing", "The app's virtual key is not paired with this vehicle.",
          "Pair the key with https://www.tesla.com/_ak/<your-domain> in the Tesla app.");
      return mk("invalid_resource", desc || err || "Invalid request data.");
    case 423:
      return mk("account_locked", "The account is locked and must be unlocked by Tesla.");
    case 429:
      return mk("rate_limited", "Fleet API rate limit reached.", "Wait for retryAfterSec before trying again; do not loop.",
        { retryAfterSec: parseRetryAfter(headers) });
    case 451:
      return mk("unavailable_legal", "Resource unavailable for legal/privacy reasons (often wrong region).");
    case 540:
      return mk("device_error", "Vehicle responded with an unexpected error (may need a reboot or service).");
    default:
      if (status >= 500)
        return mk("server_error", `Fleet API server error (${status}); not billed.`, "Try again later.");
      return mk(err || "http_error", desc || err || `HTTP ${status}`);
  }
}

/** Friendly reading of command `reason` values documented on the commands page. */
/**
 * tesla-http-proxy wraps the car's reason as "car could not execute command: <reason>"
 * (vehicle-command pkg/vehicle/infotainment.go). Strip that prefix (any case), trim and
 * lower-case so "already_set" matches in both forms.
 */
export const PROXY_REASON_PREFIX = /^\s*car could not execute command:\s*/i;
// The proxy also reports security-controller failures as "vcsec could not execute command: ...".
// That prefix is deliberately NOT stripped: such reasons never match a no-op entry and stay
// rejections (fails safe).
export function normalizeCommandReason(reason: unknown): string {
  if (typeof reason !== "string") return "";
  return reason.replace(PROXY_REASON_PREFIX, "").trim().toLowerCase();
}

/**
 * No-op reasons, scoped to the command endpoint that can return them. A reason that is not on
 * its own command's list is a rejection (e.g. charge_start + "disconnected" is a failure).
 */
export const NOOP_REASONS_BY_COMMAND: Record<string, Record<string, string>> = {
  set_charge_limit: { already_set: "Already at the requested value." },
  set_charging_amps: { already_set: "Already at the requested value." },
  charge_start: {
    is_charging: "Already charging.",
    complete: "Charging is already complete.",
    requested: "A start-charge request is already pending.",
  },
  charge_stop: { not_charging: "The vehicle was not charging." },
  // Not exposed as tools; kept so the mapping matches the documented reasons.
  charge_standard: { already_started: "Already started." },
  charge_max_range: { already_started: "Already started." },
  charge_port_door_close: { "already closed": "The charge port door is already closed." },
};

/** Friendly text for known rejection reasons (still failures). */
export const REJECTION_REASON_TEXT: Record<string, string> = {
  disconnected: "No charger is connected.",
  no_power: "The connected charger is not providing power.",
};

/** No-op message for this command + normalised reason, or undefined (= rejection). */
export function noopMessage(endpoint: string, reason: string): string | undefined {
  const m = NOOP_REASONS_BY_COMMAND[endpoint];
  return m && Object.hasOwn(m, reason) ? m[reason] : undefined;
}
