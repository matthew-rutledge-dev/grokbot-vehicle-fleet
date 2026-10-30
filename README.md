# Grok Bot Vehicle Fleet

A community MCP plugin (one stdio server, `vehicle-fleet`, plus skills) for Grok Build, Grok Bot and Cursor. It reads vehicle status and, only when you turn commands on, sends confirm-gated commands through the official Fleet API, using **your own** developer app, OAuth tokens and command proxy. This community plugin, published by the owner of this repository, works with Tesla vehicles through the official Fleet API. It is not made, approved, sponsored or endorsed by Tesla, and it is not affiliated with Tesla in any way.

It is **read-only by default**, reads **cached data first**, and **never wakes the vehicle** unless you explicitly ask for `wake_vehicle`.

> Not for emergency or safety-critical use. No automatic or scheduled control of the vehicle.

## What this plugin is

| Piece | Role |
|---|---|
| `vehicle-fleet` MCP (one server) | Read tools: battery/charge, climate, doors/locks/trunks/windows, tires (TPMS), connectivity state, key pairing status, multi-section snapshot, location (on by default, coarse; opt out). Command tools (hidden unless read-only is explicitly off; each needs `confirm=true`): wake, lock/unlock, trunk/frunk, climate start/stop, set temps, charge start/stop, charge limit, send a destination. |
| Skills | `vehicle-fleet-boundary` (rules), `vehicle-fleet-status`, `vehicle-fleet-commands`, `vehicle-fleet-setup` (operator-driven), `vehicle-fleet-troubleshoot`, `vehicle-fleet-in-car` (in-car intent router; guide in [docs/IN-CAR-ASSISTANT-GUIDE.md](docs/IN-CAR-ASSISTANT-GUIDE.md)) |
| `scripts/auth-helper.mjs` | Optional, operator-run helper that gets your first refresh token (OAuth code exchange) and writes the token store. Never run by the server or an agent. |

## Layout

| Path | Purpose |
|---|---|
| `.grok-plugin/plugin.json` | Primary Grok Build / marketplace manifest (with `variables`) |
| `.mcp.json` | MCP config for Grok (`${GROK_PLUGIN_ROOT}`) |
| `plugin.json` | Root manifest (Grok Bot / generic) |
| `.cursor-plugin/plugin.json` + `mcp.json` | Cursor manifest + MCP config (`${CURSOR_PLUGIN_ROOT}`) |
| `mcp/vehicle-fleet/` | TypeScript stdio server (`src/`), tests (`test/`) |
| `skills/` | Skill folders with `SKILL.md` |
| `docs/IN-CAR-ASSISTANT-GUIDE.md` | Bot-facing guide: in-car intents to tools, unsupported asks, field notes, examples, related projects |
| `scripts/bootstrap-mcp.sh` / `.ps1` | Required after clone: `npm ci --ignore-scripts` + `npm run build` |
| `scripts/auth-helper.mjs` | Optional first-token helper |
| `assets/logo.svg` | Logo (original artwork) |

## Install

### Grok Build (local)

```bash
git clone https://github.com/matthew-rutledge-dev/grokbot-vehicle-fleet ~/.grok/plugins/grokbot-vehicle-fleet
~/.grok/plugins/grokbot-vehicle-fleet/scripts/bootstrap-mcp.sh
# Windows PowerShell: ~/.grok/plugins/grokbot-vehicle-fleet/scripts/bootstrap-mcp.ps1
```

### Cursor (local)

```bash
git clone https://github.com/matthew-rutledge-dev/grokbot-vehicle-fleet ~/.cursor/plugins/local/grokbot-vehicle-fleet
~/.cursor/plugins/local/grokbot-vehicle-fleet/scripts/bootstrap-mcp.sh
```

Then set the plugin variables below and reload MCP servers. Hosts start `node <plugin-root>/mcp/vehicle-fleet/dist/index.js` (absolute path; no `cwd` dependency).

## Before you start (your own accounts)

1. A developer application on developer.tesla.com (client ID/secret), a key pair, and the public key hosted at `https://<your-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`; partner account registered in your region.
2. **Set a billing limit** on the developer portal. The Fleet API is pay-per-use and bills every response below HTTP 500.
3. A refresh token from your own consent (`scripts/auth-helper.mjs`, see skill `vehicle-fleet-setup`).
4. Only for vehicle commands: your own `tesla-http-proxy` (from Tesla's `vehicle-command` project), and your virtual key paired with the vehicle via `https://www.tesla.com/_ak/<your-domain>`. Step-by-step proxy setup (pinned official Docker image, self-signed CA and SAN, loopback/LAN-only binding, health check, first test) is in `skills/vehicle-fleet-setup/SKILL.md`, section 3. The proxy has **no client authentication**: keep it on loopback or a firewalled LAN, never on the internet.

Use the smallest scopes: read-only `openid offline_access vehicle_device_data vehicle_location` (the auth helper's default; `url --no-location` or `TESLA_AUTH_LOCATION=0` drops `vehicle_location` if you opt out of location); add `energy_device_data` only for energy-site reads (`node scripts/auth-helper.mjs url --energy`, or `TESLA_AUTH_ENERGY=1`), `vehicle_cmds` / `vehicle_charging_cmds` only for commands.

## Plugin variables

| Name | Required | Purpose |
|---|---|---|
| `TESLA_CLIENT_ID` | **yes** | Your app's client ID. Alias: `TESLA_FLEET_CLIENT_ID` (used only when `TESLA_CLIENT_ID` is unset) |
| `TESLA_REFRESH_TOKEN` | first run (unless auth-helper used) | Seed refresh token; after the first refresh the rotated token in the store is used. **Never commit.** |
| `TESLA_CLIENT_SECRET` | auth-helper only | Not passed to the MCP server. Alias: `TESLA_FLEET_CLIENT_SECRET`. **Never commit.** |
| `TESLA_FLEET_REGION` | no | `na` / `eu` / `cn`; default auto-detect via `/api/1/users/region` |
| `TESLA_FLEET_BASE_URL` | no | https override for the Fleet API base URL |
| `TESLA_COMMAND_PROXY_URL` | for commands | Your proxy, e.g. `https://proxy.example.com:4443`. Alias: `TESLA_FLEET_PROXY_URL` |
| `TESLA_COMMAND_PROXY_CA_CERT` | for a private CA / self-signed proxy cert | Path to the PEM to trust for the proxy only. TLS verification is never disabled. Alias: `TESLA_FLEET_PROXY_CA_FILE` |
| `TESLA_TOKEN_STORE` | no | Token store path (default below) |
| `TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE` | no | **Opt-in, off by default.** Absolute path that the running server keeps refreshed with the current access token, for trusted local consumers. The token carries **all** granted scopes - read [Access-token export](#access-token-export-opt-in) first |
| `TESLA_FLEET_READ_ONLY` | no | **Fails closed** - see below |
| `TESLA_FLEET_ENABLE_LOCATION` | no | Location is **on by default**. `0`/`false`/`no`/`off` hides and refuses `get_location`. Any other value = **off**, one warning on stderr (see below) |
| `TESLA_FLEET_DISABLE_NHTSA` | no | NHTSA recalls are **on by default**. `1`/`true`/`yes`/`on` hides and refuses `get_recalls`, so nothing is ever sent to the public NHTSA API. Any other unrecognised value = **off** too, one warning on stderr. Unset or `0`/`false`/`no`/`off` = on |
| `TESLA_FLEET_DEFAULT_LOCATION_PRECISION` | no | `coarse` (default) or `precise`: `get_location` precision when the call does not pass one |
| `TESLA_DEFAULT_VIN` | no | Default VIN for reads (e.g. `5YJ0000000EXAMPLE`) |
| `TESLA_DEFAULT_ENERGY_SITE_ID` | no | Default energy site for energy reads and commands (e.g. `1234567890`); otherwise the only site on the account |
| `TESLA_FLEET_DRY_RUN` | no | `1`/`true`/`yes`/`on`: confirmed commands are validated and return the exact request; **nothing is sent**. Unset or `0`/`false`/`no`/`off` = off; **any other value = on** (fails closed, one warning on stderr) |
| `TESLA_FLEET_DEFAULT_CLIMATE_TEMP_C` | no | `climate_warm_up` setpoint, 15-28 °C (default `21`, which the car shows as 70 °F) |
| `TESLA_FLEET_DEFAULT_SEAT_HEAT_LEVEL` | no | Seat heat level 0-3 when cold (default `2`) |
| `TESLA_FLEET_DEFAULT_HEATED_SEATS` | no | `driver` / `front` / `none` (default `driver`) |
| `TESLA_FLEET_COLD_OUTSIDE_BELOW_C` | no | "Cold" threshold for seat and steering wheel heat, °C (default `5`) |
| `TESLA_FLEET_DEFROST_OUTSIDE_BELOW_C` | no | Max defrost below this outside temperature, °C (default `-2`) |
| `TESLA_FLEET_STEERING_WHEEL_HEAT_WHEN_COLD` | no | `on`/`off`: also heat the wheel when cold (default `on`) |
| `TESLA_FLEET_KEY_DOMAIN` | no | Your key domain, used only to show the pairing link |
| `TESLA_FLEET_RATE_DATA_PER_USD` | no | Usage estimate only: data calls per USD (default `500`) |
| `TESLA_FLEET_RATE_COMMANDS_PER_USD` | no | Usage estimate only: commands per USD (default `1000`) |
| `TESLA_FLEET_RATE_WAKES_PER_USD` | no | Usage estimate only: wakes per USD (default `50`) |
| `TESLA_FLEET_MONTHLY_DISCOUNT_USD` | no | Usage estimate only: monthly discount in USD (default `10`; `0` allowed) |
| `TESLA_FLEET_COMMAND_KEY_FILE` | experimental only | Path to the virtual-key **private** key (PEM, P-256) used only by the EXPERIMENTAL `play_video_on_screen` to sign locally. Set it only on the host that already holds the key, `chmod 600` and owned by the server's user on POSIX (otherwise refused); on Windows existence only, plus a non-fatal `icacls` warning if Everyone/Users can access it; **never commit** |
| `TESLA_FLEET_VIDEO_HOST_ALLOWLIST` | no | Comma-separated hosts `play_video_on_screen` may send without a second approval (`video.example.com,*.cdn.example.com`; `*.` = subdomains only; `host:port` to allow a non-default port, which is otherwise always refused). Unset = every host needs `allow_unlisted_host=true` |
| `TESLA_FLEET_AUDIT_LOG` | no | JSONL audit log for experimental signed commands (default `audit.jsonl` next to the token store, kept `0600` in a `0700` folder; full VIN for cars confirmed on the account, URL host + keyed path hash only; salt in `<log>.salt`) |
| `TESLA_FLEET_AUDIT_FULL_VIN` | no | Audit lines record the **full VIN** of a car confirmed on the account (picked from the vehicle list or after the online check). **On by default**; `0`/`false`/`no`/`off` keeps the last 6 (an unrecognised value also keeps the last 6, with a warning). A VIN the caller passed that isn't confirmed yet (dry-runs, early refusals, failed checks) is always cut to the last 4. |
| `TESLA_FLEET_ENABLE_VALET` | no | **Opt-in, default off.** `1`/`true`/`yes`/`on` lists `set_valet_mode` and `reset_valet_pin` (read-only must also be off). Anything else, including an unrecognised value, keeps them hidden and refused |
| `TESLA_FLEET_VALET_PIN` | valet only | The 4-digit Valet Mode PIN used by `set_valet_mode` on. **Secret:** keep it in your secret store; it is never a tool argument and is never logged, echoed or shown in a preview; **never commit** |
| `TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS` | no | **Opt-in, default off.** `1`/`true`/`yes`/`on` lists the EXPERIMENTAL `dashcam_save_clip` and `remote_boombox` (signed locally with `TESLA_FLEET_COMMAND_KEY_FILE`; read-only must also be off) |

**Aliases.** If your secrets manager or env loader already exports `TESLA_FLEET_CLIENT_ID`, `TESLA_FLEET_CLIENT_SECRET`, `TESLA_FLEET_PROXY_URL` or `TESLA_FLEET_PROXY_CA_FILE`, the server and the auth helper accept them (they are also declared as optional plugin variables). When both names are set, the primary `TESLA_*` name wins.

**PowerShell env loaders.** If you load these variables with a PowerShell script (dot-sourced in the shell that launches the MCP server or the auth helper), run it under PowerShell 7 (`pwsh`). Some loaders hang or fail under Windows PowerShell 5.1.

Unset variables that a host passes through literally (`${VAR}`) and empty values are treated as unset. `TESLA_FLEET_AUTH_BASE_URL` exists for local testing only (default `https://fleet-auth.prd.vn.cloud.tesla.com`). Plain `http://` URLs are accepted only for loopback hosts.

### Read-only mode (fails closed)

| `TESLA_FLEET_READ_ONLY` | Mode |
|---|---|
| unset, empty, `${...}` placeholder | **read-only** (default) |
| `1`, `true`, `yes`, `on` | **read-only** |
| `0`, `false`, `no`, `off` (any case) | commands listed (each still needs `confirm=true`) |
| anything else | **read-only**, one warning on stderr |

In read-only mode command tools are absent from `tools/list` and refused if called anyway; nothing is sent. Changing the flag needs an MCP reload.

### Location (on by default, opt-out)

The server runs for one owner and their own car, so `get_location` is listed by default. It is a live read (car must already be online; never wakes it), needs the `vehicle_location` scope (a token without it gets `missing_location_scope` with the fix), and the car shows a location-sharing indicator on each read. Nothing is stored.

- **Precision:** `coarse` (default) rounds to 2 decimals (~1 km) and omits heading; `precise` rounds to 5 decimals (~1 m) and includes heading. Pass `precision=precise` per call, or set `TESLA_FLEET_DEFAULT_LOCATION_PRECISION=precise`.
- **Opt out:** `TESLA_FLEET_ENABLE_LOCATION=0` (or `false`/`no`/`off`).
- **Scope:** the auth helper's default token now includes `vehicle_location`. Turning location off on the server hides the tool but does **not** remove the scope from an existing token; to drop it, re-run `node scripts/auth-helper.mjs url --no-location` (or `TESLA_AUTH_LOCATION=0`) and sign in once.
- An invalid `precision` argument is refused before any network call.
- **Unrecognised value** (e.g. `disabled`): location is **off** with a warning. Setting the variable at all signals an intent to change the default, most likely an opt-out; guessing "on" would expose location against that intent, while guessing "off" only hides one read.

## Tools

Read (no confirm; never wake the vehicle): `describe_boundary`, `get_api_usage`, `api_status`, `list_vehicles`, `get_vehicle_state`, `get_fleet_status`, `get_battery_charge`, `get_climate`, `get_closures`, `get_tires`, `get_vehicle_status`, `get_security_status`, `get_vehicle_snapshot`, `get_media_state`, `get_schedules`, and `get_location` (on by default; coarse unless `precision=precise`).

- `get_climate` also shows steering wheel heat level and auto, auto seat climate (left/right), rear seat heaters and the cabin overheat activation temperature; `get_battery_charge` shows `charge_current_request_max` and scheduled-charging state.
- `get_security_status` (also a snapshot section, `security`): Valet Mode on/off and whether a valet PIN is needed, Speed Limit Mode (active, current/min/max limit, PIN set) and whether a HomeLink device is nearby. Never a PIN value.
- `get_media_state` (live only; cached data has no media): now playing, playback status, source and volume.
- `get_schedules` (live only): charge and preconditioning schedules with day names and HH:MM times; schedule locations are left out. Read-only: schedules are never changed by this server.

Energy-site reads (no confirm; need the `energy_device_data` scope): `list_energy_sites`, `get_energy_live_status` (solar / battery / home / grid power, battery %, grid and island status, storm watch, plus Wall Connector state and power from the site's `wall_connectors` list), `get_energy_site_info` (backup reserve, off-grid vehicle charging reserve when the site reports it, operation mode, storm watch, export rule, battery count, nameplate), `get_energy_history` (`kind=energy` totals or `kind=backup` events for a bounded date range: `period=day` up to 31 days, `week` up to 92, `month`/`year` up to 366) and `get_wall_connector_charge_history` (`telemetry_history?kind=charge`, up to 31 days: session count, total energy added and, on request, the sessions; Tesla does not document the session fields, so they are passed through with location-like fields dropped at every depth). The location filter is deliberately broad: besides whole words such as `lat`, `lon`, `gps` and `coords`, any key word containing `latitude`, `longitude`, `location` or `coordinate` is dropped, so ordinary words like `relocation`, `dislocation` and `colocation` are dropped too. That is intended (a dropped harmless field is safer than a leaked position); only `allocation` is kept explicitly. If you already have a local gateway integration, it gives the same live values with no API cost; prefer it for polling.

Ownership reads (no confirm; never wake the vehicle): `get_recent_alerts` (recent vehicle alerts), `get_release_notes` (firmware release notes; images left out), `get_service_status` (service center status, estimated completion and visit number from `service_data`; `otherKeys` lists up to 20 names of any other fields Tesla returned, names only and never their values, so new fields are visible without being passed through), `get_warranty` (active, upcoming and expired coverage from `dx/warranty/details`) and `get_recalls` (see below). `get_vehicle_status` (also a `get_vehicle_snapshot` section, `status`) shows the firmware version, a pending or in-progress software update (version, download and install %), the odometer (mi and km) and service mode; `get_tires` adds psi below the recommended cold pressure when the car reports it.

`get_recalls`: the Fleet API has no recalls endpoint, so this reads the public NHTSA recalls API by make, model and model year, which are decoded from the VIN on your machine. **Neither the VIN nor the token is sent to NHTSA**, and the call is not Fleet API usage. Results cover the model year, not the exact car; the Tesla app shows whether a recall applies to and is done on a specific car. The optional `model` argument accepts only `Model S`, `Model 3`, `Model X`, `Model Y` or `Cybertruck` (case-insensitive); anything else is refused with `invalid_arguments` before any call, and a VIN whose first three characters are not a Tesla manufacturer code is not decoded. NHTSA calls are also limited locally (at most one every 5 s and 20 per rolling hour, on top of the 6 h cache); over the limit, `rate_limited_locally` is returned and nothing is sent. To turn NHTSA off entirely, set `TESLA_FLEET_DISABLE_NHTSA=1`.

Tool counts: **26** in the default read-only mode (21 vehicle reads including `get_location` + 5 energy reads), **67** with `TESLA_FLEET_READ_ONLY` off (+ 35 vehicle commands + 5 energy commands + the experimental `play_video_on_screen`), and **71** with both opt-ins on (+ 2 valet commands with `TESLA_FLEET_ENABLE_VALET`, + 2 experimental extras with `TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS`); one fewer each with location turned off, and one fewer each with `TESLA_FLEET_DISABLE_NHTSA` on.

Section reads default to `vehicle_data_cached` (works while asleep, may be hours old; age is reported). `live=true` makes one live `vehicle_data` call **only if the vehicle is already online**. `get_vehicle_snapshot` batches sections into one call.

### Commands

Vehicle commands (hidden unless read-only is explicitly off; signed by your proxy):

| Area | Tools |
|---|---|
| Wake | `wake_vehicle` |
| Climate | `climate_warm_up` (preset), `climate_start`, `climate_stop`, `set_temps`, `set_seat_heater`, `set_steering_wheel_heater`, `set_defrost_max`, `set_cabin_overheat_protection`, `set_cop_temp` (`low`/`medium`/`high` = 30/35/40 °C), `set_climate_keeper_mode` (`off`/`on`/`dog`/`camp`), `set_auto_seat_climate` (driver/passenger, on/off) |
| Security | `door_lock`, `door_unlock`, `actuate_trunk`, `set_sentry_mode`, `flash_lights`, `honk_horn`, `window_control` (`vent`/`close`), `trigger_homelink` |
| Charging | `charge_start`, `charge_stop`, `set_charge_limit` (50-100), `set_charging_amps` (1-48; the car caps it), `charge_port_door_open`, `charge_port_door_close` |
| Navigation | `share_navigation` (address text or lat+lon) |
| Media | `media_toggle_playback`, `media_next_track`, `media_prev_track`, `media_next_fav`, `media_prev_fav`, `media_volume_up`, `media_volume_down`, `adjust_volume` (0-10; out of range is refused) |
| Valet (opt-in) | `set_valet_mode` (on/off), `reset_valet_pin`; only with `TESLA_FLEET_ENABLE_VALET` |

Notes on the 0.6.0 commands (request parameters follow what the stock `tesla-http-proxy` reads in `pkg/proxy/command.go`):

- **`share_navigation` with lat/lon** is sent through `navigation_request` as the text `lat,lon`. Earlier versions posted coordinates to `navigation_gps_request`, which the stock proxy has no handler for (it answers `invalid_command`); `navigation_request` is REST-only in `tesla-http-proxy` (`command requires using the REST API`), so since 0.7.1 the plugin sends it straight to the Fleet API REST endpoint, unsigned, without the proxy (a proxy build that answered with that error and forwarded anyway produced a garbled reply in a field test). **Not field-tested yet:** whether the car resolves the `lat,lon` text the same way as an address. Pass either `destination` or `lat`+`lon`; both together are refused.
- **`trigger_homelink`** is for a person who asks right now. Never from a routine, schedule, geofence or arrival trigger. Before sending, one live read checks that the car reports a HomeLink device nearby (`homelink_nearby`); otherwise it is refused. `lat`/`lon` are the car's position; omit both to use the car's live location (needs location on). Coordinates are never echoed.
- **`window_control`** needs an explicit `vin`. `vent` is sent only when a live read shows the car in Park (`shift_state` `P`, or `shift_state` explicitly null with `speed` 0 or null); anything else (no `drive_state`, an empty or null reply, no `shift_state`, null gear with no speed field, or a failed read) is refused with `gear_unknown`, and a gear other than P (or null gear while moving) with `not_parked`. `close` has no pre-check.
- **`set_cop_temp`**: Tesla's docs number the levels 0/1/2, but the stock proxy passes `cop_temp` straight into the protocol enum where 0 is "unspecified" and 1/2/3 are low/medium/high. The tool takes a name and sends 1/2/3 to cars that use signed commands, or the docs' 0/1/2 to cars that don't (from `fleet_status`). If that is unknown, it refuses.
- **Valet**: on uses the PIN from `TESLA_FLEET_VALET_PIN` (never an argument: `pin`/`password`/`code`/`secret`-like argument names, such as `valet_code`, are refused in any case or spelling, not ignored; never shown, and scrubbed from every command result and error, including a proxy reply that echoes the request); off and `reset_valet_pin` send no PIN. The car must be in Park to turn it on; the PIN can only be reset while Valet Mode is off. Because a 4-digit PIN is short, the scrub replaces every standalone number equal to it in command results and errors: a valid PIN such as `2000` also masks ordinary values like `remote_boombox`'s sound id 2000 (`locate_ping`) as `[redacted]`. Pick a PIN that does not collide with values you need to read. Only a well-formed 4-digit PIN is registered for this scrub; a malformed `TESLA_FLEET_VALET_PIN` is never sent and never masks anything.
- Not added: **Supercharger destinations and multi-stop routes**. Tesla's Fleet API docs list `navigation_sc_request` (navigate to a Supercharger) and `navigation_waypoints_request` (a list of waypoints) but publish no request parameters for either, and the stock `tesla-http-proxy` has no handler for them (like `navigation_gps_request`, they fall through to `invalid_command`; only `navigation_request` is forwarded to the Fleet API). Tesla's published protos have no action for them either; the only signed encodings are reverse-engineered third-party extensions (Supercharger by numeric id plus a trip-order enum, waypoints as one text field of place references) that no one has verified here. Send one destination at a time with `share_navigation`.
- Not added: **auto steering wheel heat**. Tesla's docs list `remote_auto_steering_wheel_heat_climate_request`, but the stock proxy has no handler for it and Tesla's published protos have no action for it, so there is nothing verifiable to sign. Its state is readable in `get_climate`.
- Not added: **steering wheel heat level**. Tesla's docs list `remote_steering_wheel_heat_level_request` (`level`: 0 off, 1 low, 3 high), but the stock proxy has no handler for it (it answers `invalid_command`) and Tesla's published protos have no action for it; they only have the `StwHeatLevel` state enum (0 unknown, 1 off, 2 low, 3 high), which numbers the levels differently from the docs. Nothing verifiable to sign, so no tool; the level is readable in `get_climate`, and `set_steering_wheel_heater` stays on/off.

Energy-site commands (same gates; sent unsigned, directly to the Fleet API, scope `energy_cmds`; no command proxy needed, verified live): `set_backup_reserve` (0-100 %), `set_operation_mode` (`self_consumption` or `autonomous`), `set_storm_mode` (on/off), `set_grid_import_export` (`customer_preferred_export_rule` `pv_only`/`battery_ok`/`never` and/or `disallow_charge_from_grid_with_solar_installed`), `set_off_grid_vehicle_charging_reserve` (10-95 %, the range Tesla's Powerwall installer docs give for the same setting; Tesla rejected 96 in a field test with HTTP 400 "Invalid off grid vehicle charging reserve values", surfaced as `invalid_value` with Tesla's message; `off_grid_vehicle_charging_reserve_percent`; the Powerwall charge kept back from vehicle charging during a grid outage). Before a confirmed live send, `set_off_grid_vehicle_charging_reserve` makes one fresh `site_info` read (bypassing the 10-minute cache): if the site reports `off_grid_vehicle_charging_reserve_supported: false` it refuses (`not_supported`); if the site already reports the requested value it returns `noop: true` and sends nothing; otherwise the result carries `previous`. If the read fails or the value is absent it sends anyway (`precheck: "unavailable"`, `precheckReason` `read_failed` or `value_absent`), except when the read fails with `login_required` or `no_refresh_token`: the send would fail too, so that error is returned and nothing is sent. Previews and `TESLA_FLEET_DRY_RUN` make no read. After Tesla accepts the change (since 0.7.2), it re-reads `site_info` up to 3 times about 5 s apart (roughly 15 s, up to 3 more billed reads) and adds `readBack`: `confirmed` (the site reports the new value), `pending` (accepted, but the site still reports the old value; in a field test the Powerwall accepted a change and the immediate read still showed the old value), `mismatch` (a third value; only when the pre-read gave `previous`) or `unavailable` (every read-back failed), with `readBackValue`, `readBackReads` and, when not confirmed, `readBackMessage`. It never resends. Field-tested: an in-range change and its restore were accepted. A successful call returns an empty `result` (`{}`); an empty (0-byte or whitespace-only) body, `{response: {}}`, `{code: 201, message: "Updated"}` (shown in some docs) and other plain result objects are also success. Every result carries `rawShape` (`empty`, `object`, `response-wrapped`, `null`, `string`, `array` or `other`; shape only, never values) so you can see what Tesla returned. An `error` key, `result: false` (the `reason` is surfaced) or a code of 400+ is reported as `rejected` (`sent: true`); a non-object body is `state_unknown`. Neither is retried. Read the new value back with `get_energy_site_info`.

**`climate_warm_up`** makes "turn on the heat" work with no arguments: climate on, then both setpoints to `TESLA_FLEET_DEFAULT_CLIMATE_TEMP_C`. If the car's cached outside temperature is below the cold threshold it also turns on the default seat heater(s) and (optionally) the steering wheel heater, and below the defrost threshold it turns on max defrost. Override per call with `temp`/`unit`, `seat_heat` (`auto`, `off`, 0-3), `seats` and `defrost` (`auto`, `true`, `false`). Steps run in order and stop at the first failure, reporting `completedSteps`, `failedStep` and `sent: "partial"` when some steps already ran (`failedStepSent` says whether the failed step itself was sent, not sent or unknown). The default 21 °C shows as 70 °F on a car set to Fahrenheit.

### Command safety model

Every command, vehicle or energy:
- is **absent from `tools/list` and refused** unless `TESLA_FLEET_READ_ONLY` is explicitly off (fails closed);
- returns a **dry-run preview** (endpoint and body, zero network calls) unless called with `confirm=true` **and** `user_request` (a short quote of the human's request in the current conversation);
- validates every parameter **before any network call**;
- with `TESLA_FLEET_DRY_RUN=1`, goes through all of the above and returns the exact request (`wouldSend`, VIN masked to the last 4, navigation destination, coordinates and the valet PIN not echoed) without sending anything; use this for a first run;
- is never retried automatically. If the request may have reached the car or site (timeout, 408, any 5xx, or a connection reset after the request started) the result is `state_unknown` with `sent: "unknown"` and the read to use; failures before connecting (refused, DNS, TLS) are `sent: false`.

Vehicle commands additionally:
- go **only** through your proxy (`/api/1/vehicles/{VIN}/command/...`, HTTPS with optional CA pin; never directly to the Fleet API) with your bearer token;
- are refused if no proxy is configured, if the vehicle is not already online (no auto-wake), or if the virtual key is not paired (checked first via `fleet_status`, so you are not billed for a rejected command).

Errors are explicit: `vehicle_not_online`, `virtual_key_missing` (with the pairing link), `proxy_not_configured`, `proxy_unreachable` / `proxy_tls_error` (not sent; energy commands: `fleet_api_unreachable` / `fleet_api_tls_error`), `missing_scope` / `missing_energy_cmds_scope` (names the scope and the auth-helper flag to add), `state_unknown`, `invalid_arguments`. A no-op reason (e.g. `already_set` on `set_charge_limit`, with or without the proxy's `car could not execute command:` prefix) is `ok` with `noChange` only on the command that can return it; any other reason is a rejection (`rawReason` keeps the original text).

Command scopes are **opt-in** in the auth helper: `url --commands` (or `TESLA_AUTH_COMMANDS=1`) adds `vehicle_cmds` and `vehicle_charging_cmds`; `url --energy-commands` (or `TESLA_AUTH_ENERGY_COMMANDS=1`) adds `energy_cmds` (and `energy_device_data`). The default stays read-only.

`door_unlock` and `actuate_trunk` require an explicit `vin`. Local rate limits stay under the documented per-vehicle limits (data 60/min, commands 30/min, wakes 3/min).

### Experimental, opt-in: `dashcam_save_clip`, `remote_boombox`

Listed only when read-only is off **and** `TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS` is on. The stock proxy can't send either (no dashcam endpoint; `remote_boombox` answers "command not implemented"), so they are signed locally like `play_video_on_screen`, with the same key, gates, audit log and 2 billed requests. `dashcam_save_clip` (VehicleAction 47) was field-tested once. `remote_boombox` (VehicleAction 64) plays `fart` (sound id 0) or `locate_ping` (sound id 2000), the two ids in Tesla's Fleet API docs, and nothing else. `locate_ping` only works in robotaxi mode under 10 mph: the car refuses it otherwise with "RemoteBoombox locate ping only allowed in robotaxi mode under 10 mph" (seen in field tests here and reported in teslamotors/vehicle-command#266), returned as `locate_ping_robotaxi_only`. Owner cars refuse it even with the owner standing outside the parked car and the phone key left inside (field-tested), so occupancy and the phone key make no difference. The refusal is recognised by a case-insensitive phrase match on "locate ping only allowed in robotaxi mode" anywhere in the car's reason, not an exact string match. `fart` (id 0, sent as an empty `BoomboxAction`) is field-tested here: accepted and heard outside the car; two independent implementations use the same encoding (Teslemetry, and a vehicle-command fork linked from that issue). There is no unsigned REST fallback: the Fleet API answers `remote_boombox` with 403 on cars that require signed commands (teslamotors/vehicle-command#242, #266) and the stock proxy has no handler. Both action field numbers are community-documented (Teslemetry/tesla-protocol), not in Tesla's published protos.

### Experimental: `play_video_on_screen`

**EXPERIMENTAL** (title "Open URL on car screen"; field-tested on one car, firmware 2026.38.x). Asks the car to open an https URL on its screen with CarServer `videoRequestAction` (field 57, community-documented, not in Tesla's published protos). Stock `tesla-http-proxy` cannot send it, so the server signs the message itself with the virtual key (`TESLA_FLEET_COMMAND_KEY_FILE`, only on the host that holds the key) and posts it to the Fleet API's `/api/1/vehicles/{VIN}/signed_command` (same Fleet API host as reads; no new endpoint). Same gates as every command (hidden unless read-only is off, dry-run without `confirm`, `user_request`, online + paired checks, no auto-wake, no retry), plus: `https` public host names only (no IPs, localhost, private names or credentials, max 2048 characters), a host allowlist (`TESLA_FLEET_VIDEO_HOST_ALLOWLIST`; other hosts need `allow_unlisted_host=true` after the user approves that host), and an audit log line for every call. Costs 2 billed command requests. Observed behaviour: video sites open in the player but do not auto-play; other https pages open in the car's web browser; the first send tends to come to the front, later ones may load silently in the browser; some sites are accepted but not shown; local http/IP addresses are refused by design. Details, field results, the audit format and what is unverified: [docs/EXPERIMENTAL-SIGNED-COMMANDS.md](docs/EXPERIMENTAL-SIGNED-COMMANDS.md). With it, command-mode tool counts are one higher.

**Commands must never be sent from routines, schedules, triggers, webhooks or an agent's own initiative.** The `user_request` field and the skills enforce this as policy; the server cannot see who scheduled a run, so operators who allow unattended agents should keep the server read-only.

Out of scope (TODO in `BACKLOG.md`): Fleet Telemetry streaming, remote start, PIN to Drive and Speed Limit Mode changes, guest mode, sharing, seat cooler writes, charge/precondition schedule writes, auto steering wheel heat (see above), software update commands (scheduling or cancelling an install; reading update status is supported), steering wheel heat level (see above). Left out on purpose: Teslemetry-only extras beyond the ones above.

## Usage counter (local estimate)

`get_api_usage` (a read tool, always listed, no network call) reports this and last month's Fleet API calls **made by this server**, and an estimated cost.

- Every HTTP response from the Fleet API and from your command proxy is counted, by pricing category: `data` (vehicle_data, vehicle_data_cached, location), `command` (via your proxy), `wake` (wake_up). Calls whose pricing category is not documented here (vehicle list and state, `fleet_status`, region lookup, `/status`) go into a separate `other` bucket that is **not** priced in the estimate; a "what if billed as data" figure is shown next to it. Token refreshes are counted as `auth` for information only (authentication is not billed).
- Tesla's rule: responses below HTTP 500 are billable, 500 and above are not. Both are counted (`billable` / `notBilled`, plus `noResponse` for network errors and timeouts); only `billable` goes into the estimate.
- Months are UTC calendar months (Tesla bills from the 1st). The estimate uses Tesla's published rates (data 500 calls per $1, commands 1,000 per $1, wakes 50 per $1) and shows the total before and after the $10 monthly discount. Override the rates with the `TESLA_FLEET_RATE_*` / `TESLA_FLEET_MONTHLY_DISCOUNT_USD` variables if Tesla changes them.
- **It is an estimate.** It does not see calls from Home Assistant, other apps, or other machines using the same developer app. The billing and usage page of your app on the developer portal is the source of truth; set a billing limit there.
- Stored as totals only in `usage.json` next to the token store (same directory, atomic write under a lock, mode `0600`): no VINs, tokens, URLs or vehicle data. The last 13 months are kept. Delete the file to reset.

## Token storage

- Access tokens: memory only, renewed within 60 s of expiry.
- Refresh tokens are single use, so each rotation is written to the token store **before** the new access token is used: atomic write (temp file + fsync + rename) under a lock file, mode `0600`, directory `0700`.
- Default path: `$GROK_PLUGIN_DATA/tokens.json` when the host sets it; otherwise `${XDG_STATE_HOME:-~/.local/state}/grokbot-vehicle-fleet/tokens.json` (Windows: `%LOCALAPPDATA%\grokbot-vehicle-fleet\tokens.json`).
- A `TESLA_REFRESH_TOKEN` value is adopted only if it has not been seen before (first run or a fresh re-consent).

### Access-token export (opt-in)

> **Warning.** The exported token is the plugin's own access token and carries **every scope the plugin was granted**:
> - `vehicle_device_data`: all vehicle data;
> - `vehicle_location`: **full-precision location**, regardless of `TESLA_FLEET_ENABLE_LOCATION` or this server's coarse rounding (those apply only to this server's tools);
> - `vehicle_cmds`, `vehicle_charging_cmds` and `energy_cmds`, if you granted them.
>
> Anyone who can read the file can act as the plugin until the token expires (about 8 h), and a new token is written on every refresh. **Energy-site commands need no proxy signing**, so with `energy_cmds` granted, a reader of the file could change Powerwall settings directly. Read-only mode, `confirm=true` and dry-run protect only this server's tools; they do not limit what the token itself can do.

Use it only for **trusted local consumers on the same host** (for example a read-only poller that must not run its own refresh, because refresh tokens are single use and two refreshers would race and both end up at `login_required`). For a consumer that only needs reads, prefer a **separate read-only sign-in** with a second token store and only the scopes it needs (e.g. `openid offline_access energy_device_data`), and give that consumer its own export file.

- **Off by default.** Unset or empty (or an unexpanded `${...}` placeholder) means nothing is written and nothing is scheduled.
- Set `TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE` to an **absolute** file path in a private directory, e.g. `<state-dir>/grokbot-vehicle-fleet/access-token`. On Windows it must be a drive-letter (`C:\...`) or UNC path; a rooted `\...` path is refused. **Not** `/tmp` or any shared or synced folder (cloud sync, network shares). On POSIX the server warns once if the existing parent directory is group- or world-writable.
- **Who writes it:** the MCP server, not the auth helper. While the server process runs it refreshes once at startup (if a refresh token exists) and writes the file, then refreshes again about 10 minutes before each expiry (`expires_in`, small jitter). These refreshes share the server's single-flight refresh, token-store lock and auth rate limit, so they never race tool calls. Failures back off 1, 5, then 15 minutes (a longer `Retry-After` wins) with one warning; `login_required` stops the loop and leaves the file alone. The timer never keeps the process alive.
- **Freshness:** the file stays fresh **only while the plugin's MCP server process is running**. When the host stops the server, the last token in the file expires within about 8 h. Consumers should re-read the file before each use (or after a `401`).
- Each write replaces the file with the **raw access token string only**: no newline, no JSON, never the refresh token. The write is atomic (temp file created `0600` in the same directory, fsync, rename); a missing parent directory is created with mode `0700`.
- **Refused** (export stays off, one warning on stderr, the server keeps serving) when the path is not absolute, ends in a path separator, or resolves to (or inside) the token store, its `.lock` file or `usage.json`. Paths are compared after resolving symlinks (case-insensitively on Windows and macOS), and an existing target that is the same file as any of them (hardlink: same device and inode) is refused too. The check runs at startup and again before every write.
- A failed write is warned about **once** (error code only) and the server carries on; the next refresh tries again.
- The token and the export path are never logged or returned by a tool. `describe_boundary` shows only `accessTokenExport: on/off`.
- **Windows:** the write is best effort. No ACLs are set; the file inherits the parent directory's ACL, and the `0600`/`0700` modes are not enforced. Put the file under your own profile (e.g. `%LOCALAPPDATA%`).
- To stop exporting, unset the variable, reload, and delete the file.

## Network endpoints

| Endpoint | When |
|---|---|
| `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token` | token refresh (and auth-helper code exchange) |
| `https://auth.tesla.com/oauth2/v3/authorize` | opened by you in a browser via auth-helper |
| `https://fleet-api.prd.na.vn.cloud.tesla.com`, `https://fleet-api.prd.eu.vn.cloud.tesla.com`, `https://fleet-api.prd.cn.vn.cloud.tesla.cn` | Fleet API reads, wake, fleet_status, region lookup, energy-site reads and commands, experimental signed commands (`signed_command`) |
| your `TESLA_COMMAND_PROXY_URL` | signed commands |
| `https://api.nhtsa.gov/recalls/recallsByVehicle` | `get_recalls` only: make, model and model year (no VIN, no token); never when `TESLA_FLEET_DISABLE_NHTSA` is on |

No other endpoints, no telemetry, no analytics. The plugin does not push a telemetry configuration; [docs/TELEMETRY-FIELDS.md](docs/TELEMETRY-FIELDS.md) lists the fields an operator may add for ownership events.

## Privacy

- The plugin stores **no vehicle data**. Reads are cached in memory (vehicle state up to 60 s; alerts 5 min, service status 10 min, release notes 1 h, warranty and recalls 6 h) and discarded when the server exits. The only files it writes are the token store, the usage counter (`usage.json`, totals only) and, only if you opt in, the access-token export file.
- Location is on by default (opt out with `TESLA_FLEET_ENABLE_LOCATION=0`), coarse unless precise is asked for, never written to disk. The vehicle shows a location-sharing indicator when location is read.
- Errors and tool output never include tokens or secrets; VINs appear as last 4 characters except where you passed them.
- Revoke access any time: remove the key on the vehicle's Locks screen, or change third-party app access on your Tesla account. Delete the token store file to forget the refresh token.
- You are the developer of record for your own app: follow the Fleet API Agreement, including its privacy, consent and data-deletion terms.
- The valet PIN is read from `TESLA_FLEET_VALET_PIN` only when `set_valet_mode` on is sent; it is never stored, logged, echoed or returned.
- The experimental signed commands (`play_video_on_screen`, and the opt-in `dashcam_save_clip` / `remote_boombox`) write an audit log (`TESLA_FLEET_AUDIT_LOG`, default `audit.jsonl` next to the token store): the full VIN of a car confirmed on the account (last 4 before that; `TESLA_FLEET_AUDIT_FULL_VIN=0` for the last 6) and the URL host plus a keyed path hash (per-install salt in `<log>.salt`, `0600`) only, never the full URL, query, tokens or keys.

## Event triggers and telemetry alerts (separate bridge)

This plugin is the **request and command path**: an agent asks, the plugin reads (cached first) or, when commands are on, sends one confirm-gated command. It does not watch the car, receive telemetry or push alerts.

Event triggers (charge complete, plugged in or unplugged, door or trunk open while parked, Sentry alerts, low battery, software update available), ownership events (software updates, odometer milestones, vehicle alerts, service, tires, battery, charging faults, safety, Sentry, recalls; immediate or in a weekly digest) and energy-site alerts (grid outage, battery near the backup reserve, storm watch) live in an event bridge with a Tesla source adapter. The reference event bridge is [`grok-bot-universal-bridge`](https://github.com/matthew-rutledge-dev/grok-bot-universal-bridge)'s Tesla adapter ([`adapters/tesla`](https://github.com/matthew-rutledge-dev/grok-bot-universal-bridge/tree/main/adapters/tesla); setup in its `docs/TESLA-CUTOVER.md`); any compatible bridge works. It is a **separate, self-hosted project, not part of this repository**; you install and run it yourself, and this plugin neither ships nor starts it. That bridge:

- receives Fleet Telemetry records from Tesla's own `fleet-telemetry` server (which you host behind a public mTLS endpoint) and polls energy-site `live_status` read-only;
- wakes an agent with a short prompt carrying a masked VIN or site id;
- never sends vehicle commands, never wakes a car and never polls `vehicle_data`;
- needs only an **access token** (no refresh token) for energy reads, because this plugin owns OAuth refresh and refresh tokens are single-use. See [Access-token export (opt-in)](#access-token-export-opt-in) for how this plugin can share one, and why a separate read-only sign-in is usually the better choice.

When an alert needs an action, the agent comes back through this plugin's confirm-gated tools. Pushing a `fleet_telemetry_config` to a car is a one-time vehicle configuration change made by the operator (it is signed, like commands); this plugin does not do it. Without the bridge, the plugin works exactly as described here.

## Roadmap

- Planned: a Home Assistant custom integration (`custom_components/vehicle_fleet/`, installable via the HA Marketplace or HACS) in this repo, after v0.1. See `BACKLOG.md`.

## Development

```bash
cd mcp/vehicle-fleet
npm ci --ignore-scripts
npm run typecheck
npm test     # builds, then unit tests + MCP stdio smoke against local fakes (no real API calls)
```

CI runs the same on ubuntu-latest and windows-latest (Node 22.19.0, latest 22 and 24), with no secrets. Requires Node 22.19 or newer (undici 8 needs it).

## Dependency policy

- Use the latest versions of dependencies, GitHub Actions and runtimes.
- `@types/node` tracks the latest Node; CI also runs on the exact `engines` minimum (22.19.0), so any use of a newer-only API fails there at runtime.
- Take major updates when CI passes; fix the code if a major update needs it rather than holding back.
- Pin a version only with a stated reason next to the pin (for example a workflow that handles secrets or has write access, or a known regression).
- When a dependency raises its minimum runtime, bump `engines` and the documented minimum in the same change.

## Security

No tokens in git. If your token store, client secret or private key leaks: revoke the app's access on your account, rotate the client secret, re-pair keys, and notify Tesla as the Fleet API Agreement requires.

## Acknowledgements

Design ideas (no code copied) came from two MIT-licensed projects: [pjordan/tesla-fleet-mcp](https://github.com/pjordan/tesla-fleet-mcp) and [tylergibbs1/tesla-mcp-server](https://github.com/tylergibbs1/tesla-mcp-server). Signed commands rely on Tesla's [vehicle-command](https://github.com/teslamotors/vehicle-command) `tesla-http-proxy` (Apache-2.0), which you run yourself; it is not bundled. See `THIRD_PARTY_NOTICES.md`.

## License

MIT - see [LICENSE](LICENSE).
