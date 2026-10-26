# Error reference

| HTTP / local | code | Billed | Meaning | Action |
|---|---|---|---|---|
| local | `not_configured` | no | `TESLA_CLIENT_ID` (alias `TESLA_FLEET_CLIENT_ID`) missing | set plugin variable; check the env loader ran under `pwsh` 7 |
| local | `no_refresh_token` | no | no seed and empty store | auth-helper or `TESLA_REFRESH_TOKEN` |
| local | `user_request_required` | no | confirm without a quoted human request | ask the user; never from routines |
| local | `vehicle_not_online` | no* | state is asleep/offline | no auto-wake; offer `wake_vehicle` |
| local | `vin_required` / `vin_ambiguous` | no | unlock/trunk need explicit vin; several cars | ask which car |
| local | `rate_limited_locally` | no | local bucket empty | wait `retryAfterSec` |
| local | `missing_energy_scope` | yes (the 403) | energy call refused; token lacks `energy_device_data` | re-run `auth-helper.mjs url --energy` and sign in once |
| local | `bad_history_args` / `bad_site_id` | no | invalid or too-long energy history range, or a non-numeric site id | fix the arguments |
| local | `site_ambiguous` / `no_energy_sites` | no | several sites, or none visible | pass `energy_site_id`; check the energy scope |
| local | `proxy_not_configured` | no | no `TESLA_COMMAND_PROXY_URL` (alias `TESLA_FLEET_PROXY_URL`) | configure proxy |
| 401 | `unauthorized` | yes | access token expired | refreshed once automatically |
| 401 | `login_required` | yes | refresh token expired/used/revoked/password reset | re-consent |
| 401 | `mobile_access_disabled` | yes | remote access off in the car | enable in car |
| 402 | `payment_required` | yes | billing | developer portal |
| 403 | `missing_scope` | yes | token lacks a scope (energy calls report `missing_energy_scope`) | re-consent with the needed scope |
| 403 | `forbidden` | yes | refused for another reason (no access to this vehicle/site) | check account access |
| 403 | `command_protocol_required` | yes | unsigned command | use the proxy |
| 404 | `not_found` | yes | no cached data / unknown vehicle | `live=true` if online |
| 408 | `vehicle_unavailable` | yes | asleep/offline/poor signal | later; do not loop |
| 412 | `partner_not_registered` | yes | region registration missing | partner register |
| 421 | `wrong_region` | yes | wrong base URL | unset region to auto-detect |
| 422 | `virtual_key_missing` | yes | key not paired | pairing link |
| 429 | `rate_limited` | yes | Fleet API limit | wait `retryAfterSec` |
| 451 | `unavailable_legal` | yes | privacy/region restriction | check region |
| 5xx / 540 | `server_error` / `device_error` | no | Tesla or vehicle error | later |

\* the state check itself is one small read.

Server will not start: run `scripts/bootstrap-mcp.sh` (builds `dist/index.js`), check Node 22+, then reload MCP servers.

## Environment notes

- `TESLA_FLEET_CLIENT_ID`, `TESLA_FLEET_CLIENT_SECRET` and `TESLA_FLEET_PROXY_URL` are accepted as aliases for `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET` and `TESLA_COMMAND_PROXY_URL`. The primary name wins when both are set. `describe_boundary` shows set/missing for each.
- A PowerShell env loader should run under PowerShell 7 (`pwsh`); under Windows PowerShell 5.1 some loaders hang, leaving the variables unset.
