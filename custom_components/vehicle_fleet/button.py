"""Buttons (command entities; only when commands are enabled; user press only).

Wake is the only way this integration ever wakes the car.
"""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import VehicleFleetConfigEntry
from .api import FleetError
from .const import DOMAIN, LOCATION_ENDPOINT
from .entity import VehicleFleetCommandEntity

PARALLEL_UPDATES = 1


async def async_setup_entry(
    hass: HomeAssistant,
    entry: VehicleFleetConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Fail closed: no entity unless commands are enabled."""
    data = entry.runtime_data
    if not data.commands_enabled:
        return
    entities: list[ButtonEntity] = []
    for v in data.vehicles:
        entities.append(WakeButton(v))
        entities.append(SimpleCommandButton(v, "flash_lights", "flash_lights"))
        entities.append(SimpleCommandButton(v, "honk", "honk_horn"))
        entities.append(HomeLinkButton(v, location=data.location))
    async_add_entities(entities)


class SimpleCommandButton(VehicleFleetCommandEntity, ButtonEntity):
    """One signed command per press."""

    def __init__(self, vehicle, key: str, command: str) -> None:
        """Initialize."""
        super().__init__(vehicle, key)
        self._command = command

    async def async_press(self) -> None:
        """Send on press (car must already be online)."""
        await self.send(self._command)


class WakeButton(VehicleFleetCommandEntity, ButtonEntity):
    """Wake the car (billed as a wake). The integration never wakes it on its own."""

    def __init__(self, vehicle) -> None:
        """Initialize."""
        super().__init__(vehicle, "wake")

    async def async_press(self) -> None:
        """POST wake_up once; the next poll picks up the new state."""
        try:
            await self.coordinator.client.wake_up(self.vehicle.vin)
        except FleetError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="command_failed",
                translation_placeholders={"command": "wake_up", "error": str(err)},
            ) from err


class HomeLinkButton(VehicleFleetCommandEntity, ButtonEntity):
    """Trigger HomeLink near its programmed device (user press only)."""

    def __init__(self, vehicle, *, location: bool) -> None:
        """Initialize."""
        super().__init__(vehicle, "homelink")
        self._location = location

    async def async_press(self) -> None:
        """Online check, one live read for lat/lon and homelink_nearby, then send."""
        await self._ensure_online()
        endpoints = ["vehicle_state", *([LOCATION_ENDPOINT] if self._location else [])]
        try:
            live = await self.coordinator.client.vehicle_data(self.vehicle.vin, endpoints)
        except FleetError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="command_failed",
                translation_placeholders={"command": "trigger_homelink", "error": str(err)},
            ) from err
        vs = live.get("vehicle_state") or {}
        if vs.get("homelink_nearby") is False:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="homelink_not_nearby"
            )
        ds = live.get("drive_state") or {}
        lat, lon = ds.get("latitude"), ds.get("longitude")
        if lat is None or lon is None:
            # Location off (or not returned): use the configured home zone.
            lat, lon = self.hass.config.latitude, self.hass.config.longitude
        if lat is None or lon is None:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="homelink_no_location"
            )
        await self.send("trigger_homelink", {"lat": lat, "lon": lon})
