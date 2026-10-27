---
name: vehicle-fleet-status
description: use this when the user asks about their car's battery, range, charging, cabin temperature, doors, locks, trunk, windows, tire pressure, whether it is asleep, or where it is, or about their Powerwall, solar, grid, home energy use or Wall Connector
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
- "How much have I used / what will it cost?": call `get_api_usage` (no network, not billed). Say it is a **local estimate** of this server's calls only (not Home Assistant or other apps), give this month's billable counts and the after-discount estimate, mention the `other` bucket is not priced, and point to the developer portal billing page as the real number.

## Energy site (Powerwall / solar / Wall Connector)

- "How's the Powerwall / solar / grid?": `get_energy_live_status` (one billable call, cached 60 s). Power is in W; say kW in replies. Wall Connector state and power are in its `wall_connectors` list.
- Settings (backup reserve, mode, storm watch): `get_energy_site_info`.
- "How much solar did I make / grid did I use today / this month?": `get_energy_history` with dates in the user's time zone (pass `time_zone`); keep ranges within the limits; totals are Wh. Backup (outage) events: `kind=backup`.
- No site id: the tools use `TESLA_DEFAULT_ENERGY_SITE_ID` or the only site; with several, call `list_energy_sites` and ask.
- `missing_energy_scope` or no sites listed: the token lacks `energy_device_data`; the operator re-runs the auth helper with `--energy` and signs in once.
- Never poll energy tools on a schedule; a local gateway integration is the better source for continuous data.
- Changing energy settings: skill vehicle-fleet-commands (confirm-gated, needs `energy_cmds`).
