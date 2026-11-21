"""Cabin climate (command entity; only when commands are enabled)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACMode,
)
from homeassistant.const import ATTR_TEMPERATURE, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import VehicleFleetConfigEntry
from .const import DOMAIN
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
    async_add_entities(VehicleFleetClimate(v) for v in entry.runtime_data.vehicles)


class VehicleFleetClimate(VehicleFleetCommandEntity, ClimateEntity):
    """Cabin climate on/off and driver/passenger temperature."""

    _attr_hvac_modes = [HVACMode.OFF, HVACMode.HEAT_COOL]
    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_min_temp = 15.0
    _attr_max_temp = 28.0
    _attr_target_temperature_step = 0.5
    _attr_supported_features = (
        ClimateEntityFeature.TARGET_TEMPERATURE
        | ClimateEntityFeature.TURN_ON
        | ClimateEntityFeature.TURN_OFF
    )

    def __init__(self, vehicle) -> None:
        """Initialize (same key as core: driver_temp)."""
        super().__init__(vehicle, "driver_temp")

    @property
    def hvac_mode(self) -> HVACMode | None:
        """On or off."""
        value = self.get("climate_state_is_climate_on")
        if value is None:
            return None
        return HVACMode.HEAT_COOL if value else HVACMode.OFF

    @property
    def current_temperature(self) -> float | None:
        """Inside temperature."""
        return self.get("climate_state_inside_temp")

    @property
    def target_temperature(self) -> float | None:
        """Driver setting."""
        return self.get("climate_state_driver_temp_setting")

    async def async_turn_on(self) -> None:
        """Start climate (user action only)."""
        await self.send("auto_conditioning_start")
        self.coordinator.set_value("climate_state_is_climate_on", True)

    async def async_turn_off(self) -> None:
        """Stop climate (user action only)."""
        await self.send("auto_conditioning_stop")
        self.coordinator.set_value("climate_state_is_climate_on", False)

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        """Set on/off."""
        if hvac_mode == HVACMode.OFF:
            await self.async_turn_off()
        else:
            await self.async_turn_on()

    async def async_set_temperature(self, **kwargs: Any) -> None:
        """Set both seats' target temperature."""
        temp = kwargs.get(ATTR_TEMPERATURE)
        if temp is None:
            raise ServiceValidationError(
                translation_domain=DOMAIN, translation_key="missing_temperature"
            )
        await self.send("set_temps", {"driver_temp": temp, "passenger_temp": temp})
        self.coordinator.set_value("climate_state_driver_temp_setting", temp)
        if (mode := kwargs.get("hvac_mode")) is not None:
            await self.async_set_hvac_mode(mode)
