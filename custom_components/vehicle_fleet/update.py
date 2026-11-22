"""Read-only software update entity. Keys mirror HA core's tesla_fleet.

No install action: this integration never starts a vehicle software update.
"""

from __future__ import annotations


from homeassistant.components.update import UpdateEntity, UpdateEntityFeature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import VehicleFleetConfigEntry
from .entity import VehicleFleetEntity

PARALLEL_UPDATES = 0

AVAILABLE = "available"
DOWNLOADING = "downloading"
INSTALLING = "installing"
WIFI_WAIT = "downloading_wifi_wait"
SCHEDULED = "scheduled"
PENDING = (AVAILABLE, INSTALLING, DOWNLOADING, WIFI_WAIT, SCHEDULED)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: VehicleFleetConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the software update entity."""
    async_add_entities(
        VehicleFleetUpdateEntity(vehicle) for vehicle in entry.runtime_data.vehicles
    )


class VehicleFleetUpdateEntity(VehicleFleetEntity, UpdateEntity):
    """Installed and latest versions from vehicle_data. Read-only (no install)."""

    # Progress is informational only; INSTALL is intentionally omitted.
    _attr_supported_features = UpdateEntityFeature.PROGRESS

    def __init__(self, vehicle) -> None:
        """Initialize."""
        super().__init__(vehicle, "vehicle_state_software_update_status")

    @property
    def installed_version(self) -> str | None:
        """Car firmware, without the build suffix."""
        raw = self.get("vehicle_state_car_version")
        if not isinstance(raw, str) or not raw.strip():
            return None
        return raw.split(" ")[0]

    @property
    def latest_version(self) -> str | None:
        """Pending update version, or the installed version when none is pending."""
        if self._value in PENDING:
            version = self.get("vehicle_state_software_update_version")
            return version if isinstance(version, str) and version else None
        return self.installed_version

    @property
    def in_progress(self) -> bool:
        """True only while the car reports an install in progress."""
        return self._value == INSTALLING

    @property
    def update_percentage(self) -> int | float | None:
        """Install percent while an update is installing."""
        if self._value != INSTALLING:
            return None
        percent = self.get("vehicle_state_software_update_install_perc")
        return percent if isinstance(percent, int | float) else None
