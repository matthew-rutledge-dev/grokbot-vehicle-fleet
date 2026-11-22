"""Vehicle coordinator: state check first, vehicle_data only while online.

Cost rule: no billed data call while the car is asleep or offline, and nothing
here ever wakes the car or keeps it awake.

Each poll:
1. ``GET /api/1/vehicles/{vin}`` (vehicle summary, never wakes the car) for the
   connectivity state.
2. Only if the state is ``online``: one ``vehicle_data`` read.
3. Otherwise keep the last values (also persisted across restarts) and only
   update the state.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import (
    FleetAuthError,
    FleetClient,
    FleetError,
    FleetRateLimited,
    FleetVehicleOffline,
)
from .const import (
    DOMAIN,
    ENDPOINTS,
    LOCATION_ENDPOINT,
    LOGGER,
    STATE_ASLEEP,
    STATE_ONLINE,
    STORAGE_VERSION,
)

KEY_STATE = "state"
KEY_DATA_UPDATED = "data_updated"


def flatten(data: dict[str, Any], parent: str | None = None) -> dict[str, Any]:
    """Flatten nested Fleet API fields into ``section_field`` keys (as HA core does)."""
    result: dict[str, Any] = {}
    for key, value in data.items():
        full = f"{parent}_{key}" if parent else key
        if isinstance(value, dict):
            result.update(flatten(value, full))
        else:
            result[full] = value
    return result


class VehicleFleetCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Polls one vehicle."""

    config_entry: ConfigEntry

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        client: FleetClient,
        vin: str,
        product: dict[str, Any],
        *,
        interval: timedelta,
        location: bool,
    ) -> None:
        """Initialize from the vehicle list entry (no extra call)."""
        super().__init__(
            hass,
            LOGGER,
            config_entry=entry,
            name=f"{DOMAIN} vehicle",
            update_interval=interval,
        )
        self.client = client
        self.vin = vin
        self.location = location
        self.base_interval = interval
        self.endpoints = [*ENDPOINTS, *([LOCATION_ENDPOINT] if location else [])]
        self.vehicle_data_calls = 0
        self._store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}.{vin[-6:]}"
        )
        self.data = {KEY_STATE: product.get("state")}

    async def async_restore(self) -> None:
        """Load the last values saved before a restart (no API call)."""
        stored = await self._store.async_load()
        if isinstance(stored, dict):
            values = dict(stored)
            if not self.location:
                values = {k: v for k, v in values.items() if not _is_location_key(k)}
            self.data = {**values, KEY_STATE: self.data.get(KEY_STATE)}

    async def _async_update_data(self) -> dict[str, Any]:
        self.update_interval = self.base_interval
        data = dict(self.data or {})
        try:
            summary = await self.client.vehicle(self.vin)
            state = summary.get("state")
            data[KEY_STATE] = state
            if state != STATE_ONLINE:
                return data
            fresh = await self.client.vehicle_data(self.vin, self.endpoints)
            self.vehicle_data_calls += 1
        except FleetVehicleOffline:
            data[KEY_STATE] = STATE_ASLEEP
            return data
        except FleetRateLimited as err:
            if err.retry_after:
                self.update_interval = timedelta(seconds=max(err.retry_after, 60))
            LOGGER.warning("Fleet API rate limited; keeping last values")
            return data
        except FleetAuthError as err:
            raise ConfigEntryAuthFailed("token rejected") from err
        except FleetError as err:
            raise UpdateFailed(str(err)) from err

        values = flatten(fresh)
        if not self.location:
            values = {k: v for k, v in values.items() if not _is_location_key(k)}
        values[KEY_STATE] = values.get(KEY_STATE) or STATE_ONLINE
        values[KEY_DATA_UPDATED] = dt_util.utcnow().isoformat()
        await self._store.async_save(values)
        return values

    @property
    def data_updated(self) -> datetime | None:
        """When vehicle_data last succeeded."""
        raw = (self.data or {}).get(KEY_DATA_UPDATED)
        return dt_util.parse_datetime(raw) if isinstance(raw, str) else None

    def set_value(self, key: str, value: Any) -> None:
        """Optimistic update after an accepted command (no extra billed read)."""
        self.async_set_updated_data({**(self.data or {}), key: value})


# Arrival distance/time are useful without exposing coordinates, and they come
# from drive_state (already fetched) rather than location_data.
_ARRIVAL_KEYS = {
    "drive_state_active_route_miles_to_arrival",
    "drive_state_active_route_minutes_to_arrival",
}


def _is_location_key(key: str) -> bool:
    if key in {
        "drive_state_latitude",
        "drive_state_longitude",
        "drive_state_heading",
        "drive_state_native_latitude",
        "drive_state_native_longitude",
        "drive_state_corrected_latitude",
        "drive_state_corrected_longitude",
    }:
        return True
    return key.startswith("drive_state_active_route_") and key not in _ARRIVAL_KEYS
