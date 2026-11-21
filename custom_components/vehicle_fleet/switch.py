"""Switches (command entities; only when commands are enabled)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.switch import (
    SwitchDeviceClass,
    SwitchEntity,
    SwitchEntityDescription,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import VehicleFleetConfigEntry
from .entity import VehicleFleetCommandEntity

PARALLEL_UPDATES = 1


@dataclass(frozen=True, kw_only=True)
class VehicleFleetSwitchDescription(SwitchEntityDescription):
    """Switch description: command names and bodies for on/off."""

    on_command: tuple[str, dict[str, Any]]
    off_command: tuple[str, dict[str, Any]]
    is_on: Callable[[Any], bool] = bool
    on_value: Any = True
    off_value: Any = False


DESCRIPTIONS: tuple[VehicleFleetSwitchDescription, ...] = (
    VehicleFleetSwitchDescription(
        key="vehicle_state_sentry_mode",
        device_class=SwitchDeviceClass.SWITCH,
        on_command=("set_sentry_mode", {"on": True}),
        off_command=("set_sentry_mode", {"on": False}),
    ),
    VehicleFleetSwitchDescription(
        key="charge_state_charging_state",
        device_class=SwitchDeviceClass.SWITCH,
        on_command=("charge_start", {}),
        off_command=("charge_stop", {}),
        is_on=lambda v: v in ("Starting", "Charging"),
        on_value="Starting",
        off_value="Stopped",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: VehicleFleetConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Fail closed: no entity unless commands are enabled."""
    if not entry.runtime_data.commands_enabled:
        return
    async_add_entities(
        VehicleFleetSwitch(v, d) for v in entry.runtime_data.vehicles for d in DESCRIPTIONS
    )


class VehicleFleetSwitch(VehicleFleetCommandEntity, SwitchEntity):
    """Command switch."""

    entity_description: VehicleFleetSwitchDescription

    def __init__(self, vehicle, description: VehicleFleetSwitchDescription) -> None:
        """Initialize."""
        super().__init__(vehicle, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool | None:
        """Last known state."""
        value = self._value
        return None if value is None else self.entity_description.is_on(value)

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn on (user action only)."""
        await self.send(*self.entity_description.on_command)
        self.coordinator.set_value(self.key, self.entity_description.on_value)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn off (user action only)."""
        await self.send(*self.entity_description.off_command)
        self.coordinator.set_value(self.key, self.entity_description.off_value)
