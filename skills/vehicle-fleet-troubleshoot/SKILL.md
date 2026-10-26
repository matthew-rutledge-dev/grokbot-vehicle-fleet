---
name: vehicle-fleet-troubleshoot
description: use this when a vehicle-fleet tool returns an error code (login_required, vehicle_not_online, virtual_key_missing, wrong_region, rate_limited, proxy_not_configured, forbidden, partner_not_registered) or the server does not start
---

# Vehicle fleet troubleshooting

Start with `describe_boundary` (no network): read-only state, variables set/missing, token store status, config problems.

Read [reference.md](reference.md) for the full error table. Short version:

| code | meaning | do |
|---|---|---|
| `login_required` / `no_refresh_token` | token expired, used, revoked, or missing | operator re-runs `scripts/auth-helper.mjs` (skill vehicle-fleet-setup), reload |
| `vehicle_not_online` / `vehicle_unavailable` | asleep/offline/poor signal | cached read, later, or user-confirmed `wake_vehicle`; never loop |
| `virtual_key_missing` | key not paired | pairing link in `hint` |
| `proxy_not_configured` / `command_protocol_required` | no signing proxy | operator sets `TESLA_COMMAND_PROXY_URL` |
| `rate_limited` / `rate_limited_locally` | too many calls | wait `retryAfterSec` |
| `state_unknown` | command timed out | read back state; do not resend |
| `payment_required` (402) / app disabled | billing limit reached or no payment method | `get_api_usage` for a local estimate; operator checks the developer portal billing page and limit |

Cost worries or unexpected bills: `get_api_usage` counts only this server's calls. A much higher portal total means another client (for example Home Assistant) is using the same app.
