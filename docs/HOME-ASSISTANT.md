# Home Assistant integration: `vehicle_fleet` (0.8.0, first version)

A Home Assistant custom integration in `custom_components/vehicle_fleet/`. Display name: **Vehicle Fleet**. Works with Tesla vehicles through the official Fleet API, using your own developer application. It is a separate Python package and shares no runtime code with the Node MCP server in `mcp/vehicle-fleet/`; the two share only the version number.

Status: first version, not yet released or field-tested. Read-only by default.

## Install

- **HACS (custom repository):** add this repository as a custom repository of type *Integration*, install **Vehicle Fleet**, restart Home Assistant.
- **Manual:** copy `custom_components/vehicle_fleet/` into your Home Assistant `config/custom_components/`, restart.

`hacs.json` declares Home Assistant 2025.6 as the minimum; the tests run on the current Home Assistant release only, so older versions are untested.

## Before you start

You need the same things as the MCP plugin (see the main README, "Before you start"):

1. Your own Fleet API application at developer.tesla.com, already registered for your region (partner registration and the public key on your domain are **not** done by this integration).
2. The application's allowed redirect URIs must include `https://my.home-assistant.io/redirect/oauth`.
3. For commands only: a running `tesla-http-proxy` with your virtual key paired to the car. This integration never signs commands itself.

**Only one poller per vehicle.** Fleet API rate limits are per vehicle across all apps on the account. Before switching, disable polling for the car in any other integration (for example HA core's `tesla_fleet`); see [HA-MIGRATION.md](HA-MIGRATION.md).

## Set up

1. Settings → Devices & services → Add integration → **Vehicle Fleet**.
2. Enter your application's client ID and client secret (stored by Home Assistant's *Application credentials*).
3. Sign in and approve the scopes. Home Assistant stores the refresh token and refreshes the access token itself.
4. Pick the region, or **Auto-detect** (asks `/api/1/users/region` on the North America then Europe endpoint, the same as the MCP server; a reply is used only if it is a Fleet API host).

## How polling works (no wake, no billed reads while asleep)

Each poll, per vehicle:

1. `GET /api/1/vehicles/{vin}`: the vehicle summary with its connectivity state. This never wakes the car.
2. Only if the state is `online`: one `vehicle_data` read (charge, climate, drive, vehicle state and config, plus `location_data` when location is on).
3. If the car is `asleep` or `offline`: no `vehicle_data` call. All sensors keep their last values (also saved across Home Assistant restarts), and `sensor.<car>_data_age` shows when they were read.

The integration **never wakes the car on its own** and never polls to keep it awake. The only wake is the **Wake** button, and only when commands are enabled and you press it.

- Interval: **15 minutes** by default, **5 minutes** minimum, set in the integration options.
- A `429` keeps the last values and waits for the `Retry-After` time (at least 1 minute).

### Cost estimate (estimate, not a fact)

Tesla bills Fleet API usage by category; check developer.tesla.com for current prices and any monthly credit. Using the "about 500 data calls per $1" figure from this repo's backlog:

- 15-minute interval = 96 polls a day, about 2,900 a month.
- `vehicle_data` is made only while the car is already online. Worst case (car online all month): about 2,900 data reads, roughly **$6 a month**. A car that sleeps most of the day costs a fraction of that.
- The pricing category of the state read (`GET /api/1/vehicles/{vin}`) is not confirmed (open item in `BACKLOG.md`). If it is billed as a data call, add up to another ~2,900 calls (~$6) a month at 15 minutes.
- Commands (user actions only) and the Wake button are billed in their own categories.

`sensor.<car>_data_age` carries a `vehicle_data_reads_since_start` attribute so you can see how many billed reads this Home Assistant run made.

Note: some older cars (pre-2021 Model S/X) may not fall asleep while their data is read regularly. If yours stays online, use a longer interval.

## Options

| Option | Default | Notes |
|---|---|---|
| Poll interval (minutes) | 15 | Minimum 5. |
| Read location | on | Adds `device_tracker.<car>_location`. Turn off to drop `location_data` from reads and remove the tracker. The car shows a location-sharing indicator when location is read. |
| Enable commands | **off** | Read-only until you turn this on. While off, no lock, climate, switch or button entities exist, and the API client refuses commands (fails closed). If the stored proxy URL is missing or no longer valid at startup, the integration stays read-only and logs a warning. |
| Command proxy URL | empty | Base URL of your `tesla-http-proxy`, for example `https://proxy.example.com`. https only; plain http only on localhost. Required to enable commands. |
| Command proxy CA certificate path | empty | Optional CA file for a proxy with a private certificate. |

## Entities

Device name = the car's display name (the full VIN is not shown on the device page); entity ids follow it (for example `sensor.example_car_battery_level`). Keys (`unique_id` = `{vin}-{key}`), translation keys and native units mirror HA core's `tesla_fleet`, so a fresh install produces the same entity ids where both have the entity.

**Always (read-only):**

- Sensors: battery level, battery range, charging (state), charge limit, charger power, inside and outside temperature, odometer, four tire pressures, vehicle state (online/asleep/offline), data age.
- Binary sensors: status (connectivity), charge cable, Sentry mode, four doors, frunk, trunk, four windows.
- Device tracker: location (unless turned off).

**Only with commands enabled** (each checks the car is already online first and refuses otherwise; nothing wakes the car):

- Lock: doors (`door_lock` / `door_unlock`).
- Climate: on/off (`auto_conditioning_start` / `_stop`) and temperature (`set_temps`, both seats).
- Switches: Sentry mode (`set_sentry_mode`), charging (`charge_start` / `charge_stop`).
- Buttons: Wake (`wake_up`, the only wake), Flash lights, Honk horn, Homelink.

Signed commands go only to your configured proxy, with your access token; Wake goes to the Fleet API. After an accepted command, the entity updates its own state (no extra billed read).

**HomeLink:** on press, checks the car is online, makes one live read (`vehicle_state` and, if location is on, `location_data`), refuses if the car reports no HomeLink device nearby, then sends `trigger_homelink` with the car's coordinates (or your Home Assistant home location when location is off). The car only acts near its programmed device.

## No automations

This integration ships **no automations, blueprints or geofence actions**, and never acts on its own (Fleet API Agreement: no automatic or autonomous control). Do not wire the command entities into your own automations. Use them from a dashboard tile with a confirmation, or by voice. See [examples/dashboard.yaml](examples/dashboard.yaml). Remote start (keyless driving) is not included.

## Not in this version

- Energy sites (Powerwall, solar): planned; see `BACKLOG.md`.
- Navigation (share a destination), charge limit and charge current setters, seat heaters, windows, trunk/frunk actuation, boombox.
- `vehicle_data_cached` as a data source.
- Diagnostics download, repair issues, and a release to the HA Marketplace.
