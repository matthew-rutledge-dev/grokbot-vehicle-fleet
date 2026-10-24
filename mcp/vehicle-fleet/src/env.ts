/**
 * Environment helpers.
 *
 * Some hosts pass unset plugin variables through literally (for example
 * TESLA_DEFAULT_VIN="${TESLA_DEFAULT_VIN}"). Those, and empty or whitespace-only
 * values, are treated as unset so they never reach the Fleet API.
 */
export const PLACEHOLDER = /^\$\{[^}]*\}$/;

export type Env = Record<string, string | undefined>;

export function isUnsetValue(value: string | undefined | null): boolean {
  if (typeof value !== "string") return true;
  const v = value.trim();
  return v === "" || PLACEHOLDER.test(v);
}

/** Trimmed env value, or undefined when unset, empty, or an unexpanded ${...} placeholder. */
export function readEnv(name: string, env: Env = process.env): string | undefined {
  const raw = env[name];
  return isUnsetValue(raw) ? undefined : (raw as string).trim();
}

export const ON_VALUES = ["1", "true", "yes", "on"];
export const OFF_VALUES = ["0", "false", "no", "off"];

/** Opt-in flag: true only for a recognised on value. Anything else (incl. junk) is off. */
export function readOptInFlag(name: string, env: Env = process.env): boolean {
  const v = readEnv(name, env);
  return v !== undefined && ON_VALUES.includes(v.toLowerCase());
}
