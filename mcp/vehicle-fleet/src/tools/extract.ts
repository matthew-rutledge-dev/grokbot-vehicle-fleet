/** Field extraction from vehicle_data blocks. Field names follow the Fleet API vehicle_data response. */

export function pick(block: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!block || typeof block !== "object") return out;
  const b = block as Record<string, unknown>;
  for (const k of keys) if (k in b) out[k] = b[k];
  return out;
}

export function blockTimestamp(block: unknown): string | undefined {
  const t = (block as Record<string, unknown> | undefined)?.timestamp;
  return typeof t === "number" ? new Date(t).toISOString() : undefined;
}

export const CHARGE_FIELDS = [
  "battery_level", "usable_battery_level", "battery_range", "est_battery_range", "ideal_battery_range",
  "charge_limit_soc", "charging_state", "charge_rate", "charger_power", "charger_voltage", "charger_actual_current",
  "charge_amps", "charge_current_request", "minutes_to_full_charge", "time_to_full_charge",
  "charge_energy_added", "charge_port_door_open", "conn_charge_cable", "fast_charger_present",
  "scheduled_charging_mode", "scheduled_charging_start_time",
] as const;

export const CLIMATE_FIELDS = [
  "inside_temp", "outside_temp", "driver_temp_setting", "passenger_temp_setting", "is_climate_on",
  "is_auto_conditioning_on", "is_preconditioning", "climate_keeper_mode", "defrost_mode",
  "is_front_defroster_on", "is_rear_defroster_on", "fan_status", "cabin_overheat_protection",
  "seat_heater_left", "seat_heater_right", "steering_wheel_heater", "min_avail_temp", "max_avail_temp",
] as const;

export const CLOSURE_FIELDS = [
  "locked", "df", "dr", "pf", "pr", "ft", "rt", "fd_window", "fp_window", "rd_window", "rp_window",
  "sentry_mode", "is_user_present", "valet_mode", "remote_start", "sun_roof_state", "sun_roof_percent_open",
] as const;

export const TIRE_FIELDS = [
  "tpms_pressure_fl", "tpms_pressure_fr", "tpms_pressure_rl", "tpms_pressure_rr",
  "tpms_soft_warning_fl", "tpms_soft_warning_fr", "tpms_soft_warning_rl", "tpms_soft_warning_rr",
  "tpms_hard_warning_fl", "tpms_hard_warning_fr", "tpms_hard_warning_rl", "tpms_hard_warning_rr",
  "tpms_last_seen_pressure_time_fl", "tpms_last_seen_pressure_time_fr",
  "tpms_last_seen_pressure_time_rl", "tpms_last_seen_pressure_time_rr",
  "tpms_rcp_front_value", "tpms_rcp_rear_value",
] as const;

const BAR_TO_PSI = 14.5038;

/** Closure codes: 0 = closed, anything else = open/ajar. */
export function closureSummary(f: Record<string, unknown>): Record<string, unknown> {
  const open = (k: string) => (typeof f[k] === "number" ? (f[k] as number) !== 0 : undefined);
  const windows = { driverFront: open("fd_window"), passengerFront: open("fp_window"), driverRear: open("rd_window"), passengerRear: open("rp_window") };
  const windowsKnown = Object.values(windows).some((v) => v !== undefined);
  return {
    locked: f.locked,
    doorsOpen: { driverFront: open("df"), driverRear: open("dr"), passengerFront: open("pf"), passengerRear: open("pr") },
    trunksOpen: { front: open("ft"), rear: open("rt") },
    windowsOpen: windowsKnown ? windows : "unknown (not reported in this data; try live=true when online)",
    sentryMode: f.sentry_mode,
  };
}

/** TPMS: pressures are reported in bar; add psi. */
export function tireSummary(f: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pos of ["fl", "fr", "rl", "rr"]) {
    const bar = f[`tpms_pressure_${pos}`];
    out[pos] = {
      bar: typeof bar === "number" ? Math.round(bar * 100) / 100 : null,
      psi: typeof bar === "number" ? Math.round(bar * BAR_TO_PSI * 10) / 10 : null,
      softWarning: f[`tpms_soft_warning_${pos}`],
      hardWarning: f[`tpms_hard_warning_${pos}`],
      lastSeen: typeof f[`tpms_last_seen_pressure_time_${pos}`] === "number"
        ? new Date((f[`tpms_last_seen_pressure_time_${pos}`] as number) * 1000).toISOString() : undefined,
    };
  }
  return out;
}
