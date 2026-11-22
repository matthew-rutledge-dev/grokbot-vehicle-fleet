# Moving from HA core `tesla_fleet` to `vehicle_fleet`

Goal: existing dashboards, history and statistics keep working. `vehicle_fleet` uses the same keys, translation keys and native units as HA core's `tesla_fleet`, so with the same device name it produces the same entity ids for the entities both have. Home Assistant cannot share a `unique_id` across integrations, so the old entities have to be moved out of the way first.

Placeholders below: device `example_car`, VIN `5YJ000000EXAMPLE`.

## Before you start

1. **Back up** Home Assistant (Settings → System → Backups), or at least `config/.storage/core.entity_registry`, `core.device_registry` and your dashboards (`lovelace*`).
2. List the old integration's vehicle entity ids (Settings → Entities, filter by the integration) and save the list.

## Steps

1. **Stop the old poller.** Only one integration should poll a vehicle (rate limits are per vehicle across all apps). In the old integration, disable the vehicle's device or the config entry's polling.
2. **Rename the old entity ids out of the way.** For each old vehicle entity, change its entity id with a `_legacy` suffix (Settings → Entities → entity → settings), for example `sensor.example_car_battery_level` → `sensor.example_car_battery_level_legacy`. History stays with the renamed entity. If Home Assistant offers to update references in dashboards or automations, decline: the new entity takes over the old id.
3. **Install and set up `vehicle_fleet`** (see [HOME-ASSISTANT.md](HOME-ASSISTANT.md)). Keep the same device name as before, so the new entity ids match the old ones.
4. **Verify** every id on your saved list resolves again (Developer tools → States). Ids the new integration does not have (energy sites, covers, numbers, seat heaters and others outside v1) stay with `_legacy` or go away.
5. Long-term statistics: the new sensor gets the same entity id, so the recorder continues the same statistic when the unit and state class match (they mirror core). If Home Assistant flags a statistics issue, fix it in Developer tools → Statistics.

## Rollback

Remove the `vehicle_fleet` entry, then reverse the renames (drop the `_legacy` suffix) and re-enable the old integration's polling. Or restore the backup.

## Fallback: rewrite dashboards

If an id cannot be kept, rewrite dashboard references with a mapping file (`old_id: new_id` per line). Always do a dry run first and review the diff, for example:

```bash
# dry run: show what would change
python3 - <<'PY'
import pathlib, re
mapping = dict(l.split(":", 1) for l in pathlib.Path("id-map.txt").read_text().split("\n") if ":" in l)
for f in pathlib.Path("config/.storage").glob("lovelace*"):
    text = f.read_text()
    new = text
    for old, repl in mapping.items():
        new = re.sub(rf"\b{re.escape(old.strip())}\b", repl.strip(), new)
    if new != text:
        print(f"would change {f}")
PY
```

Write changes only with Home Assistant stopped and a backup taken.

## Entity ids added in 0.8.3

These match HA core `tesla_fleet` keys, translation keys and native units, so with the same device name the new ids match the old ones (placeholder device `example_car`):

| Old / new entity id | Key (`unique_id` = `{vin}-{key}`) |
|---|---|
| `sensor.example_car_charge_energy_added` | `charge_state_charge_energy_added` |
| `sensor.example_car_charge_rate` | `charge_state_charge_rate` |
| `sensor.example_car_time_to_full_charge` | `charge_state_minutes_to_full_charge` (timestamp: now + remaining minutes) |
| `sensor.example_car_speed` | `drive_state_speed` (null is 0) |
| `sensor.example_car_distance_to_arrival` | `drive_state_active_route_miles_to_arrival` |
| `sensor.example_car_time_to_arrival` | `drive_state_active_route_minutes_to_arrival` (timestamp) |
| `binary_sensor.example_car_dashcam` | `vehicle_state_dashcam_state` (on when `Recording`) |
| `binary_sensor.example_car_user_present` | `vehicle_state_is_user_present` |
| `update.example_car_update` | `vehicle_state_software_update_status` (read-only; no install) |

Ids the new integration still does not have (covers, numbers, seat heaters, keyless driving, boombox, cabin overheat, defrost and others) stay with `_legacy` or can be rewritten; frunk, trunk, windows and charge-limit already exist here as binary sensors / a charge-limit sensor.
