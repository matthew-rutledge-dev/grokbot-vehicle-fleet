# Changelog

## 0.4.0 (unreleased)

Ownership reads. All read-only, no confirm, never wake the car; nothing is hidden or unlocked by them, and the read-only switch still fails closed.

- `get_vehicle_status` (and snapshot section `status`): firmware version, a pending or in-progress software update (`status`, `version`, `download_perc`, `install_perc`, `expected_duration_sec`, `scheduled_time_ms`, plus `pending`), odometer in mi and km, service mode. From `vehicle_state`, cached by default. `get_vehicle_snapshot` now defaults to all five sections.
- `get_tires` adds `recommendedPsi` and `psiBelowRecommended` per tire when the car reports a recommended cold pressure.
- `get_recent_alerts` (`recent_alerts`), `get_release_notes` (`release_notes`; image links left out), `get_service_status` (`service_data`: service status, estimated completion, visit number) and `get_warranty` (`dx/warranty/details`: active, upcoming, expired). One billable data call each, cached in memory 5 min to 6 h, rate-limited like other data reads.
- `get_recalls`: the Fleet API has no recalls endpoint, so this reads the public NHTSA recalls API by make, model and model year decoded from the VIN locally. Neither the VIN nor the token is sent to NHTSA, and the call is not counted as Fleet API usage. Covers the model year, not the exact car. An undecodable VIN is refused before any call unless `model` and `model_year` are passed.
- Docs: `docs/TELEMETRY-FIELDS.md` lists the Fleet Telemetry fields and intervals the separate event bridge needs for ownership events, what Tesla does not expose, the `alert_types` caveat and an example `fleet_telemetry_config` body (placeholders; reference only, not pushed). README endpoint table adds NHTSA.
- Tool counts: 22 read-only, 48 with commands on (one fewer each with location off).

## 0.3.3 (unreleased)

- New, opt-in and **off by default**: `TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE`. When set to an absolute path, the MCP server (not the auth helper) refreshes once at startup and then about 10 minutes before each access-token expiry, and writes the raw token string there each time (no newline, no JSON, never the refresh token), atomically (temp `0600` + fsync + rename), with a missing parent directory created `0700`. The keep-fresh loop shares the server's single-flight refresh, store lock and auth rate limit, backs off 1/5/15 min on failure, stops on `login_required` (file left as is), and its timer is unref'd. The file stays fresh only while the server runs; after it stops the token expires within about 8 h.
- Collision guard: a relative path (on Windows, anything but a drive-letter or UNC path), or one that resolves (symlinks followed; case-insensitive on Windows and macOS) to or inside the token store, its lock file or `usage.json`, or an existing target with the same device + inode, is refused with a warning, and the server keeps serving. Re-checked before every write. One safe warning if the parent directory is group- or world-writable. A failed write warns once and continues. The token and path are never logged or returned; `describe_boundary` shows `accessTokenExport: on/off`. Windows: best effort, no ACLs set.
- Docs: a loud warning that the exported token carries all granted scopes (vehicle data, full-precision location regardless of the location settings, and `vehicle_cmds` / `energy_cmds` if granted; energy commands need no proxy signing), not to use `/tmp` or shared or synced folders, and to prefer a separate read-only sign-in for read-only consumers.

## 0.3.2 (unreleased)

- Fix: no-op command reasons wrapped by tesla-http-proxy ("car could not execute command: already_set") are now recognised, so e.g. setting the charge limit to its current value reports `noChange` instead of a rejection. Reasons are normalised (prefix stripped, trimmed, lower-cased); the original text is kept in `rawReason`. The `vcsec could not execute command:` prefix is deliberately not stripped (stays a rejection).
- No-op reasons are now scoped to their command: `already_set` (set_charge_limit, set_charging_amps), `is_charging` / `complete` / `requested` (charge_start), `not_charging` (charge_stop), `already_started` (charge_standard, charge_max_range), `already closed` (charge_port_door_close). Any other reason is a rejection. `disconnected` and `no_power` are no longer treated as no-ops: charge_start now reports them as rejections with friendly text.
- Energy command TLS / connection failures name the Fleet API (`fleet_api_tls_error`, `fleet_api_unreachable`) and no longer point at the proxy CA variable.
- Docs: full generic `tesla-http-proxy` walkthrough in the setup skill (pinned official image or release build, run as the uid:gid owning the key files, self-signed CA and SAN, loopback/LAN-only binding, health check, dry-run then fleet_status then flash_lights), and a README pointer noting the proxy has no client authentication.

## 0.3.1 (unreleased)

- **Location is on by default** (the server runs for its owner). `get_location` is listed unless `TESLA_FLEET_ENABLE_LOCATION` is `0`/`false`/`no`/`off`; an unrecognised value turns location off with a warning. Coarse (~1 km) stays the default; new `TESLA_FLEET_DEFAULT_LOCATION_PRECISION` (`coarse`/`precise`). An invalid `precision` argument is refused before any network call (no token refresh or vehicle lookup).
- `get_location` reports `missing_location_scope` with the fix when the token lacks `vehicle_location`.
- Auth helper: `vehicle_location` is now in the default scopes; `url --no-location` / `TESLA_AUTH_LOCATION=0` drops it. Turning location off on the server does not remove the scope from an existing token.
- Energy commands: success is `{}` (seen live), `{response: {}}`, an empty (0-byte or whitespace-only) body, `{code: 201}` or another plain result object. Results include a debug-safe `rawShape` (shape only, no values). An `error` key, `result: false` (reason surfaced) or code 400+ is `rejected` (`sent: true`); a null, string or other non-object body is `state_unknown`. No retries.
- `wake_vehicle` dry-run masks the VIN; `describe_boundary` text updated for location on by default. Docs: energy commands are unsigned and need no command proxy (verified live).
- `TESLA_FLEET_PROXY_CA_FILE` is accepted as an alias for `TESLA_COMMAND_PROXY_CA_CERT` (used only when the primary name is unset).
- Tool counts: 16 read-only, 42 with commands on (one fewer each with location off).

## 0.3.0 (unreleased)

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

## 0.2.2 (unreleased)

- CI also runs on Node 22.19.0 (the exact `engines` minimum) next to latest 22 and 24, on ubuntu and windows.
- Bootstrap scripts warn (without failing) when Node is older than 22.19.
- `not_configured` and `proxy_not_configured` messages mention the `TESLA_FLEET_*` aliases.
- README: why `@types/node` stays at latest.

## 0.2.1 (unreleased)

Dependency updates.

- undici 8, TypeScript 7, @types/node 26.
- Node.js 22.19 or newer is now required (`engines` `>=22.19`; undici 8 needs it).
- README: dependency policy (latest versions, majors when CI passes, pins only with a stated reason, bump `engines` with dependencies).

## 0.2.0 (unreleased)

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

## 0.1.2 (unreleased)

Fixes from the first read-only live test.

- VIN resolution reuses the vehicle list for 5 minutes instead of listing vehicles again on every read (saves one billable call per tool call when no default VIN is set). `list_vehicles` still fetches a fresh list.
- `TESLA_FLEET_CLIENT_ID`, `TESLA_FLEET_CLIENT_SECRET` and `TESLA_FLEET_PROXY_URL` are accepted as aliases (server and auth helper); the primary `TESLA_*` name wins. Both MCP configs pass the aliases through.
- `api_status` returns Tesla's plain-text status body (`ok`) instead of a `non_json_response` error object. Plain-text success bodies are kept as text; error bodies keep the structured shape.
- `get_closures` reports `windowsOpen` as unknown when the data source has no window fields (cached data often omits them) instead of an empty object.
- Docs: PowerShell env loaders should run under PowerShell 7 (`pwsh`).

## 0.1.1 (unreleased)

Review fixes.

- Node.js 22 or newer is now required (`engines` `>=22`); Node 20 is end of life.
- CI runs on Node 22 and 24 (ubuntu + windows), with workflow concurrency (cancel in progress) and a 15-minute job timeout.
- Broader token redaction: error output and startup stderr also redact the stored, spent and rotated refresh tokens and the in-memory access token, not only the `TESLA_REFRESH_TOKEN` seed.
- Bootstrap scripts and CI install with `npm ci --ignore-scripts`.
- Dependabot: weekly updates for GitHub Actions and npm.

## 0.1.0 (unreleased)

- First scaffold: one `vehicle-fleet` stdio MCP server, five skills, three manifests (Grok Build, Grok Bot/root, Cursor) and two MCP configs.
- Read tools (cached-first, never wake), opt-in coarse location, confirm-gated command tools hidden unless `TESLA_FLEET_READ_ONLY` is explicitly off (fails closed).
- TokenManager with single-flight refresh and atomic, locked, persisted refresh-token rotation; access tokens memory-only.
- Command proxy with configured CA (TLS never disabled); key-pairing and online pre-checks; no automatic retries.
- Local rate buckets under the documented per-vehicle limits; Fleet API error mapping.
- Optional operator-run `scripts/auth-helper.mjs`.
- Local Fleet API usage counter and `get_api_usage` read tool: counts every Fleet API / proxy response by pricing category (data, command, wake; `other` kept apart and not priced; `auth` info only), billable (<500) vs not billed (>=500), UTC month buckets persisted to `usage.json` next to the token store (totals only), estimated cost before/after the monthly discount. Rates overridable via `TESLA_FLEET_RATE_*` and `TESLA_FLEET_MONTHLY_DISCOUNT_USD`. Local estimate only; the developer portal billing page is the source of truth.
- Tool counts: 11 read-only, 22 with commands on (+ `get_location` when enabled).
- Tests: unit (mocked HTTP) + MCP stdio smoke against a local fake server; CI on ubuntu + windows.
