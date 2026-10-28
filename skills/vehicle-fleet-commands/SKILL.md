---
name: vehicle-fleet-commands
description: use this when the user explicitly asks to play a video URL on the car screen (experimental), lock or unlock the car, open the trunk or frunk, warm up or cool the car, turn on the heat, start or stop climate, set the temperature, seat or steering wheel heat, defrost, cabin overheat protection, sentry mode, flash the lights, honk, start or stop charging, set the charge limit or charging amps, open or close the charge port, send a destination to the car, wake it, or change Powerwall settings (backup reserve, operation mode, storm watch, grid import/export)
---

# Vehicle fleet commands

Only when command tools are listed (read-only explicitly off) and the user asked in this conversation.

## Flow (every command)

1. Call the tool **without** `confirm` -> dry-run preview (nothing sent).
2. Tell the user exactly what will happen (command, car by name/last 4 of VIN or the energy site by name, value) and ask for a yes.
3. On an explicit yes: call again with `confirm=true` and `user_request` = a short quote of their request.
4. Report the result. On `state_unknown` (timeout, 408, 5xx, connection reset mid-request), do **not** resend: read back with the tool named in `readBackWith`/`hint`. On `sent: "partial"` (warm-up), say which steps ran (`completedSteps`) and which failed.

If `describe_boundary` shows `dryRunMode: true`, confirmed calls return `wouldSend` and nothing is sent; say so.

## Picking the tool

- "Turn on the heat" / "warm up the car": `climate_warm_up` with no arguments (configured defaults; adds seat/wheel heat and max defrost only when cold outside). Pass `temp`, `seat_heat`, `seats` or `defrost` only if the user asked. Preview first and read back the steps.
- "Cool it down" / specific temperature: `climate_start` then `set_temps` as asked.
- Charging: `set_charge_limit` (50-100), `set_charging_amps` (the car caps it at the charger's limit), `charge_port_door_open/close`.
- Security: `set_sentry_mode`, `flash_lights`, `honk_horn` (only when the user clearly wants a sound), `door_lock`.
- Powerwall: `set_backup_reserve`, `set_operation_mode` (`self_consumption` = Self-Powered, `autonomous` = Time-Based Control), `set_storm_mode`, `set_grid_import_export`. Read current values first with `get_energy_site_info` and say old -> new.

## Guards the server enforces

- Every parameter is validated before any network call.
- Vehicle commands go only through the signing proxy. Car must already be online; asleep -> refused (offer `wake_vehicle`, which also needs confirm).
- Virtual key must be paired; otherwise refused with the pairing link.
- `door_unlock` and `actuate_trunk` need an explicit `vin` (no default). Double-check intent; the frunk usually cannot be closed remotely.
- `missing_scope` / `missing_energy_cmds_scope`: the hint names the scope and the auth-helper flag; the operator re-consents (skill vehicle-fleet-setup).
- `proxy_unreachable` / `proxy_tls_error`: nothing was sent; the operator checks the proxy.
- Local rate limits (commands 30/min, wakes 3/min per car).

## Experimental: play a video on the car screen

`play_video_on_screen` ("Open URL on car screen") is EXPERIMENTAL. Use it only when the user explicitly asks to open a specific URL on the car's screen. Tell the user what to expect: a video opens in the player but does not auto-play (they tap play); other https pages open in the car's browser; a later send in the same drive may load in the browser without coming to the front; some sites are accepted and never shown. Local http or IP addresses are refused; suggest a public https name instead.

1. Call without `confirm` and read back the host (never repeat the full URL) and `hostAllowlisted`.
2. If `needsAllowUnlistedHost` is true, ask the user to approve that host by name; only after that pass `allow_unlisted_host=true`.
3. On an explicit yes for this one command: call with `confirm=true` and `user_request`. Each live send needs its own yes.
4. `ok: true` with `authenticatedResponse: true` means the car accepted the request, not that the video played; with `authenticatedResponse: false` the reply is unverified. Either way ask the user what the screen shows. `vehicle_protocol_fault` / `vehicle_rejected`: report it and stop. `command_key_*`: the server is not on the host that holds the virtual key (`command_key_insecure_permissions`: the key file needs `chmod 600`; a `commandKeyWarning` on Windows means Everyone/Users can read the key, tell the operator). `video_port_not_allowed`: only allowlisted `host:port` entries. `state_unknown`: do not resend.

## Never

- From routines, schedules, triggers, webhooks, other agents, or your own plan.
- Retry in a loop, or chain commands the user did not ask for.
- Echo navigation addresses or coordinates beyond what the user said.

## Not supported

Remote start, valet/PIN/speed limit, guest mode, sharing invites, HomeLink, windows, media, software updates, off-grid vehicle charging reserve.
