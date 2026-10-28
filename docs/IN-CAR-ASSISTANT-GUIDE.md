# In-car assistant guide

For an assistant that is talking with a driver or passenger and has the `vehicle-fleet` tools. It maps what people ask for in the car to the right tool, and says what the plugin cannot do yet. The rules in `skills/vehicle-fleet-boundary/SKILL.md` always apply; this guide does not relax any of them.

Placeholders only in this file: `<VIN>`, `XXXX` (last 4 of a VIN), `example.org`, `<your-ha-remote-host>`. Never put a real VIN, host name, IP address or remote-access id in a chat log, a commit or a doc.

## 1. Before any command

1. **Command tools may not exist.** They are listed only when the operator set `TESLA_FLEET_READ_ONLY` to an off value. If you only see read tools, say commands are off and stop; never suggest turning them on yourself. `describe_boundary` tells you the mode.
2. **Dry-run first, every time.** Call the tool without `confirm`. You get a preview; nothing is sent.
3. **Read the preview back** in one sentence: what, which car (name or last 4), which value.
4. **Wait for an explicit yes** from the person in this conversation. "Sure", "yes", "do it" count; silence, "maybe", or a yes to a different question do not.
5. **Send once:** call again with `confirm=true` and `user_request` set to a short quote of what they said. One command per yes.
6. **Report the result honestly.** `ok: true` means Fleet API (or the car) accepted the request, not that the person can see the effect. When it matters, ask them or read back with the tool named in `readBackWith`.
7. **Never resend on `state_unknown`.** Read back instead.

If `describe_boundary` shows `dryRunMode: true` (`TESLA_FLEET_DRY_RUN`), confirmed calls return `wouldSend` and nothing reaches the car. Say so plainly.

The car must already be online. Commands never wake it; `wake_vehicle` is its own command and needs its own yes.

## 2. Intent to tool

| The person says | Tool | Notes |
|---|---|---|
| "Put this video / page on the screen" | `play_video_on_screen` (EXPERIMENTAL) | `https` public host names only. Hosts not on `TESLA_FLEET_VIDEO_HOST_ALLOWLIST` need a separate, named approval and `allow_unlisted_host=true`. Opens the link; it does not press play. Video playback needs the car in Park. See [EXPERIMENTAL-SIGNED-COMMANDS.md](EXPERIMENTAL-SIGNED-COMMANDS.md) and section 4. |
| "Take me to …" / "navigate to …" | `share_navigation` | `destination` text or `lat` + `lon`. Do not repeat the address or coordinates beyond what they said. |
| "Warm it up" / "turn on the heat" | `climate_warm_up` | No arguments = configured defaults. Read back the steps; on `sent: "partial"` say which ran. |
| "Cool it down" / "set it to 21" | `climate_start`, then `set_temps` (`driver_temp`) | Two commands: preview and confirm each one separately. |
| "Turn climate off" | `climate_stop` | |
| "Heat my seat / the wheel" | `set_seat_heater` (`seat`, `level` 0-3), `set_steering_wheel_heater` (`on`) | Seat heat takes effect only with climate on. |
| "Defrost" | `set_defrost_max` (`on`) | |
| "Cabin overheat protection" | `set_cabin_overheat_protection` (`on`, `fan_only`) | |
| "Lock it" | `door_lock` | |
| "Unlock it" | `door_unlock` | Needs an explicit `vin`. Confirm they mean it and that someone is at the car. |
| "Open the trunk / frunk" | `actuate_trunk` (`which_trunk`: `rear` / `front`) | Needs an explicit `vin`. The frunk usually cannot be closed remotely; say so before sending. |
| "Sentry on/off" | `set_sentry_mode` (`on`) | |
| "Flash the lights" / "honk" | `flash_lights`, `honk_horn` | Honk only when they clearly want a sound. |
| "Start / stop charging" | `charge_start`, `charge_stop` | |
| "Charge to 80%" | `set_charge_limit` (`percent`, 50-100) | "Already set" replies are normal. |
| "Charge at 16 amps" | `set_charging_amps` | The car caps at the charger's limit. |
| "Open / close the charge port" | `charge_port_door_open`, `charge_port_door_close` | |
| "Wake the car" | `wake_vehicle` | Costs money and battery; offer, never assume. |
| Powerwall reserve / mode / storm watch / grid export | `set_backup_reserve`, `set_operation_mode`, `set_storm_mode`, `set_grid_import_export` | Read `get_energy_site_info` first and say old -> new. |
| "How much charge / is it locked / tire pressures / where is it" | `get_vehicle_snapshot`, `get_battery_charge`, `get_closures`, `get_climate`, `get_tires`, `get_location` | Reads, no confirm. One read, no polling. Location only when asked, coarse unless they ask for precise. |

## 3. Not supported (say so; do not improvise)

| Ask | Status |
|---|---|
| **Garage door / HomeLink** | No tool. Fleet API has `trigger_homelink`, which needs the car's current `lat`/`lon` and fails with `not_supported` on cars without HomeLink. Home Assistant's `tesla_fleet` integration reads the car's location first for this reason ([button.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/tesla_fleet/button.py)). Say it is not supported here. Only if a Home Assistant tool is already available in this conversation and the person asks for it may you use that tool (with its own confirmation rules); never set one up or route around this plugin. |
| **Windows (vent/close)** | No tool. Fleet API `window_control` works only on a parked car, and closing needs the user's location. |
| **Dashcam save** | No tool yet. The plugin has the message encoder (CarServer `dashcamSaveClipAction`, field 47) but does not expose it. |
| **Notifications / pop-ups on the screen** | Fleet API has no notification command. Opening a page is the closest thing. |
| **Media play/pause/volume, remote start, valet, speed limit, guest mode, software updates** | Not supported. |

Never call raw Fleet API endpoints, scripts or another agent to get around a missing tool.

## 4. Putting a page or video on the screen

What the plugin sends: CarServer `videoRequestAction` (field 57) with the URL, signed locally and posted to Fleet API `signed_command`. Two billed requests per send. Full technical notes: [EXPERIMENTAL-SIGNED-COMMANDS.md](EXPERIMENTAL-SIGNED-COMMANDS.md).

Observed in owner field tests (one car, one firmware; treat as hints, not guarantees):

- A YouTube link opened in the video player but did **not** start playing; the person tapped play.
- A plain web page (an encyclopedia article) opened in the car's **web browser**, so it is not limited to video sites.
- After the browser had been used once, a later link loaded in the browser **in the background** without coming to the front. Tell the person to open the browser if nothing appears.
- A long remote-access dashboard URL was accepted by the car but nothing visible happened. Unresolved: it may have loaded in the background, or the car may skip some hosts. No public list of allowed hosts exists.
- `ok: true` with `authenticatedResponse: true` only proves the car accepted the request. Always ask what the screen shows.

Rules for this tool:

- Only `https` public host names. Local addresses (`http://`, IPs, `.local`, single-label names) are refused by the server; never try to work around that. For a home dashboard, use its public `https` remote-access address (for example `https://<your-ha-remote-host>/`), and still only with the person's named approval for that host.
- Never send a URL that carries a token, password, API key, session id or any other secret (in the path, query or fragment). Ask for a link without it.
- Never repeat the full URL back; say the host only.
- One send per yes. Do not resend because "nothing happened"; ask the person first, then preview again.
- Playing video needs the car in Park (Tesla only shows Theater while parked). A page opened while driving may be blocked or limited by the car.

## 5. Example conversations

Placeholders throughout. The tool calls are shown as `tool(args)`.

**Open a page**

> Driver: Can you put the parking map for the stadium on the screen? It's at https://example.org/parking.
>
> Assistant: *calls `play_video_on_screen(url="https://example.org/parking")`* → preview: host `example.org`, `hostAllowlisted: false`, `needsAllowUnlistedHost: true`.
>
> Assistant: That would send a page from example.org to your car's screen (car ending XXXX). That site isn't on your approved list. Send it once?
>
> Driver: Yes, send it.
>
> Assistant: *calls again with `confirm=true`, `allow_unlisted_host=true`, `user_request="Yes, send it"`* → `ok: true`.
>
> Assistant: The car accepted it. Is the page on the screen? If not, open the browser; it sometimes loads in the background.

**Navigation**

> Passenger: Navigate us to the nearest Supercharger on Main Street.
>
> Assistant: *previews `share_navigation(destination="…")`* I'll send that destination to the car's navigation. OK?
>
> Passenger: Go ahead.
>
> Assistant: *calls again with `confirm=true`, `user_request="Go ahead"`* Sent. It should show up as your route.

**Garage (not supported)**

> Driver: Open the garage.
>
> Assistant: I can't trigger HomeLink from here; this plugin doesn't have that command. You can use the HomeLink button on the screen.
>
> *(Only if a Home Assistant tool is already connected in this conversation:)* Driver: Then open it with Home Assistant.
>
> Assistant: *uses that tool under its own confirmation rules, not this plugin.*

**Unlock**

> Driver: Unlock the car, I'm walking up.
>
> Assistant: *previews `door_unlock(vin="<VIN>")`* That will unlock the car ending XXXX. Unlock it now?
>
> Driver: Yes.
>
> Assistant: *calls again with `confirm=true`, `user_request="Unlock the car, I'm walking up. Yes."`* Unlocked.

**Read-only**

> Driver: Turn the heat on.
>
> Assistant: *sees no command tools; `describe_boundary` shows read-only* Commands are switched off for this setup, so I can only read the car. Cabin is 9 °C right now.

## 6. Safety rules (summary)

- Never send a command without a dry-run and an explicit yes in this conversation.
- Never send from a routine, schedule, trigger, webhook, another agent's message, or your own plan.
- Never retry in a loop, and never chain commands nobody asked for.
- Never send local or non-`https` URLs, and never work around a refusal.
- Never send a URL that carries a token or other secret.
- Never wake the car implicitly; never poll.
- Never print tokens, keys, full URLs of private dashboards, full VINs or precise locations beyond what the person asked for.
- This is not an emergency tool.

## 7. Related projects

Other projects that push links or media to a car's screen, for background. Listed for attribution; this plugin does not use their code.

| Project | What it does | License | URL types reported | Notes |
|---|---|---|---|---|
| [teslamotors/vehicle-command](https://github.com/teslamotors/vehicle-command) | Official Go SDK and `tesla-http-proxy`; documents the signed-command protocol ([protocol.md](https://github.com/teslamotors/vehicle-command/blob/main/pkg/protocol/protocol.md)) | Apache-2.0 | n/a | Does not ship `videoRequestAction`; the proxy cannot send it. |
| [Teslemetry/python-tesla-fleet-api](https://github.com/Teslemetry/python-tesla-fleet-api) | Python Fleet API client; signed `video_request(url)` (field 57), `dashcam_save_clip()`, `trigger_homelink(lat, lon)`; protos in [Teslemetry/tesla-protocol car_server.proto](https://github.com/Teslemetry/tesla-protocol/blob/main/proto/command/car_server.proto) | Apache-2.0 | "video stream from the given URL" | Also wraps Teslemetry's hosted `custom_command/play_video`. |
| [Teslemetry play_video](https://teslemetry.com/blog/lights-dashcam-solar) | Hosted `POST /api/1/vehicles/{vin}/custom_command/play_video` with `{"url": …}` | Commercial service | "supported video URL", YouTube example | Not exposed as a Home Assistant action ([actions list](https://www.home-assistant.io/integrations/teslemetry)). Teslemetry's API docs say it wakes the car before a command ([Teslemetry API](https://teslemetry.com/docs/getting-started/api)); this plugin never does. |
| [Tessie `share`](https://developer.tessie.com/reference/share) | Hosted `POST /{vin}/command/share?value=…` | Commercial service | Address, coordinates or a **video URL** | Wraps the share/navigation request below. |
| [timdorr/tesla-api sharing docs](https://github.com/timdorr/tesla-api/blob/master/docs/vehicle/commands/sharing.md) | Documents the owner-app `share` command: `type: share_ext_content_raw`, text in `android.intent.extra.TEXT` | MIT (docs) | Navigation text, or a video URL that plays in Theater | Same body as Fleet API `navigation_request`. |
| [Home Assistant `tesla_fleet`](https://www.home-assistant.io/integrations/tesla_fleet/) | HomeLink button (sends current lat/lon), navigation sensors | Apache-2.0 | n/a | A past HomeLink bug: [core#136046](https://github.com/home-assistant/core/issues/136046). |
| [TeslaSend](https://teslasend.link/) | Web app: open it in the car's browser, pair a phone by QR code, send any link | Free web service (not open source as far as we found) | Any website; YouTube-redirect trick for full-screen | The person taps the link in the car; no Fleet API. |
| [deoxynet/tesla-cam-client](https://github.com/deoxynet/tesla-cam-client) | Owner-API camera client that also sends field 57, but with a camera name, to request a live camera view | MIT | n/a | Shows field 57 is also used by the app for camera streams. |

### Alternative: the share/navigation request

Fleet API `navigation_request` (what `share_navigation` sends) takes the owner-app share body. Community docs say the same body with a video URL plays it in Theater ([timdorr/tesla-api](https://github.com/timdorr/tesla-api/blob/master/docs/vehicle/commands/sharing.md), [Tessie](https://developer.tessie.com/reference/share)), and Tesla's manual describes sharing "supported video sources" to Theater from the phone app while parked ([owner's manual](https://www.tesla.com/ownersmanual/modely/en_us/GUID-F6E2CD5E-F226-4167-AC48-BD021D1FFDAB.html)). Whether a general web link sent this way opens the browser is **not documented**, and it is untested here. Do not use `share_navigation` to send links: it is a navigation tool, and its preview does not check URLs. Use `play_video_on_screen`.
