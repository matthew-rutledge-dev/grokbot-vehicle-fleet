# Changelog

## 0.7.0

One new energy command, a skipped vehicle command with the reasons, and review follow-ups from 0.6.2.

- New `set_off_grid_vehicle_charging_reserve` (`POST /api/1/energy_sites/{id}/off_grid_vehicle_charging_reserve`, body `{"off_grid_vehicle_charging_reserve_percent": <int>}`, scope `energy_cmds`, sent directly to the Fleet API like the other energy commands). Body and type checked against Tesla's Fleet API docs (integer, example 20; the docs give no range, so the tool accepts a whole percent 0-100 and refuses floats, strings, booleans, null and anything out of range). Same gates as the other energy commands: hidden and refused unless `TESLA_FLEET_READ_ONLY` is explicitly off (fails closed), preview without `confirm`, `user_request` required with `confirm=true`, `TESLA_FLEET_DRY_RUN` honoured, never retried. A confirmed live send first makes one fresh `site_info` read (bypassing the cache): `off_grid_vehicle_charging_reserve_supported: false` is refused (`not_supported`), a value already equal to the request returns `noop: true` with nothing sent, otherwise the result carries `previous`; a failed read or an absent value sends anyway with `precheck: "unavailable"`. Not field-tested yet.
- `get_energy_site_info` now passes through `off_grid_vehicle_charging_reserve_percent` when the site returns it (Tesla's documented example shows only `components.off_grid_vehicle_charging_reserve_supported`, which was already shown).
- Not added: steering wheel heat level (`remote_steering_wheel_heat_level_request`). Tesla's docs list it with `level` 0 = off, 1 = low, 3 = high; the stock `tesla-http-proxy` has no handler (falls through to `invalid_command`), and Tesla's published protos have no action for it, only the `StwHeatLevel` state enum (0 unknown, 1 off, 2 low, 3 high), which numbers the levels differently from the docs. Nothing verifiable to sign, so recorded in BACKLOG. `set_steering_wheel_heater` stays on/off; no climate default or warm-up step changed.
- Energy command cache invalidation now deletes the site's exact `site_info` / `live_status` keys instead of a prefix (a prefix could also drop another site whose id starts with the same digits).
- Docs: the location filter deliberately drops ordinary words containing a long location stem, such as `relocation`, `dislocation` and `colocation` (safe default; only `allocation` is kept).
- Changelog: headings for 0.6.0 and older no longer say unreleased.
- Tool counts: 26 read-only, 67 with commands on, 71 with both opt-ins.

## 0.6.2

Review follow-ups from 0.6.1 and a docs pointer. No new commands; tool counts unchanged.

- Location filtering for undocumented records (`get_wall_connector_charge_history` sessions): trailing digits are stripped from each key word (`lat1`, `lon2`, `longitude2`), run-together pairs (`latlng`, `latlon`, `lnglat`, `lonlat`) are location words, and each word is also checked for the long stems `latitude`, `longitude`, `location` and `coordinate` as substrings (`homelatitude`, `sitelocation`, `gpscoordinates`). Short stems (`lat`, `lon`, `lng`, `geo`) are still matched only as whole words, so `translation`, `platform`, `salon`, `flatness` and `latency_ms` are kept; `allocation` is kept explicitly.
- Docs: the event-bridge section (README, `docs/TELEMETRY-FIELDS.md`, setup skill) now names `grok-bot-universal-bridge`'s Tesla adapter as the reference event bridge; any compatible bridge still works, and the plugin still neither ships nor starts it.
- Changelog: the 0.6.1 heading no longer says unreleased.

## 0.6.1

Review follow-ups from 0.6.0 and a navigation check. No new commands; tool counts unchanged.

- Navigation research: `navigation_sc_request` (Supercharger by id) and `navigation_waypoints_request` (multi-stop) are **not added**. Tesla's Fleet API docs list them without request parameters, the stock `tesla-http-proxy` has no handler for either (`invalid_command`, like `navigation_gps_request`), and Tesla's published protos have no action for them; the only signed encodings are unverified third-party reverse engineering. Reasons recorded in BACKLOG, README and skills. `share_navigation` stays one destination per send.
- Valet PIN redaction: only a well-formed 4-digit `TESLA_FLEET_VALET_PIN` is registered as a short secret. A malformed value (never sent anyway) no longer masks unrelated numbers in other tools' replies.
- Valet arguments: `code`, `secret`, `valet_code`, `valet_secret` and `valet_passcode` (any case or separator, e.g. `Valet-Code`, `valetCode`) are now refused like `pin`/`password`, not ignored.
- Docs: a valid PIN such as `2000` also masks ordinary numbers equal to it (for example `remote_boombox` sound id 2000) in command results and errors.
- Location filtering for undocumented records (`get_wall_connector_charge_history` sessions): keys are split on separators and camelCase, so `coords`, `homeLatitude`, `homeLongitude`, `HomeLat`, `gpsLng`, `geoLocation` and similar are dropped at every depth, alongside the snake_case names already covered.

## 0.6.0

More commands and reads. Every new command is hidden unless `TESLA_FLEET_READ_ONLY` is explicitly off (fails closed), previews without `confirm`, needs `user_request` with `confirm=true`, honours `TESLA_FLEET_DRY_RUN`, never wakes the car and is never retried. Request bodies follow the parameter names and enums the stock `tesla-http-proxy` reads (`pkg/proxy/command.go`); new read field names follow Tesla's Fleet Telemetry field list (`vehicle_data` equivalents).

- Fix: `share_navigation` with `lat`/`lon` now goes through `navigation_request` as `lat,lon` text. It used to post to `navigation_gps_request`, which the stock proxy has no handler for (`invalid_command`); `order` is no longer sent. Coordinates are never echoed. `destination` and `lat`/`lon` together are refused. The `lat,lon` share text is not field-tested yet.
- `trigger_homelink`: one live read first; sent only when the car reports `homelink_nearby` (`homelink_not_nearby` / `homelink_state_unknown` otherwise). `lat`/`lon` optional; omitted = the car's live location (needs location on). For a person asking right now only; the description, skills and guide forbid automation.
- `window_control` (`vent`/`close`, explicit `vin`): `vent` only when a live read shows Park (`shift_state` `P`, or `shift_state` explicitly null with `speed` 0 or null); anything else (missing, empty or null `drive_state` or reply, no `shift_state`, null gear without a speed field, a failed read) is refused with `gear_unknown`; a gear other than P, or null gear while moving, is `not_parked`.
- Media: `media_toggle_playback`, `media_next_track`, `media_prev_track`, `media_next_fav`, `media_prev_fav`, `media_volume_up`, `media_volume_down`, `adjust_volume` (0-10; out of range refused, not clamped).
- Climate: `set_cop_temp` (`low`/`medium`/`high` = 30/35/40 °C). Tesla's docs number them 0/1/2, but the stock proxy passes the value straight into the protocol enum (0 = unspecified, 1-3 = low-high), so the tool sends 1-3 when `fleet_status` says the car needs signed commands and 0-2 otherwise; if unknown it refuses with `cop_mapping_unknown`. `set_climate_keeper_mode` (`off`/`on`/`dog`/`camp`), `set_auto_seat_climate` (`remote_auto_seat_climate_request`, driver/passenger).
- Valet (opt-in, new `TESLA_FLEET_ENABLE_VALET`, off by default): `set_valet_mode` on/off and `reset_valet_pin`, explicit `vin`. The PIN comes only from new `TESLA_FLEET_VALET_PIN` (4 digits), read at send time; it is never a tool argument (`pin`/`password`-like argument names are refused, case- and separator-insensitive) and never logged, echoed or shown in a preview. It is on the server's redaction list: every command result and error body is scrubbed (digit-bounded matches, numbers and keys), so a proxy 400 body or `result:false` reason that echoes the request cannot leak it; stderr logging is scrubbed too. Off and reset send no PIN.
- Experimental signed extras (opt-in, new `TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS`, off by default): `dashcam_save_clip` (action 47) and `remote_boombox` (action 64, `fart` = 0 or `locate_ping` = 2000 only). Same key, audit log and gates as `play_video_on_screen`, whose code path is unchanged.
- Reads: `get_security_status` (also snapshot section `security`, now the default six sections): Valet Mode and PIN-needed, Speed Limit Mode, HomeLink nearby; never a PIN. `get_media_state` and `get_schedules` (charge and preconditioning schedules; schedule locations dropped), live only. `get_climate` adds steering wheel heat level and auto, auto seat climate, rear seat heaters and COP activation temperature; `get_battery_charge` adds `charge_current_request_max`, scheduled-charging pending and preconditioning. `get_wall_connector_charge_history` (`telemetry_history?kind=charge`, up to 31 days; session fields are undocumented, so passed through with location-like keys dropped at every depth).
- `describe_boundary` shows the valet block (enabled, PIN configured: yes/no only) and whether the experimental extras are on.
- Not added: auto steering wheel heat (`remote_auto_steering_wheel_heat_climate_request` has no stock proxy handler and no action in Tesla's published protos; its state is readable). Out of scope: guest mode, Speed Limit Mode changes, PIN to Drive, remote start, seat cooler, schedule writes, Teslemetry-only extras.
- Windows key ACL check (review nits from 0.5.1): `icacls` runs asynchronously (no 5 s stall of a preview) from `%SystemRoot%\System32` by full path; the PowerShell example uses `${env:USERNAME}`. The 0.5.1 changelog heading was already corrected.
- Tool counts: 26 read-only, 66 with commands on, 70 with both opt-ins (one fewer each with location off, and one fewer each with NHTSA disabled).

## 0.5.1

Field results for `play_video_on_screen` and small fixes.

- `play_video_on_screen` gets the MCP title "Open URL on car screen (experimental)"; the tool name is unchanged. Its description now says what the car was seen to do: video sites open in the player without auto-play, other https pages open in the car's web browser, the first send tends to come to the front while later ones may load silently, some sites are accepted but never shown, and local http/IP addresses are refused by design.
- Docs: `docs/EXPERIMENTAL-SIGNED-COMMANDS.md` adds generic field results (firmware 2026.38.x: action 57 accepted, a video site and a general web page opened, a home-automation remote URL accepted but not shown; action 47 dashcam save confirmed by a manual-save entry) and narrows the "not verified" list.
- Windows: previews add a non-fatal `commandKeyWarning` when `icacls` shows Everyone, Users or Authenticated Users (or their SIDs) with read, write or full rights on `TESLA_FLEET_COMMAND_KEY_FILE`. POSIX checks are unchanged (still enforced).
- VIN placeholder in docs, schema and tests is now 17 characters (`5YJ0000000EXAMPLE`).
- Dependencies: `@types/node` 26.6.6.

## 0.5.0

Experimental `play_video_on_screen`.

- New EXPERIMENTAL command `play_video_on_screen` (hidden unless read-only is off): asks the car to open a video URL on its screen via CarServer `videoRequestAction` (field 57, community-documented, unverified on live vehicles). Dry-run without `confirm`; `confirm=true` needs `user_request`; honours `TESLA_FLEET_DRY_RUN`; vehicle must be online (no auto-wake) and the key paired; never retried.
- URL checks before anything else: `https` only, no credentials, no IP literals, no `localhost` / single-label / private or special-use names, no whitespace, max 2048 characters. New `TESLA_FLEET_VIDEO_HOST_ALLOWLIST` (exact hosts or `*.domain`); any other host, or every host when the list is unset, also needs `allow_unlisted_host=true`. Non-default ports only when an allowlist entry names them (`host:port`). The normalised URL is also capped at 2048 characters. Documented limit: names resolving to private addresses and look-alike characters are not detected, hence the explicit approval for unlisted hosts.
- New self-contained signed_command helper (`src/signed/`): Vehicle Command Protocol handshake (session info HMAC-verified), HMAC-SHA256 personalized command authentication, AES-GCM ack decryption, sent to Fleet API `/api/1/vehicles/{vin}/signed_command` (not the proxy, which cannot encode this action). Needs the virtual-key private key on the same host: new `TESLA_FLEET_COMMAND_KEY_FILE`, which must be `chmod 600` and owned by the server's user on POSIX (`command_key_insecure_permissions` otherwise); previews only stat it. Unencrypted replies are reported as unverified; an unusable 200 reply to the command is `state_unknown`. Checked against `vehicle-command`'s protocol.md examples and byte for byte against its Go implementation. 2 billed command requests per call.
- New audit log for experimental signed commands, `TESLA_FLEET_AUDIT_LOG` (default `audit.jsonl` next to the token store, `0600`): refused / dry_run / attempt / result / failure, with the full VIN of a car confirmed on the account (new `TESLA_FLEET_AUDIT_FULL_VIN`, default on; off = last 6; an unconfirmed caller-supplied VIN = last 4) and the URL host + keyed path hash only (HMAC with a per-install salt in `<log>.salt`). Existing log files and folders are tightened to `0600`/`0700`. Writability is checked before the billable pre-checks; a command is not sent if its audit line cannot be written.
- `describe_boundary` shows an `experimental` block (key configured, allowlist size, audit on). Docs: `docs/EXPERIMENTAL-SIGNED-COMMANDS.md`.
- Tool counts: 22 read-only, 49 with commands on (one fewer each with location off, and one fewer each with NHTSA disabled).

## 0.4.0

Ownership reads. All read-only, no confirm, never wake the car; nothing is hidden or unlocked by them, and the read-only switch still fails closed.

- `get_vehicle_status` (and snapshot section `status`): firmware version, a pending or in-progress software update (`status`, `version`, `download_perc`, `install_perc`, `expected_duration_sec`, `scheduled_time_ms`, plus `pending`), odometer in mi and km, service mode. From `vehicle_state`, cached by default. `get_vehicle_snapshot` now defaults to all five sections.
- `get_tires` adds `recommendedPsi` and `psiBelowRecommended` per tire when the car reports a recommended cold pressure.
- `get_recent_alerts` (`recent_alerts`), `get_release_notes` (`release_notes`; image links left out), `get_service_status` (`service_data`: service status, estimated completion, visit number) and `get_warranty` (`dx/warranty/details`: active, upcoming, expired). One billable data call each, cached in memory 5 min to 6 h, rate-limited like other data reads.
- `get_recalls`: the Fleet API has no recalls endpoint, so this reads the public NHTSA recalls API by make, model and model year decoded from the VIN locally. Neither the VIN nor the token is sent to NHTSA, and the call is not counted as Fleet API usage. Covers the model year, not the exact car. An undecodable VIN is refused before any call unless `model` and `model_year` are passed.
- `get_recalls` hardening: the `model` argument is checked in the handler against the five Tesla models (case-insensitive) and anything else, such as free text or a VIN, is refused with `invalid_arguments` before any network call. VIN decoding now requires a Tesla manufacturer code (`5YJ`, `7SA`, `7G2`, `LRW`, `XP7`, `SFZ`). A local NHTSA limiter (one request per 5 s, 20 per rolling hour, on top of the 6 h cache) refuses with `rate_limited_locally` and sends nothing.
- New `TESLA_FLEET_DISABLE_NHTSA`: `1`/`true`/`yes`/`on` (or an unrecognised value, with a warning) hides and refuses `get_recalls`, so nothing is sent to NHTSA. `describe_boundary` shows `nhtsaRecallsEnabled`.
- `get_tires`: `psiBelowRecommended` is clamped at 0 (a tire at or above the recommended pressure reads 0, never negative).
- `get_service_status`: `otherKeys` lists up to 20 names of other fields Tesla returned (names only, never values); documented.
- HTTP: `Content-Type` is sent only with a request body (bodiless GETs, including NHTSA, no longer send it).
- Docs: `docs/TELEMETRY-FIELDS.md` lists the Fleet Telemetry fields and intervals the separate event bridge needs for ownership events, what Tesla does not expose, the `alert_types` caveat and an example `fleet_telemetry_config` body (placeholders; reference only, not pushed). README endpoint table adds NHTSA.
- Tool counts: 22 read-only, 48 with commands on (one fewer each with location off, and one fewer each with NHTSA disabled).

## 0.3.3

- New, opt-in and **off by default**: `TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE`. When set to an absolute path, the MCP server (not the auth helper) refreshes once at startup and then about 10 minutes before each access-token expiry, and writes the raw token string there each time (no newline, no JSON, never the refresh token), atomically (temp `0600` + fsync + rename), with a missing parent directory created `0700`. The keep-fresh loop shares the server's single-flight refresh, store lock and auth rate limit, backs off 1/5/15 min on failure, stops on `login_required` (file left as is), and its timer is unref'd. The file stays fresh only while the server runs; after it stops the token expires within about 8 h.
- Collision guard: a relative path (on Windows, anything but a drive-letter or UNC path), or one that resolves (symlinks followed; case-insensitive on Windows and macOS) to or inside the token store, its lock file or `usage.json`, or an existing target with the same device + inode, is refused with a warning, and the server keeps serving. Re-checked before every write. One safe warning if the parent directory is group- or world-writable. A failed write warns once and continues. The token and path are never logged or returned; `describe_boundary` shows `accessTokenExport: on/off`. Windows: best effort, no ACLs set.
- Docs: a loud warning that the exported token carries all granted scopes (vehicle data, full-precision location regardless of the location settings, and `vehicle_cmds` / `energy_cmds` if granted; energy commands need no proxy signing), not to use `/tmp` or shared or synced folders, and to prefer a separate read-only sign-in for read-only consumers.

## 0.3.2

- Fix: no-op command reasons wrapped by tesla-http-proxy ("car could not execute command: already_set") are now recognised, so e.g. setting the charge limit to its current value reports `noChange` instead of a rejection. Reasons are normalised (prefix stripped, trimmed, lower-cased); the original text is kept in `rawReason`. The `vcsec could not execute command:` prefix is deliberately not stripped (stays a rejection).
- No-op reasons are now scoped to their command: `already_set` (set_charge_limit, set_charging_amps), `is_charging` / `complete` / `requested` (charge_start), `not_charging` (charge_stop), `already_started` (charge_standard, charge_max_range), `already closed` (charge_port_door_close). Any other reason is a rejection. `disconnected` and `no_power` are no longer treated as no-ops: charge_start now reports them as rejections with friendly text.
- Energy command TLS / connection failures name the Fleet API (`fleet_api_tls_error`, `fleet_api_unreachable`) and no longer point at the proxy CA variable.
- Docs: full generic `tesla-http-proxy` walkthrough in the setup skill (pinned official image or release build, run as the uid:gid owning the key files, self-signed CA and SAN, loopback/LAN-only binding, health check, dry-run then fleet_status then flash_lights), and a README pointer noting the proxy has no client authentication.

## 0.3.1

- **Location is on by default** (the server runs for its owner). `get_location` is listed unless `TESLA_FLEET_ENABLE_LOCATION` is `0`/`false`/`no`/`off`; an unrecognised value turns location off with a warning. Coarse (~1 km) stays the default; new `TESLA_FLEET_DEFAULT_LOCATION_PRECISION` (`coarse`/`precise`). An invalid `precision` argument is refused before any network call (no token refresh or vehicle lookup).
- `get_location` reports `missing_location_scope` with the fix when the token lacks `vehicle_location`.
- Auth helper: `vehicle_location` is now in the default scopes; `url --no-location` / `TESLA_AUTH_LOCATION=0` drops it. Turning location off on the server does not remove the scope from an existing token.
- Energy commands: success is `{}` (seen live), `{response: {}}`, an empty (0-byte or whitespace-only) body, `{code: 201}` or another plain result object. Results include a debug-safe `rawShape` (shape only, no values). An `error` key, `result: false` (reason surfaced) or code 400+ is `rejected` (`sent: true`); a null, string or other non-object body is `state_unknown`. No retries.
- `wake_vehicle` dry-run masks the VIN; `describe_boundary` text updated for location on by default. Docs: energy commands are unsigned and need no command proxy (verified live).
- `TESLA_FLEET_PROXY_CA_FILE` is accepted as an alias for `TESLA_COMMAND_PROXY_CA_CERT` (used only when the primary name is unset).
- Tool counts: 16 read-only, 42 with commands on (one fewer each with location off).

## 0.3.0

Command tools. Still read-only by default; every command stays hidden and refused unless `TESLA_FLEET_READ_ONLY` is explicitly off.

- New vehicle commands: `set_seat_heater`, `set_steering_wheel_heater`, `set_cabin_overheat_protection`, `set_defrost_max`, `set_sentry_mode`, `flash_lights`, `honk_horn`, `set_charging_amps`, `charge_port_door_open`, `charge_port_door_close`.
- `climate_warm_up` preset: climate on plus setpoints, and seat / steering wheel heat and max defrost when the cached outside temperature is cold. Defaults are configurable with `TESLA_FLEET_DEFAULT_CLIMATE_TEMP_C`, `TESLA_FLEET_DEFAULT_SEAT_HEAT_LEVEL`, `TESLA_FLEET_DEFAULT_HEATED_SEATS`, `TESLA_FLEET_COLD_OUTSIDE_BELOW_C`, `TESLA_FLEET_DEFROST_OUTSIDE_BELOW_C` and `TESLA_FLEET_STEERING_WHEEL_HEAT_WHEN_COLD`.
- Energy-site commands: `set_backup_reserve`, `set_operation_mode`, `set_storm_mode`, `set_grid_import_export` (scope `energy_cmds`; sent directly to the Fleet API).
- `TESLA_FLEET_DRY_RUN=1`: confirmed commands are validated and return the exact request without sending it (VIN masked, navigation destination not echoed). Fails closed: unrecognised values turn dry-run on with a warning.
- Command outcome is `state_unknown` (`sent: "unknown"`, no retry) for timeouts, 408, 5xx and connection errors after the request started; pre-connect failures stay `sent: false`. Multi-step presets report `sent: "partial"` when some steps ran.
- Clearer command errors: `proxy_unreachable` and `proxy_tls_error` (not sent), and `missing_scope` names the scope and the auth-helper flag to add.
- Auth helper: opt-in `--commands` / `TESLA_AUTH_COMMANDS` (vehicle_cmds, vehicle_charging_cmds) and `--energy-commands` / `TESLA_AUTH_ENERGY_COMMANDS` (energy_cmds); unknown flags are rejected. Default scopes unchanged.
- `describe_boundary` shows the dry-run mode and climate defaults.
- Tests for every command's request shape, confirm/read-only/dry-run gates, parameter validation before any network call, proxy failures, scope hints and redaction.

## 0.2.2

- CI also runs on Node 22.19.0 (the exact `engines` minimum) next to latest 22 and 24, on ubuntu and windows.
- Bootstrap scripts warn (without failing) when Node is older than 22.19.
- `not_configured` and `proxy_not_configured` messages mention the `TESLA_FLEET_*` aliases.
- README: why `@types/node` stays at latest.

## 0.2.1

Dependency updates.

- undici 8, TypeScript 7, @types/node 26.
- Node.js 22.19 or newer is now required (`engines` `>=22.19`; undici 8 needs it).
- README: dependency policy (latest versions, majors when CI passes, pins only with a stated reason, bump `engines` with dependencies).

## 0.2.0

Energy-site reads (Powerwall / solar; Wall Connector via site live status). Read-only; no energy commands.

- New read tools: `list_energy_sites` (`GET /api/1/products`, vehicles filtered out, gateway ids dropped), `get_energy_live_status` (power flows, battery %, grid/island status, storm watch, plus `wall_connectors` state and power; cached 60 s), `get_energy_site_info` (backup reserve, operation mode, storm watch, export rule, battery count, nameplate; address and tariff fields are not returned; cached 10 min) and `get_energy_history` (`calendar_history`, `kind=energy` totals or `kind=backup` events; bounded ranges per period; validated before any call; cached 5 min).
- Site resolution: explicit `energy_site_id` > `TESLA_DEFAULT_ENERGY_SITE_ID` > the only site; the product list is reused for 5 minutes.
- `percentage_charged` is rounded to one decimal; live status includes a power sign note.
- Only scope-related 403s map to `missing_scope` (energy calls: `missing_energy_scope` with the re-consent hint); other 403s stay a generic `forbidden`.
- `energy_site_id` must be a string of digits; numbers are refused, and an unsafe numeric id from the API is refused instead of rounded.
- Auth helper: `url --energy` or `TESLA_AUTH_ENERGY=1` adds the `energy_device_data` scope. The default scopes are unchanged.
- Energy reads are counted as `data` in `get_api_usage`.
- Tool counts: 15 read-only (11 vehicle + 4 energy), 26 with commands on.
- Manifests, MCP configs, README, skills and troubleshooting reference updated.

## 0.1.2

Fixes from the first read-only live test.

- VIN resolution reuses the vehicle list for 5 minutes instead of listing vehicles again on every read (saves one billable call per tool call when no default VIN is set). `list_vehicles` still fetches a fresh list.
- `TESLA_FLEET_CLIENT_ID`, `TESLA_FLEET_CLIENT_SECRET` and `TESLA_FLEET_PROXY_URL` are accepted as aliases (server and auth helper); the primary `TESLA_*` name wins. Both MCP configs pass the aliases through.
- `api_status` returns Tesla's plain-text status body (`ok`) instead of a `non_json_response` error object. Plain-text success bodies are kept as text; error bodies keep the structured shape.
- `get_closures` reports `windowsOpen` as unknown when the data source has no window fields (cached data often omits them) instead of an empty object.
- Docs: PowerShell env loaders should run under PowerShell 7 (`pwsh`).

## 0.1.1

Review fixes.

- Node.js 22 or newer is now required (`engines` `>=22`); Node 20 is end of life.
- CI runs on Node 22 and 24 (ubuntu + windows), with workflow concurrency (cancel in progress) and a 15-minute job timeout.
- Broader token redaction: error output and startup stderr also redact the stored, spent and rotated refresh tokens and the in-memory access token, not only the `TESLA_REFRESH_TOKEN` seed.
- Bootstrap scripts and CI install with `npm ci --ignore-scripts`.
- Dependabot: weekly updates for GitHub Actions and npm.

## 0.1.0

- First scaffold: one `vehicle-fleet` stdio MCP server, five skills, three manifests (Grok Build, Grok Bot/root, Cursor) and two MCP configs.
- Read tools (cached-first, never wake), opt-in coarse location, confirm-gated command tools hidden unless `TESLA_FLEET_READ_ONLY` is explicitly off (fails closed).
- TokenManager with single-flight refresh and atomic, locked, persisted refresh-token rotation; access tokens memory-only.
- Command proxy with configured CA (TLS never disabled); key-pairing and online pre-checks; no automatic retries.
- Local rate buckets under the documented per-vehicle limits; Fleet API error mapping.
- Optional operator-run `scripts/auth-helper.mjs`.
- Local Fleet API usage counter and `get_api_usage` read tool: counts every Fleet API / proxy response by pricing category (data, command, wake; `other` kept apart and not priced; `auth` info only), billable (<500) vs not billed (>=500), UTC month buckets persisted to `usage.json` next to the token store (totals only), estimated cost before/after the monthly discount. Rates overridable via `TESLA_FLEET_RATE_*` and `TESLA_FLEET_MONTHLY_DISCOUNT_USD`. Local estimate only; the developer portal billing page is the source of truth.
- Tool counts: 11 read-only, 22 with commands on (+ `get_location` when enabled).
- Tests: unit (mocked HTTP) + MCP stdio smoke against a local fake server; CI on ubuntu + windows.
