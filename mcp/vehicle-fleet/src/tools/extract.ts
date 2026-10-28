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
  "scheduled_charging_mode", "scheduled_charging_start_time", "scheduled_charging_pending",
  "charge_current_request_max", "preconditioning_enabled",
] as const;

export const CLIMATE_FIELDS = [
  "inside_temp", "outside_temp", "driver_temp_setting", "passenger_temp_setting", "is_climate_on",
  "is_auto_conditioning_on", "is_preconditioning", "climate_keeper_mode", "defrost_mode",
  "is_front_defroster_on", "is_rear_defroster_on", "fan_status", "cabin_overheat_protection",
  "seat_heater_left", "seat_heater_right", "seat_heater_rear_left", "seat_heater_rear_center", "seat_heater_rear_right",
  "steering_wheel_heater", "steering_wheel_heat_level", "auto_steering_wheel_heat",
  "auto_seat_climate_left", "auto_seat_climate_right", "cop_activation_temperature",
  "min_avail_temp", "max_avail_temp",
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

/**
 * Security / access state (vehicle_state). Names per the vehicle_data_equivalent column of Tesla's Fleet
 * Telemetry field list; valet_pin_needed per vehicle.proto VehicleState. Tesla's list swaps the two
 * HomeLink descriptions (homelink_nearby is the boolean, homelink_device_count the number).
 */
export const SECURITY_FIELDS = ["valet_mode", "valet_pin_needed", "speed_limit_mode", "homelink_nearby", "homelink_device_count"] as const;
export const SPEED_LIMIT_FIELDS = ["active", "current_limit_mph", "max_limit_mph", "min_limit_mph", "pin_code_set"] as const;

export function securitySummary(f: Record<string, unknown>): Record<string, unknown> {
  const slm = pick(f.speed_limit_mode, SPEED_LIMIT_FIELDS);
  return {
    valetMode: f.valet_mode,
    valetPinNeeded: f.valet_pin_needed,
    speedLimitMode: Object.keys(slm).length ? slm : undefined,
    homelinkNearby: f.homelink_nearby,
    homelinkDeviceCount: f.homelink_device_count,
  };
}

/** Media (vehicle_state.media_info / media_state; live only: cached data never has media). */
export const MEDIA_INFO_FIELDS = [
  "audio_volume", "audio_volume_increment", "audio_volume_max", "media_playback_status", "now_playing_source",
  "now_playing_title", "now_playing_artist", "now_playing_album", "now_playing_station", "now_playing_duration",
  "now_playing_elapsed", "a2dp_source_name",
] as const;

/** Schedule fields kept (ids, names, days, times). Schedule latitude/longitude are left out. */
export const CHARGE_SCHEDULE_FIELDS = ["id", "name", "days_of_week", "start_enabled", "start_time", "end_enabled", "end_time", "one_time", "enabled"] as const;
export const PRECONDITION_SCHEDULE_FIELDS = ["id", "name", "days_of_week", "precondition_time", "one_time", "enabled"] as const;

const DAY_BITS: Array<[number, string]> = [[1, "Sun"], [2, "Mon"], [4, "Tue"], [8, "Wed"], [16, "Thu"], [32, "Fri"], [64, "Sat"]];

/** days_of_week bitmask (Sun = 1 ... Sat = 64, per vehicle-command's proxy) to day names. */
export function daysOf(mask: unknown): string[] | undefined {
  if (typeof mask !== "number" || !Number.isInteger(mask) || mask < 0) return undefined;
  return DAY_BITS.filter(([b]) => (mask & b) !== 0).map(([, d]) => d);
}

/** Minutes after midnight to "HH:MM". */
export function hhmm(min: unknown): string | undefined {
  if (typeof min !== "number" || !Number.isInteger(min) || min < 0 || min >= 24 * 60) return undefined;
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Firmware, pending software update, odometer, service mode (vehicle_state; names per the Fleet Telemetry field mapping). */
export const STATUS_FIELDS = ["car_version", "odometer", "service_mode", "software_update"] as const;
export const SOFTWARE_UPDATE_FIELDS = [
  "status", "version", "download_perc", "install_perc", "expected_duration_sec", "scheduled_time_ms",
] as const;

const BAR_TO_PSI = 14.5038;
const MI_TO_KM = 1.609344;

/** Status section: firmware, update in progress / available, odometer (miles, km added), service mode. */
export function statusSummary(f: Record<string, unknown>): Record<string, unknown> {
  const u = pick(f.software_update, SOFTWARE_UPDATE_FIELDS);
  const version = typeof f.car_version === "string" ? f.car_version.split(" ")[0] : undefined;
  const odo = typeof f.odometer === "number" ? f.odometer : undefined;
  const pending = typeof u.version === "string" && u.version.trim() !== "" && u.version.trim() !== version;
  return {
    firmware: version,
    softwareUpdate: Object.keys(u).length ? {
      ...u,
      scheduledFor: typeof u.scheduled_time_ms === "number" && u.scheduled_time_ms > 0 ? new Date(u.scheduled_time_ms).toISOString() : undefined,
      pending,
    } : undefined,
    odometer: odo === undefined ? undefined : { mi: Math.round(odo * 10) / 10, km: Math.round(odo * MI_TO_KM * 10) / 10 },
    serviceMode: f.service_mode,
  };
}

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

/**
 * TPMS: pressures are reported in bar; add psi, and psi below the recommended cold pressure when the car
 * reports it. psiBelowRecommended is never negative: 0 means at or above the recommended pressure.
 */
export function tireSummary(f: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pos of ["fl", "fr", "rl", "rr"]) {
    const bar = f[`tpms_pressure_${pos}`];
    const rcp = f[pos[0] === "f" ? "tpms_rcp_front_value" : "tpms_rcp_rear_value"];
    out[pos] = {
      bar: typeof bar === "number" ? Math.round(bar * 100) / 100 : null,
      psi: typeof bar === "number" ? Math.round(bar * BAR_TO_PSI * 10) / 10 : null,
      softWarning: f[`tpms_soft_warning_${pos}`],
      hardWarning: f[`tpms_hard_warning_${pos}`],
      recommendedPsi: typeof rcp === "number" && rcp > 0 ? Math.round(rcp * BAR_TO_PSI * 10) / 10 : undefined,
      psiBelowRecommended: typeof rcp === "number" && rcp > 0 && typeof bar === "number"
        ? Math.max(0, Math.round((rcp - bar) * BAR_TO_PSI * 10) / 10) : undefined,
      lastSeen: typeof f[`tpms_last_seen_pressure_time_${pos}`] === "number"
        ? new Date((f[`tpms_last_seen_pressure_time_${pos}`] as number) * 1000).toISOString() : undefined,
    };
  }
  return out;
}
