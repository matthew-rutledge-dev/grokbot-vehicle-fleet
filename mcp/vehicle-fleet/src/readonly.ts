/**
 * Read-only switch for the vehicle-fleet MCP server. FAILS CLOSED.
 *
 * Commands are exposed ONLY when TESLA_FLEET_READ_ONLY is an explicit,
 * recognised off value (0 / false / no / off, any case). Everything else -
 * unset, empty, an unexpanded ${...} placeholder, an on value, or any
 * unrecognised value - means read-only (command tools hidden and refused).
 */
import { OFF_VALUES, ON_VALUES, PLACEHOLDER } from "./env.js";

export const READ_ONLY_ENV = "TESLA_FLEET_READ_ONLY";

export type ReadOnlySource = "unset" | "on" | "off" | "unrecognised";

export type ReadOnlyResolution = {
  readOnly: boolean;
  source: ReadOnlySource;
  /** Trimmed flag value (max 32 chars); never another env var. */
  raw?: string;
  unsetKind?: "not set" | "empty" | "unexpanded placeholder";
  warning?: string;
};

const RAW_MAX = 32;

export function resolveReadOnly(value: string | undefined | null): ReadOnlyResolution {
  if (typeof value !== "string") return { readOnly: true, source: "unset", unsetKind: "not set" };
  const trimmed = value.trim();
  if (trimmed === "") return { readOnly: true, source: "unset", unsetKind: "empty" };
  if (PLACEHOLDER.test(trimmed)) {
    return { readOnly: true, source: "unset", unsetKind: "unexpanded placeholder" };
  }
  const raw = trimmed.slice(0, RAW_MAX);
  const v = trimmed.toLowerCase();
  if (OFF_VALUES.includes(v)) return { readOnly: false, source: "off", raw };
  if (ON_VALUES.includes(v)) return { readOnly: true, source: "on", raw };
  return {
    readOnly: true,
    source: "unrecognised",
    raw,
    warning: `vehicle-fleet: ${READ_ONLY_ENV}=${JSON.stringify(raw)} is not a recognised value; staying read-only (command tools hidden). Use 0/false/no/off to enable commands.`,
  };
}

export function describeReadOnly(r: ReadOnlyResolution): string {
  const shown = r.raw !== undefined ? JSON.stringify(r.raw) : "";
  switch (r.source) {
    case "off":
      return `read-only OFF (${READ_ONLY_ENV}=${shown}, explicit off value; commands need confirm=true)`;
    case "on":
      return `read-only ON (${READ_ONLY_ENV}=${shown})`;
    case "unrecognised":
      return `read-only ON (${READ_ONLY_ENV}=${shown}, unrecognised value, fails closed)`;
    default:
      return `read-only ON (${READ_ONLY_ENV} unset: ${r.unsetKind ?? "not set"}; default)`;
  }
}
