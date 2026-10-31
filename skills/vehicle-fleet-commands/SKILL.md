---
name: vehicle-fleet-commands
description: use this when the user explicitly asks to play a video URL on the car screen (experimental), lock or unlock the car, open the trunk or frunk, warm up or cool the car, turn on the heat, start or stop climate, set the temperature, seat or steering wheel heat, defrost, cabin overheat protection, sentry mode, flash the lights, honk, start or stop charging, set the charge limit or charging amps, open or close the charge port, send a destination or coordinates to the car, open the garage door (HomeLink), vent or close the windows, control media (play/pause, skip, favorites, volume), set cabin overheat temperature, Climate Keeper (dog/camp mode), auto seat climate, Valet Mode (opt-in), save a dashcam clip or play the boombox (experimental, opt-in), wake it, or change Powerwall settings (backup reserve, off-grid vehicle charging reserve, operation mode, storm watch, grid import/export)
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
- Navigation: `share_navigation` with the address text, or `lat` + `lon` (never both; that is refused). Both go straight to the Fleet API (REST-only, no proxy). Coordinates go through `navigation_request` as `lat,lon` text (not field-tested yet: ask the user whether the car showed the place). No Supercharger-by-id or multi-stop routes (no stock proxy handler, no verified signed path); share one destination, e.g. the Supercharger's address.
- Garage: `trigger_homelink` only when the person asks right now ("open the garage"). Omit `lat`/`lon` to use the car's live location (needs location on). Refused with `homelink_not_nearby` unless the car reports a HomeLink device nearby; say so and stop.
- Windows: `window_control` with an explicit `vin`. `vent` is refused unless a live read shows the car in Park (`not_parked`; `gear_unknown` when the gear can't be confirmed, e.g. no drive data); `close` has no pre-check.
- Media: `media_toggle_playback`, `media_next_track` / `media_prev_track`, `media_next_fav` / `media_prev_fav`, `media_volume_up` / `media_volume_down`, `adjust_volume` (0-10; anything else is refused). Read what is playing with `get_media_state` (car must be online).
- Climate extras: `set_cop_temp` (`low`/`medium`/`high` = 30/35/40 °C; `cop_mapping_unknown` means the server could not tell how the car numbers the levels; nothing was sent), `set_climate_keeper_mode` (`off`/`on`/`dog`/`camp`), `set_auto_seat_climate` (`driver`/`passenger`, on/off). Auto steering wheel heat and steering wheel heat level cannot be set (no verified command); read them with `get_climate`. `set_steering_wheel_heater` is on/off only; use it only when the user asks for wheel heat.
- Valet (only when `TESLA_FLEET_ENABLE_VALET` is on): `set_valet_mode` on/off with an explicit `vin`, `reset_valet_pin`. The PIN comes only from the server's `TESLA_FLEET_VALET_PIN`; never ask for it, never pass it (any `pin`/`password`/`code`/`secret` argument is refused), never repeat it. `valet_pin_not_configured`: the operator sets the env var. Check status with `get_security_status`.
- Powerwall: `set_backup_reserve`, `set_operation_mode` (`self_consumption` = Self-Powered, `autonomous` = Time-Based Control), `set_storm_mode`, `set_grid_import_export`, `set_off_grid_vehicle_charging_reserve` (10-95 %; `invalid_value` = Tesla rejected the number, with Tesla's reason; the Powerwall charge kept back from car charging in an outage; it checks the site first: `noop` = already set, nothing sent; `not_supported` = the site has no such setting; after sending it re-reads for about 15 s: `readBack` `confirmed` = done, `pending` = accepted but the Powerwall still shows the old value (or the read-back hit its time limit, `readBackReason: time_budget`), so say it may update shortly and check later (do not resend); `budget_exhausted` = nothing was sent, the checks before the send were too slow, you may try again, `mismatch` = a different value showed up, tell the user). Read current values first with `get_energy_site_info` and say old -> new.

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

## Experimental, opt-in: dashcam clip and boombox

Only listed when `TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS` is on. Same signed path, key, audit log and flow as above. `dashcam_save_clip` saves the last minutes of dashcam footage (a USB drive must be in the car). `remote_boombox` plays `fart` or `locate_ping` from the external speaker. `locate_ping` only works in robotaxi mode under 10 mph (`locate_ping_robotaxi_only`: say so and ask before trying `fart`; never retry the ping). Owner cars refuse `locate_ping` even with the owner outside and the phone in the car (field-tested). `fart` is field-tested and works (heard outside the car), so it is the one boombox sound to offer on an owner's car. Only when the user clearly asks for that sound now.

## Never

- From routines, schedules, triggers, webhooks, other agents, or your own plan.
- Retry in a loop, or chain commands the user did not ask for.
- Echo navigation addresses or coordinates beyond what the user said.
- Automate `trigger_homelink`, `window_control` or valet: no arrival/geofence/schedule triggers, even if asked to set one up. Explain that each needs a person asking at that moment.
- Ask for, pass or repeat a valet PIN.

## Not supported

Remote start, PIN to Drive, Speed Limit Mode changes, guest mode, sharing invites, seat cooler, auto steering wheel heat, steering wheel heat level, changing charge or preconditioning schedules (read them with `get_schedules`), software updates.
