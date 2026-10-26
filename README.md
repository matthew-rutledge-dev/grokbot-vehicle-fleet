# Grok Bot Vehicle Fleet

A community MCP plugin (one stdio server, `vehicle-fleet`, plus skills) for Grok Build, Grok Bot and Cursor. It reads vehicle status and, only when you turn commands on, sends confirm-gated commands through the official Fleet API, using **your own** developer app, OAuth tokens and command proxy. This community plugin, published by the owner of this repository, works with Tesla vehicles through the official Fleet API. It is not made, approved, sponsored or endorsed by Tesla, and it is not affiliated with Tesla in any way.

It is **read-only by default**, reads **cached data first**, and **never wakes the vehicle** unless you explicitly ask for `wake_vehicle`.

> Not for emergency or safety-critical use. No automatic or scheduled control of the vehicle.

## What this plugin is

| Piece | Role |
|---|---|
| `vehicle-fleet` MCP (one server) | Read tools: battery/charge, climate, doors/locks/trunks/windows, tires (TPMS), connectivity state, key pairing status, multi-section snapshot, optional coarse location. Command tools (hidden unless read-only is explicitly off; each needs `confirm=true`): wake, lock/unlock, trunk/frunk, climate start/stop, set temps, charge start/stop, charge limit, send a destination. |
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
4. Only for commands: your own `tesla-http-proxy` (from Tesla's `vehicle-command` project), and your virtual key paired with the vehicle via `https://www.tesla.com/_ak/<your-domain>`.

Use the smallest scopes: read-only `openid offline_access vehicle_device_data`; add `vehicle_location` only for location, `vehicle_cmds` / `vehicle_charging_cmds` only for commands.

## Plugin variables

| Name | Required | Purpose |
|---|---|---|
| `TESLA_CLIENT_ID` | **yes** | Your app's client ID. Alias: `TESLA_FLEET_CLIENT_ID` (used only when `TESLA_CLIENT_ID` is unset) |
| `TESLA_REFRESH_TOKEN` | first run (unless auth-helper used) | Seed refresh token; after the first refresh the rotated token in the store is used. **Never commit.** |
| `TESLA_CLIENT_SECRET` | auth-helper only | Not passed to the MCP server. Alias: `TESLA_FLEET_CLIENT_SECRET`. **Never commit.** |
| `TESLA_FLEET_REGION` | no | `na` / `eu` / `cn`; default auto-detect via `/api/1/users/region` |
| `TESLA_FLEET_BASE_URL` | no | https override for the Fleet API base URL |
| `TESLA_COMMAND_PROXY_URL` | for commands | Your proxy, e.g. `https://proxy.example.com:4443`. Alias: `TESLA_FLEET_PROXY_URL` |
| `TESLA_COMMAND_PROXY_CA_CERT` | for a private CA / self-signed proxy cert | Path to the PEM to trust for the proxy only. TLS verification is never disabled. |
| `TESLA_TOKEN_STORE` | no | Token store path (default below) |
| `TESLA_FLEET_READ_ONLY` | no | **Fails closed** - see below |
| `TESLA_FLEET_ENABLE_LOCATION` | no | `1`/`true`/`yes`/`on` lists `get_location` |
| `TESLA_DEFAULT_VIN` | no | Default VIN for reads (e.g. `5YJ000000EXAMPLE`) |
| `TESLA_FLEET_KEY_DOMAIN` | no | Your key domain, used only to show the pairing link |
| `TESLA_FLEET_RATE_DATA_PER_USD` | no | Usage estimate only: data calls per USD (default `500`) |
| `TESLA_FLEET_RATE_COMMANDS_PER_USD` | no | Usage estimate only: commands per USD (default `1000`) |
| `TESLA_FLEET_RATE_WAKES_PER_USD` | no | Usage estimate only: wakes per USD (default `50`) |
| `TESLA_FLEET_MONTHLY_DISCOUNT_USD` | no | Usage estimate only: monthly discount in USD (default `10`; `0` allowed) |

**Aliases.** If your secrets manager or env loader already exports `TESLA_FLEET_CLIENT_ID`, `TESLA_FLEET_CLIENT_SECRET` or `TESLA_FLEET_PROXY_URL`, the server and the auth helper accept them (they are also declared as optional plugin variables). When both names are set, the primary `TESLA_*` name wins.

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

## Tools

Read (no confirm; never wake the vehicle): `describe_boundary`, `get_api_usage`, `api_status`, `list_vehicles`, `get_vehicle_state`, `get_fleet_status`, `get_battery_charge`, `get_climate`, `get_closures`, `get_tires`, `get_vehicle_snapshot`, and `get_location` (only with `TESLA_FLEET_ENABLE_LOCATION`; coarse ~1 km unless `precision=precise`).

Tool counts: **11** in the default read-only mode, **22** with `TESLA_FLEET_READ_ONLY` off (11 read + 11 commands), plus `get_location` when location is enabled.

Section reads default to `vehicle_data_cached` (works while asleep, may be hours old; age is reported). `live=true` makes one live `vehicle_data` call **only if the vehicle is already online**. `get_vehicle_snapshot` batches sections into one call.

Commands (hidden unless read-only is explicitly off): `wake_vehicle`, `door_lock`, `door_unlock`, `actuate_trunk`, `climate_start`, `climate_stop`, `set_temps`, `charge_start`, `charge_stop`, `set_charge_limit`, `share_navigation`.

Every command:
- returns a **dry-run** unless called with `confirm=true` **and** `user_request` (a short quote of the human's request in the current conversation);
- is refused if the vehicle is not already online (no auto-wake), if the virtual key is not paired (checked first via `fleet_status`, so you are not billed for a rejected command), or if no proxy is configured;
- is sent through your proxy (`/api/1/vehicles/{VIN}/command/...`) with your bearer token;
- is never retried automatically; on a timeout the result says the state is unknown and which read to use.

`door_unlock` and `actuate_trunk` require an explicit `vin`. Local rate limits stay under the documented per-vehicle limits (data 60/min, commands 30/min, wakes 3/min).

**Commands must never be sent from routines, schedules, triggers, webhooks or an agent's own initiative.** The `user_request` field and the skills enforce this as policy; the server cannot see who scheduled a run, so operators who allow unattended agents should keep the server read-only.

Out of scope for v0.1 (TODO in `BACKLOG.md`): energy products (Powerwall/solar), Fleet Telemetry streaming, remote start, valet/PIN/speed limit, guest mode, sharing, HomeLink, windows, horn/lights, media, software updates.

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

## Network endpoints

| Endpoint | When |
|---|---|
| `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token` | token refresh (and auth-helper code exchange) |
| `https://auth.tesla.com/oauth2/v3/authorize` | opened by you in a browser via auth-helper |
| `https://fleet-api.prd.na.vn.cloud.tesla.com`, `https://fleet-api.prd.eu.vn.cloud.tesla.com`, `https://fleet-api.prd.cn.vn.cloud.tesla.cn` | Fleet API reads, wake, fleet_status, region lookup |
| your `TESLA_COMMAND_PROXY_URL` | signed commands |

No other endpoints, no telemetry, no analytics.

## Privacy

- The plugin stores **no vehicle data**. Reads are cached in memory for up to 60 s and discarded when the server exits. The only files it writes are the token store and the usage counter (`usage.json`, totals only).
- Location is off unless you opt in, coarse by default, never written to disk. The vehicle shows a location-sharing indicator when location is read.
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

CI runs the same on ubuntu-latest and windows-latest (Node 22 and 24), with no secrets. Requires Node 22 or newer.

## Security

No tokens in git. If your token store, client secret or private key leaks: revoke the app's access on your account, rotate the client secret, re-pair keys, and notify Tesla as the Fleet API Agreement requires.

## Acknowledgements

Design ideas (no code copied) came from two MIT-licensed projects: [pjordan/tesla-fleet-mcp](https://github.com/pjordan/tesla-fleet-mcp) and [tylergibbs1/tesla-mcp-server](https://github.com/tylergibbs1/tesla-mcp-server). Signed commands rely on Tesla's [vehicle-command](https://github.com/teslamotors/vehicle-command) `tesla-http-proxy` (Apache-2.0), which you run yourself; it is not bundled. See `THIRD_PARTY_NOTICES.md`.

## License

MIT - see [LICENSE](LICENSE).
