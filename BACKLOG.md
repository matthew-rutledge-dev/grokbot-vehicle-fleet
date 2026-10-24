# Backlog - grokbot-vehicle-fleet

No secrets in this file.

## TODO

- **Energy products (out of scope for v0.1):** Powerwall/solar read tools (`live_status`, `site_info`) and confirm-gated settings (backup reserve, operation mode, storm mode). Needs scopes `energy_device_data` / `energy_cmds`, same read-only + confirm gating.
- Pin `vehicle_data_cached` and TPMS field names/units against a redacted real response; add it as a fixture.
- Confirm the pricing category of `GET /api/1/vehicles/{vin}` and `fleet_status` and adjust the dry-run cost estimate.
- Verify the `navigation_request` body shape against the current proxy.
- Fleet Telemetry (separate project; needs a public server).
- Marketplace submission (xAI plugin marketplace remote entry; Cursor) after the repo is public and a fresh-clone walk passes.
