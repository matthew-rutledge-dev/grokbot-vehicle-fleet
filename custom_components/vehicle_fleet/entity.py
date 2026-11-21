"""Base entities."""

from __future__ import annotations

from typing import Any

from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import VehicleRuntime
from .api import CommandsDisabled, FleetError, FleetVehicleOffline
from .const import DOMAIN, STATE_ONLINE
from .coordinator import VehicleFleetCoordinator


class VehicleFleetEntity(CoordinatorEntity[VehicleFleetCoordinator]):
    """A vehicle entity. unique_id is ``{vin}-{key}``; translation key = key."""

    _attr_has_entity_name = True

    def __init__(self, vehicle: VehicleRuntime, key: str) -> None:
        """Initialize."""
        super().__init__(vehicle.coordinator)
        self.vehicle = vehicle
        self.key = key
        self._attr_translation_key = key
        self._attr_unique_id = f"{vehicle.vin}-{key}"
        self._attr_device_info = vehicle.device

    def get(self, key: str, default: Any = None) -> Any:
        """Read a flattened value."""
        return (self.coordinator.data or {}).get(key, default)

    @property
    def _value(self) -> Any:
        return self.get(self.key)


class VehicleFleetCommandEntity(VehicleFleetEntity):
    """Entity that sends commands. Only created when commands are enabled."""

    async def _ensure_online(self) -> None:
        """Refuse unless the car is already online. Never wakes it."""
        client = self.coordinator.client
        try:
            summary = await client.vehicle(self.vehicle.vin)
        except FleetError as err:
            raise HomeAssistantError(f"Could not read the vehicle state: {err}") from err
        state = summary.get("state")
        if state != STATE_ONLINE:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="vehicle_not_online",
                translation_placeholders={"state": str(state)},
            )

    async def send(self, name: str, body: dict[str, Any] | None = None) -> None:
        """Check online, then send one signed command through the proxy."""
        await self._ensure_online()
        try:
            await self.coordinator.client.command(self.vehicle.vin, name, body)
        except CommandsDisabled as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="commands_disabled"
            ) from err
        except FleetVehicleOffline as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="vehicle_not_online",
                translation_placeholders={"state": "offline"},
            ) from err
        except FleetError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="command_failed",
                translation_placeholders={"command": name, "error": str(err)},
            ) from err
