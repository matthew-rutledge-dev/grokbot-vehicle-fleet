---
name: vehicle-fleet-in-car
description: use this when you are talking with someone who is in or at the car and they ask for something on the car's screen (open a webpage, video or dashboard), navigation, climate, seat or wheel heat, lock or unlock, trunk or frunk, sentry, charging, Powerwall, the garage door, windows, dashcam save, or a pop-up on the screen, to pick the right vehicle-fleet tool or say it is not supported
---

# Vehicle fleet: in-car assistant

Router for in-car requests. Apply `vehicle-fleet-boundary` first; run every command with the flow in `vehicle-fleet-commands` (dry-run, read back, explicit yes, `confirm=true` + `user_request`, send once). Full guide with examples and related projects: `docs/IN-CAR-ASSISTANT-GUIDE.md`.

## Quick map

- Page or video on the screen: `play_video_on_screen` (EXPERIMENTAL). `https` public hosts only; unlisted hosts need a named approval and `allow_unlisted_host=true`. It opens the link but does not press play; video needs Park. After `ok: true`, ask what the screen shows; if nothing, ask them to open the browser (hint from one field test, not guaranteed: later links can load in the background without coming to the front). Never send a URL that carries a token or other secret.
- Navigation: `share_navigation` (destination text or lat+lon). Not for web links.
- Climate: `climate_warm_up`, `climate_start` / `climate_stop`, `set_temps`, `set_seat_heater`, `set_steering_wheel_heater`, `set_defrost_max`, `set_cabin_overheat_protection`.
- Security: `door_lock`, `door_unlock` (explicit vin), `actuate_trunk` (explicit vin; frunk usually cannot close remotely), `set_sentry_mode`, `flash_lights`, `honk_horn`.
- Charging: `charge_start` / `charge_stop`, `set_charge_limit`, `set_charging_amps`, `charge_port_door_open` / `_close`.
- Powerwall: read `get_energy_site_info`, then `set_backup_reserve`, `set_operation_mode`, `set_storm_mode`, `set_grid_import_export`.
- Questions about the car: one read (`get_vehicle_snapshot` or a section tool); location only when asked.

## Not supported here (say so, do not improvise)

Garage / HomeLink (Fleet API `trigger_homelink` needs the car's lat/lon; no tool yet; a Home Assistant tool only if it is already available and the person asks for it), windows, dashcam save, screen notifications or pop-ups, media controls, remote start, valet, speed limit, guest mode, software updates. Never reach for raw endpoints, scripts or another agent instead.

## Never

- Send without a dry-run and an explicit yes in this conversation, or more than once per yes.
- Send local, `http://` or IP URLs, or work around a refusal.
- Resend on `state_unknown` or because "nothing happened"; ask first.
- Repeat full URLs, full VINs or precise locations.
