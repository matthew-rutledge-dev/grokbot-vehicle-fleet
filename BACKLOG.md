# Backlog - grokbot-vehicle-fleet

No secrets in this file.

## TODO

- Pin the seat heater body field names and seat numbering against the current proxy (0.3.0 sends both documented key sets).
- Steering wheel heat level (`set_steering_wheel_heat_level`): skipped in 0.7.0. Tesla's docs list `remote_steering_wheel_heat_level_request` with `level` 0 = off, 1 = low, 3 = high (no 2). The stock `tesla-http-proxy` has no handler (`invalid_command`); Tesla's published protos have no action for it, only the `StwHeatLevel` state enum (0 unknown, 1 off, 2 low, 3 high), which numbers levels differently (the same off-by-one risk as `set_cop_temp`). Add only if the stock proxy or Tesla's published protos gain it; then pin the level mapping per path and never send it from climate defaults or warm-up.
- Pin energy `live_status` / `site_info` / `calendar_history` field names against a redacted real response; add fixtures.
- Pin `vehicle_data_cached` and TPMS field names/units against a redacted real response; add it as a fixture.
- Confirm the pricing category of `GET /api/1/vehicles/{vin}` and `fleet_status` and adjust the dry-run cost estimate and the `other` bucket of `get_api_usage`.
- Verify the `navigation_request` body shape against the current proxy.
- Field-test (0.7.0): `set_off_grid_vehicle_charging_reserve` (body, the `noop` pre-read, and whether `site_info` returns `off_grid_vehicle_charging_reserve_percent`).
- Field-test (0.6.x: 0.6.0 commands; 0.6.1 and 0.6.2 add no new commands): `share_navigation` with `lat`/`lon` (sent as `lat,lon` text via `navigation_request`), `trigger_homelink`, `window_control`, the media commands, `set_cop_temp` level mapping on a signed-command car, `set_climate_keeper_mode`, `set_auto_seat_climate`, valet on/off/reset, `remote_boombox`. Pin the `telemetry_history?kind=charge` session fields against a redacted real response.
- Navigation to a Supercharger by id (`navigation_sc_request`) and multi-stop routes (`navigation_waypoints_request`): skipped in 0.6.1. Tesla's docs list both but publish no parameters; the stock `tesla-http-proxy` answers `invalid_command` (no handler, same as `navigation_gps_request`; only `navigation_request` is forwarded); Tesla's published protos have no action for either. The only signed encodings are reverse-engineered third-party extensions (Supercharger id + trip-order enum; waypoints as one text field of place references, format unverified). Add only if the stock proxy or Tesla's published protos gain them, or Tesla documents the request body; then validate ids/place references strictly and cap the stop count.
- Auto steering wheel heat (`remote_auto_steering_wheel_heat_climate_request`): add only if the stock proxy or Tesla's published protos gain it.
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
- **Entity compatibility / migration goal:** existing dashboards, history and statistics must keep working. Entity names, translation keys, keys (flattened Fleet field names) and native units mirror HA core's integration so a fresh install produces the same entity_ids. HA cannot share a unique_id across integrations, so ship a documented migration step: back up the registry and dashboards, rename the old integration's (disabled) vehicle entity_ids out of the way (e.g. `_legacy` suffix) via the entity registry, install, verify every id resolves; rollback = reverse the renames. Fallback: a generic dashboard rewrite script that takes an old-id -> new-id mapping file (dry-run diff first).
- **Data sources and poll budget:** default coordinator polls `vehicle_data_cached` (never wakes the car) at a configurable interval (default 15 min, about $6/month at 500 data calls per $1); `drive_state` / location values are live-only and refresh on demand (a user-pressed refresh button, car must be online), never on a timer by default. Location: follow the plugin (on by default with an opt-out) or a separate toggle; decide when building. Show data age and an estimated monthly API usage sensor.
- **Energy-site support is a prerequisite** for energy-site entities (battery %, solar, load, grid power, grid status) and any automations built on them: needs the energy read tools above (`energy_device_data`, `live_status`), off by default, interval of 5 min or more. Document that a local gateway integration, where available, gives the same values with no API cost and is the preferred source.
- **HomeLink button (user-initiated only):** `trigger_homelink` is a signed command (via the configured proxy) and requires `lat` and `lon`; the car only acts near its programmed HomeLink device. Expose a button that runs only on a user press: car must be online (optional, off-by-default wake on press), one live location read for lat/lon (or the configured home-zone coordinates), optional `homelink_nearby` pre-check, then the command. The integration ships no automations, blueprints or geofence auto-open (Fleet API Agreement §5.6.22, no automatic or autonomous control); docs caution users against wiring command entities into their own automations. Voice or dashboard taps with a confirmation are the intended paths.
- **Command entities:** confirmations on dashboard tiles; remote start (keyless driving) omitted by default (separate opt-in if ever added).
- **Example dashboard:** ship `docs/examples/dashboard.yaml` built only from placeholder entity names, for example:

  ```yaml
  type: sections
  title: Vehicle
  sections:
    - type: grid
      cards:
        - type: tile
          entity: sensor.example_car_battery_level
        - type: tile
          entity: sensor.example_car_data_age
        - type: tile
          entity: lock.example_car_lock
        - type: tile
          entity: button.example_car_homelink
          tap_action:
            action: perform-action
            perform_action: button.press
            target:
              entity_id: button.example_car_homelink
            confirmation:
              text: Open/close the garage door via the car?
  ```
- **Release gate:** packaging review by the Home Assistant packaging owner before the first release.
