# Grok Bot Vehicle Fleet

A community MCP plugin (one stdio server, `vehicle-fleet`, plus skills) for Grok Build, Grok Bot and Cursor. It reads vehicle status and, only when you turn commands on, sends confirm-gated commands through the official Fleet API, using **your own** developer app, OAuth tokens and command proxy. This community plugin, published by the owner of this repository, works with Tesla vehicles through the official Fleet API. It is not made, approved, sponsored or endorsed by Tesla, and it is not affiliated with Tesla in any way.

It is **read-only by default**, reads **cached data first**, and **never wakes the vehicle** unless you explicitly ask for `wake_vehicle`.

> Not for emergency or safety-critical use. No automatic or scheduled control of the vehicle.

## What this plugin is

| Piece | Role |
|---|---|
| `vehicle-fleet` MCP (one server) | Read tools: battery/charge, climate, doors/locks/trunks/windows, tires (TPMS), connectivity state, key pairing status, multi-section snapshot, location (on by default, coarse; opt out). Command tools (hidden unless read-only is explicitly off; each needs `confirm=true`): wake, lock/unlock, trunk/frunk, climate start/stop, set temps, charge start/stop, charge limit, send a destination. |
| Skills | `vehicle-fleet-boundary` (rules), `vehicle-fleet-status`, `vehicle-fleet-commands`, `vehicle-fleet-setup` (operator-driven), `vehicle-fleet-troubleshoot` |
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
| `TESLA_FLEET_DEFAULT_LOCATION_PRECISION` | no | `coarse` (default) or `precise`: `get_location` precision when the call does not pass one |
| `TESLA_DEFAULT_VIN` | no | Default VIN for reads (e.g. `5YJ000000EXAMPLE`) |
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

Read (no confirm; never wake the vehicle): `describe_boundary`, `get_api_usage`, `api_status`, `list_vehicles`, `get_vehicle_state`, `get_fleet_status`, `get_battery_charge`, `get_climate`, `get_closures`, `get_tires`, `get_vehicle_snapshot`, and `get_location` (on by default; coarse unless `precision=precise`).

Energy-site reads (no confirm; need the `energy_device_data` scope): `list_energy_sites`, `get_energy_live_status` (solar / battery / home / grid power, battery %, grid and island status, storm watch, plus Wall Connector state and power from the site's `wall_connectors` list), `get_energy_site_info` (backup reserve, operation mode, storm watch, export rule, battery count, nameplate) and `get_energy_history` (`kind=energy` totals or `kind=backup` events for a bounded date range: `period=day` up to 31 days, `week` up to 92, `month`/`year` up to 366). If you already have a local gateway integration, it gives the same live values with no API cost; prefer it for polling.

Tool counts: **16** in the default read-only mode (12 vehicle reads including `get_location` + 4 energy reads), **42** with `TESLA_FLEET_READ_ONLY` off (+ 22 vehicle commands + 4 energy commands); one fewer each with location turned off.

Section reads default to `vehicle_data_cached` (works while asleep, may be hours old; age is reported). `live=true` makes one live `vehicle_data` call **only if the vehicle is already online**. `get_vehicle_snapshot` batches sections into one call.

### Commands

Vehicle commands (hidden unless read-only is explicitly off; signed by your proxy):

| Area | Tools |
|---|---|
| Wake | `wake_vehicle` |
| Climate | `climate_warm_up` (preset), `climate_start`, `climate_stop`, `set_temps`, `set_seat_heater`, `set_steering_wheel_heater`, `set_defrost_max`, `set_cabin_overheat_protection` |
| Security | `door_lock`, `door_unlock`, `actuate_trunk`, `set_sentry_mode`, `flash_lights`, `honk_horn` |
| Charging | `charge_start`, `charge_stop`, `set_charge_limit` (50-100), `set_charging_amps` (1-48; the car caps it), `charge_port_door_open`, `charge_port_door_close` |
| Navigation | `share_navigation` |

Energy-site commands (same gates; sent unsigned, directly to the Fleet API, scope `energy_cmds`; no command proxy needed, verified live): `set_backup_reserve` (0-100 %), `set_operation_mode` (`self_consumption` or `autonomous`), `set_storm_mode` (on/off), `set_grid_import_export` (`customer_preferred_export_rule` `pv_only`/`battery_ok`/`never` and/or `disallow_charge_from_grid_with_solar_installed`). A successful call returns an empty `result` (`{}`); an empty (0-byte or whitespace-only) body, `{response: {}}`, `{code: 201, message: "Updated"}` (shown in some docs) and other plain result objects are also success. Every result carries `rawShape` (`empty`, `object`, `response-wrapped`, `null`, `string`, `array` or `other`; shape only, never values) so you can see what Tesla returned. An `error` key, `result: false` (the `reason` is surfaced) or a code of 400+ is reported as `rejected` (`sent: true`); a non-object body is `state_unknown`. Neither is retried. Read the new value back with `get_energy_site_info`.

**`climate_warm_up`** makes "turn on the heat" work with no arguments: climate on, then both setpoints to `TESLA_FLEET_DEFAULT_CLIMATE_TEMP_C`. If the car's cached outside temperature is below the cold threshold it also turns on the default seat heater(s) and (optionally) the steering wheel heater, and below the defrost threshold it turns on max defrost. Override per call with `temp`/`unit`, `seat_heat` (`auto`, `off`, 0-3), `seats` and `defrost` (`auto`, `true`, `false`). Steps run in order and stop at the first failure, reporting `completedSteps`, `failedStep` and `sent: "partial"` when some steps already ran (`failedStepSent` says whether the failed step itself was sent, not sent or unknown). The default 21 °C shows as 70 °F on a car set to Fahrenheit.

### Command safety model

Every command, vehicle or energy:
- is **absent from `tools/list` and refused** unless `TESLA_FLEET_READ_ONLY` is explicitly off (fails closed);
- returns a **dry-run preview** (endpoint and body, zero network calls) unless called with `confirm=true` **and** `user_request` (a short quote of the human's request in the current conversation);
- validates every parameter **before any network call**;
- with `TESLA_FLEET_DRY_RUN=1`, goes through all of the above and returns the exact request (`wouldSend`, VIN masked to the last 4, navigation destination not echoed) without sending anything; use this for a first run;
- is never retried automatically. If the request may have reached the car or site (timeout, 408, any 5xx, or a connection reset after the request started) the result is `state_unknown` with `sent: "unknown"` and the read to use; failures before connecting (refused, DNS, TLS) are `sent: false`.

Vehicle commands additionally:
- go **only** through your proxy (`/api/1/vehicles/{VIN}/command/...`, HTTPS with optional CA pin; never directly to the Fleet API) with your bearer token;
- are refused if no proxy is configured, if the vehicle is not already online (no auto-wake), or if the virtual key is not paired (checked first via `fleet_status`, so you are not billed for a rejected command).

Errors are explicit: `vehicle_not_online`, `virtual_key_missing` (with the pairing link), `proxy_not_configured`, `proxy_unreachable` / `proxy_tls_error` (not sent; energy commands: `fleet_api_unreachable` / `fleet_api_tls_error`), `missing_scope` / `missing_energy_cmds_scope` (names the scope and the auth-helper flag to add), `state_unknown`, `invalid_arguments`. A no-op reason (e.g. `already_set` on `set_charge_limit`, with or without the proxy's `car could not execute command:` prefix) is `ok` with `noChange` only on the command that can return it; any other reason is a rejection (`rawReason` keeps the original text).

Command scopes are **opt-in** in the auth helper: `url --commands` (or `TESLA_AUTH_COMMANDS=1`) adds `vehicle_cmds` and `vehicle_charging_cmds`; `url --energy-commands` (or `TESLA_AUTH_ENERGY_COMMANDS=1`) adds `energy_cmds` (and `energy_device_data`). The default stays read-only.

`door_unlock` and `actuate_trunk` require an explicit `vin`. Local rate limits stay under the documented per-vehicle limits (data 60/min, commands 30/min, wakes 3/min).

**Commands must never be sent from routines, schedules, triggers, webhooks or an agent's own initiative.** The `user_request` field and the skills enforce this as policy; the server cannot see who scheduled a run, so operators who allow unattended agents should keep the server read-only.

Out of scope (TODO in `BACKLOG.md`): Fleet Telemetry streaming, remote start, valet/PIN/speed limit, guest mode, sharing, HomeLink, windows, media, software updates, off-grid vehicle charging reserve.

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
| `https://fleet-api.prd.na.vn.cloud.tesla.com`, `https://fleet-api.prd.eu.vn.cloud.tesla.com`, `https://fleet-api.prd.cn.vn.cloud.tesla.cn` | Fleet API reads, wake, fleet_status, region lookup |
| your `TESLA_COMMAND_PROXY_URL` | signed commands |

No other endpoints, no telemetry, no analytics.

## Privacy

- The plugin stores **no vehicle data**. Reads are cached in memory for up to 60 s and discarded when the server exits. The only files it writes are the token store, the usage counter (`usage.json`, totals only) and, only if you opt in, the access-token export file.
- Location is on by default (opt out with `TESLA_FLEET_ENABLE_LOCATION=0`), coarse unless precise is asked for, never written to disk. The vehicle shows a location-sharing indicator when location is read.
- Errors and tool output never include tokens or secrets; VINs appear as last 4 characters except where you passed them.
- Revoke access any time: remove the key on the vehicle's Locks screen, or change third-party app access on your Tesla account. Delete the token store file to forget the refresh token.
- You are the developer of record for your own app: follow the Fleet API Agreement, including its privacy, consent and data-deletion terms.

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
