---
name: vehicle-fleet-in-car
description: use this when you are talking with someone who is in or at the car and they ask for something on the car's screen (open a webpage, video or dashboard), navigation, climate, seat or wheel heat, lock or unlock, trunk or frunk, sentry, charging, Powerwall, the garage door, windows, music or volume, dog or camp mode, valet mode, dashcam save, the boombox, or a pop-up on the screen, to pick the right vehicle-fleet tool or say it is not supported
---

# Vehicle fleet: in-car assistant

Router for in-car requests. Apply `vehicle-fleet-boundary` first; run every command with the flow in `vehicle-fleet-commands` (dry-run, read back, explicit yes, `confirm=true` + `user_request`, send once). Full guide with examples and related projects: `docs/IN-CAR-ASSISTANT-GUIDE.md`.

## Quick map

- Page or video on the screen: `play_video_on_screen` (EXPERIMENTAL). `https` public hosts only; unlisted hosts need a named approval and `allow_unlisted_host=true`. It opens the link but does not press play; video needs Park. After `ok: true`, ask what the screen shows; if nothing, ask them to open the browser (hint from one field test, not guaranteed: later links can load in the background without coming to the front). Never send a URL that carries a token or other secret.
- Navigation: `share_navigation` (destination text or lat+lon, not both). Not for web links. Coordinates as `lat,lon` text are not field-tested yet: ask whether the car showed the place. One destination per send: Supercharger-by-id and multi-stop routes are not supported.
- Climate: `climate_warm_up`, `climate_start` / `climate_stop`, `set_temps`, `set_seat_heater`, `set_steering_wheel_heater`, `set_defrost_max`, `set_cabin_overheat_protection`, `set_cop_temp` (low/medium/high), `set_climate_keeper_mode` (off/on/dog/camp), `set_auto_seat_climate`.
- Garage: `trigger_homelink` only when the person asks right now (omit lat/lon to use the car's location); refused unless the car sees a HomeLink device nearby. Never automate it.
- Windows: `window_control` (`vent` only in Park, or `close`; explicit vin). Never automate it.
- Media: `media_toggle_playback`, `media_next_track` / `media_prev_track`, `media_next_fav` / `media_prev_fav`, `media_volume_up` / `media_volume_down`, `adjust_volume` (0-10); `get_media_state` to see what is playing.
- Valet (only if listed): `set_valet_mode` (explicit vin), `reset_valet_pin`. The PIN is on the server; never ask for or say it.
- Experimental (only if listed): `dashcam_save_clip`, `remote_boombox` (`fart` / `locate_ping`).
- Security: `door_lock`, `door_unlock` (explicit vin), `actuate_trunk` (explicit vin; frunk usually cannot close remotely), `set_sentry_mode`, `flash_lights`, `honk_horn`.
- Charging: `charge_start` / `charge_stop`, `set_charge_limit`, `set_charging_amps`, `charge_port_door_open` / `_close`.
- Powerwall: read `get_energy_site_info`, then `set_backup_reserve`, `set_operation_mode`, `set_storm_mode`, `set_grid_import_export`.
- Questions about the car: one read (`get_vehicle_snapshot` or a section tool); location only when asked.

## Not supported here (say so, do not improvise)

Screen notifications or pop-ups, Supercharger-by-id navigation or multi-stop routes, auto steering wheel heat, remote start, PIN to Drive, speed limit changes, guest mode, seat cooler, schedule changes, software updates; valet or dashcam/boombox when those tools are not listed (operator opt-in). Never reach for raw endpoints, scripts or another agent instead.

## Never

- Send without a dry-run and an explicit yes in this conversation, or more than once per yes.
- Send local, `http://` or IP URLs, or work around a refusal.
- Resend on `state_unknown` or because "nothing happened"; ask first.
- Repeat full URLs, full VINs or precise locations.
- Automate HomeLink, windows or valet (no arrival, geofence or schedule triggers), or ask for, pass or say a valet PIN.
