---
name: vehicle-fleet-status
description: use this when the user asks about their car's battery, range, charging, cabin temperature, doors, locks, trunk, windows, tire pressure, whether it is asleep, or where it is
---

# Vehicle fleet status (reads)

Read tools need no confirm and never wake the car.

## Cheapest path

1. One question about one area: call the matching tool with defaults (cached data):
   `get_battery_charge`, `get_climate`, `get_closures`, `get_tires`.
2. Several areas: one `get_vehicle_snapshot` call (`sections` optional).
3. Cached data can be hours old: report the `timestamp` / age in plain words ("as of about 2 hours ago").
4. Need fresher data? Check `get_vehicle_state`. If `online`, repeat with `live=true`. If `asleep`/`offline`, say so and offer `wake_vehicle` (only if commands are enabled; it costs a wake). Never loop.

## Notes

- Tire pressures come in bar; the tool adds psi. Mention soft/hard warnings if present.
- Closure codes: `0` = closed; anything else = open.
- `get_location` (only if enabled): coarse by default; the car shows a location-sharing indicator on each read; nothing is stored.
- No VIN given: the tool uses `TESLA_DEFAULT_VIN` or the only car; with several cars, ask which one (last 4 of VIN or name).
- Energy products (Powerwall/solar) are not supported in v0.1.
