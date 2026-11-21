"""Door lock (command entity; only when commands are enabled)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.lock import LockEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import VehicleFleetConfigEntry
from .entity import VehicleFleetCommandEntity

PARALLEL_UPDATES = 1


async def async_setup_entry(
    hass: HomeAssistant,
    entry: VehicleFleetConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Fail closed: no entity unless commands are enabled."""
    if not entry.runtime_data.commands_enabled:
        return
    async_add_entities(VehicleFleetLock(v) for v in entry.runtime_data.vehicles)


class VehicleFleetLock(VehicleFleetCommandEntity, LockEntity):
    """Vehicle doors."""

    def __init__(self, vehicle) -> None:
        """Initialize."""
        super().__init__(vehicle, "vehicle_state_locked")

    @property
    def is_locked(self) -> bool | None:
        """Last known lock state."""
        value = self._value
        return None if value is None else bool(value)

    async def async_lock(self, **kwargs: Any) -> None:
        """Lock (user action only)."""
        await self.send("door_lock")
        self.coordinator.set_value(self.key, True)

    async def async_unlock(self, **kwargs: Any) -> None:
        """Unlock (user action only)."""
        await self.send("door_unlock")
        self.coordinator.set_value(self.key, False)
