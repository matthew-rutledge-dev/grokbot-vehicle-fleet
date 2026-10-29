# Fleet Telemetry fields for ownership events

> **Reference only. Do not push this to a car without the owner's explicit yes.** Pushing a
> `fleet_telemetry_config` is a signed vehicle configuration change. This plugin never pushes one, and
> nothing in this repository calls the endpoint.

This plugin answers on-demand reads. Change detection (software updates, odometer milestones, vehicle
alerts, service, tires, battery, charging faults, safety and Sentry events; immediate or in a weekly
digest) lives in a separate, self-hosted event bridge that receives Fleet Telemetry (the reference
bridge is [`grok-bot-universal-bridge`](https://github.com/matthew-rutledge-dev/grok-bot-universal-bridge)'s Tesla adapter, whose `telemetry.fields` config is the source of truth for the pushed config). This page lists
the telemetry fields that bridge needs, with suggested intervals, and an example request body.

Field names are from `teslamotors/fleet-telemetry` `protos/vehicle_data.proto` and the Fleet API
[Available Data](https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data) page.
**Bold** rows are new for ownership events; the rest are the existing event-trigger fields.

| Field | Interval (s) | Used for | Same value in vehicle_data (plugin reads) |
|---|---|---|---|
| DetailedChargeState | 60 | existing (charge triggers); charging_fault (`NoPower`, or `Stopped` while charging is requested below the limit) | (no documented equivalent; `charge_state.charging_state` is close) |
| ChargingCableType | 60 | existing (plug triggers) |  |
| DoorState | 10 | existing (door / trunk triggers) |  |
| SentryMode | 10 | existing; sentry_or_security (digest count) | `vehicle_state.sentry_mode` |
| Gear | 10 | existing (parked check) |  |
| Soc / BatteryLevel | 300 | existing (low battery); monthly HV reading | `charge_state.battery_level` |
| SoftwareUpdateVersion | 3600 | existing; software_update (available) | `vehicle_state.software_update.version` |
| **Version** | 3600 | software_update (installed; release-notes pull on change) | `vehicle_state.car_version` |
| **SoftwareUpdateInstallationPercentComplete** | 60 | software_update (installing; a reset to 0 with no new version is reported as a likely failed install) | `vehicle_state.software_update.install_perc` |
| **Odometer** | 600 | odometer_milestone (miles) | `vehicle_state.odometer` |
| **ServiceMode** | 60 | service_mode | `vehicle_state.service_mode` |
| **TpmsPressureFl / Fr / Rl / Rr** | 600 | tpms (bar; low / high / more than 5 psi below recommended) | `vehicle_state.tpms_pressure_*` |
| **TpmsSoftWarnings / TpmsHardWarnings** | 60 | tpms (per-tire warning struct) | `vehicle_state.tpms_soft_warning_*` / `tpms_hard_warning_*` |
| **ChargeEnableRequest** | 60 | charging_fault (was charging requested) | `charge_state.charge_enable_request` |
| **ChargeLimitSoc** | 600 | charging_fault (below the limit) | `charge_state.charge_limit_soc` |
| **RatedRange / EnergyRemaining** | 600 | 12v_or_hv_battery (monthly HV reading) | `charge_state.battery_range` |
| **BMSState / Hvil** | 60 | 12v_or_hv_battery (BMS fault, HV interlock fault) |  |
| **AutomaticEmergencyBrakingOff** | 3600 | collision_or_safety (AEB setting changed; a setting, not an activation) |  |
| **CarType / Trim** | 86400 | model / trim label |  |
| **Location** | 300 (min delta 1000 m) | city-level location (0.1°) on safety and service events only; needs `vehicle_location`. Leave out to send no location | `drive_state.latitude / longitude` |

## Not exposed by Tesla

There is no telemetry field for an airbag deployment, a collision, an automatic emergency braking
activation, a 12V battery voltage or warning, a charging error code, or a failed software update.
These can only come from **vehicle alerts** (`alert_types` below), matched by alert name, and the names
are not documented. `SoftwareUpdateAvailable` and `SoftwareUpdateInProgress` appear in recent protos
but not in Tesla's documentation; they are left out.

## Alerts

Alerts stream separately from fields. The vehicle config needs `alert_types`; Tesla's endpoint page
does not list the values. Community examples use `["service"]`, and some add `"customer"` and
`"service-fix"` (matching the `Audience` enum in `protos/vehicle_alert.proto`). Confirm on the first
push. The fleet-telemetry server also needs `alerts` in its `records` routing (for example
`"alerts": ["mqtt"]`).

## Example request body

`POST /api/1/vehicles/fleet_telemetry_config`, sent through your own signing proxy (for example
`https://proxy.example.com`). Placeholders only: replace the VINs, hostname, CA and expiry. `exp` is a
Unix time in seconds. Resend interval 21600 s matches the bridge's default.

```json
{
  "vins": [
    "5YJ3EXAMPLE000001",
    "7SAYEXAMPLE000002"
  ],
  "config": {
    "hostname": "telemetry.example.com",
    "port": 443,
    "ca": "-----BEGIN CERTIFICATE-----\n<your fleet-telemetry server CA chain>\n-----END CERTIFICATE-----\n",
    "exp": 1798761600,
    "prefer_typed": true,
    "alert_types": [
      "service"
    ],
    "fields": {
      "DetailedChargeState": {
        "interval_seconds": 60,
        "resend_interval_seconds": 21600
      },
      "ChargingCableType": {
        "interval_seconds": 60,
        "resend_interval_seconds": 21600
      },
      "DoorState": {
        "interval_seconds": 10,
        "resend_interval_seconds": 21600
      },
      "SentryMode": {
        "interval_seconds": 10,
        "resend_interval_seconds": 21600
      },
      "Gear": {
        "interval_seconds": 10,
        "resend_interval_seconds": 21600
      },
      "Soc": {
        "interval_seconds": 300,
        "resend_interval_seconds": 21600
      },
      "BatteryLevel": {
        "interval_seconds": 300,
        "resend_interval_seconds": 21600
      },
      "SoftwareUpdateVersion": {
        "interval_seconds": 3600,
        "resend_interval_seconds": 21600
      },
      "Version": {
        "interval_seconds": 3600,
        "resend_interval_seconds": 21600
      },
      "SoftwareUpdateInstallationPercentComplete": {
        "interval_seconds": 60,
        "resend_interval_seconds": 21600
      },
      "Odometer": {
        "interval_seconds": 600,
        "resend_interval_seconds": 21600
      },
      "ServiceMode": {
        "interval_seconds": 60,
        "resend_interval_seconds": 21600
      },
      "TpmsPressureFl": {
        "interval_seconds": 600,
        "resend_interval_seconds": 21600
      },
      "TpmsPressureFr": {
        "interval_seconds": 600,
        "resend_interval_seconds": 21600
      },
      "TpmsPressureRl": {
        "interval_seconds": 600,
        "resend_interval_seconds": 21600
      },
      "TpmsPressureRr": {
        "interval_seconds": 600,
        "resend_interval_seconds": 21600
      },
      "TpmsSoftWarnings": {
        "interval_seconds": 60,
        "resend_interval_seconds": 21600
      },
      "TpmsHardWarnings": {
        "interval_seconds": 60,
        "resend_interval_seconds": 21600
      },
      "ChargeEnableRequest": {
        "interval_seconds": 60,
        "resend_interval_seconds": 21600
      },
      "ChargeLimitSoc": {
        "interval_seconds": 600,
        "resend_interval_seconds": 21600
      },
      "RatedRange": {
        "interval_seconds": 600,
        "resend_interval_seconds": 21600
      },
      "EnergyRemaining": {
        "interval_seconds": 600,
        "resend_interval_seconds": 21600
      },
      "BMSState": {
        "interval_seconds": 60,
        "resend_interval_seconds": 21600
      },
      "Hvil": {
        "interval_seconds": 60,
        "resend_interval_seconds": 21600
      },
      "AutomaticEmergencyBrakingOff": {
        "interval_seconds": 3600,
        "resend_interval_seconds": 21600
      },
      "CarType": {
        "interval_seconds": 86400,
        "resend_interval_seconds": 21600
      },
      "Trim": {
        "interval_seconds": 86400,
        "resend_interval_seconds": 21600
      },
      "Location": {
        "interval_seconds": 300,
        "resend_interval_seconds": 21600,
        "minimum_delta": 1000
      }
    }
  }
}
```

Read the result back with `GET /api/1/vehicles/<VIN>/fleet_telemetry_config` (`synced: true` once the
car applies it). To stop streaming, `DELETE` the config (also a car change that needs the owner's yes)
or let `exp` lapse.

## Cost

Telemetry is billed by signals streamed. Intervals above are a starting point: most ownership fields
change rarely, and the car only sends a field when it changes (plus the resend interval).
