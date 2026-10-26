/** Shared JSON-schema fragments. */
export const VIN_PROP = {
  vin: {
    type: "string",
    description: "Vehicle VIN (e.g. 5YJ000000EXAMPLE). Optional for reads: falls back to TESLA_DEFAULT_VIN or the only vehicle on the account.",
  },
} as const;

export const LIVE_PROP = {
  live: {
    type: "boolean",
    description: "Default false = vehicle_data_cached (never wakes, may be hours old; check ageSec/timestamp). true = live read, only if the vehicle is already online (one billable data call). Never wakes the car.",
  },
} as const;

export const CONFIRM_PROPS = {
  confirm: {
    type: "boolean",
    description: "Must be true to actually send. Without it you get a dry-run preview and nothing is sent.",
  },
  user_request: {
    type: "string",
    description: "Required with confirm=true: a short quote of the human's explicit request in the current conversation. Commands must never be sent from routines, schedules, triggers, or an agent's own initiative (Fleet API Agreement 5.6.22: no automatic control).",
  },
} as const;
