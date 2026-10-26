# Backlog - grokbot-vehicle-fleet

No secrets in this file.

## TODO

- **Energy products (out of scope for v0.1):** Powerwall/solar read tools (`live_status`, `site_info`) and confirm-gated settings (backup reserve, operation mode, storm mode). Needs scopes `energy_device_data` / `energy_cmds`, same read-only + confirm gating.
- Pin `vehicle_data_cached` and TPMS field names/units against a redacted real response; add it as a fixture.
- Confirm the pricing category of `GET /api/1/vehicles/{vin}` and `fleet_status` and adjust the dry-run cost estimate and the `other` bucket of `get_api_usage`.
- Verify the `navigation_request` body shape against the current proxy.
- Fleet Telemetry (separate project; needs a public server).
- Marketplace submission (xAI plugin marketplace remote entry; Cursor) after the repo is public and a fresh-clone walk passes.

## Planned: Home Assistant integration (same repo, after PR #1 merges)

- **Where:** `custom_components/vehicle_fleet/` plus a root `hacs.json`. Python, separate from the Node MCP server in `mcp/vehicle-fleet/` (no shared runtime code).
- **Distribution:** the Home Assistant Marketplace (built into HA core from 2026.11; uses the same `hacs.json` / catalog as HACS), and HACS on older HA versions. Adding it as a custom repository needs the repo to be public and the user's GitHub connection.
- **Naming:** domain `vehicle_fleet`; neutral display name (e.g. "Grok Bot Vehicle Fleet"); no "Tesla" in the name (Fleet API Agreement §7), only a plain compatibility line (§14.4). Must **not** use domain `tesla_fleet`, which would override HA's core integration.
- **Versions:** shares GitHub release tags/versions with the plugin (one version across manifests, `package.json`, `version.ts` and the integration's `manifest.json`).
- **CI:** add hassfest and the HACS validation action alongside the Node tests.
- **Rate limits are per vehicle across all apps on the account:** only one poller per vehicle. Disable HA core's vehicle polling for the car before switching to this integration.
- **Dashboards:** the Marketplace installs integrations and dashboard cards (auto-registered as resources) but not full dashboards. Ship an example dashboard YAML in the docs; an optional custom card later.
- **Release gate:** packaging review by the Home Assistant packaging owner before the first release.
