"""Location tracker (on by default; turn it off in the options)."""

from __future__ import annotations

from homeassistant.components.device_tracker.config_entry import TrackerEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import VehicleFleetConfigEntry
from .entity import VehicleFleetEntity

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: VehicleFleetConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the tracker only when location is on."""
    if not entry.runtime_data.location:
        return
    async_add_entities(
        VehicleFleetLocation(vehicle) for vehicle in entry.runtime_data.vehicles
    )


class VehicleFleetLocation(VehicleFleetEntity, TrackerEntity):
    """Last known location (read only while the car is online)."""

    def __init__(self, vehicle) -> None:
        """Initialize."""
        super().__init__(vehicle, "location")

    @property
    def latitude(self) -> float | None:
        """Latitude."""
        return self.get("drive_state_latitude")

    @property
    def longitude(self) -> float | None:
        """Longitude."""
        return self.get("drive_state_longitude")
