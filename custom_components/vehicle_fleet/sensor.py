"""Sensors. Keys, translation keys and native units mirror HA core's tesla_fleet."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import (
    PERCENTAGE,
    EntityCategory,
    UnitOfLength,
    UnitOfPower,
    UnitOfPressure,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.typing import StateType

from . import VehicleFleetConfigEntry
from .const import VEHICLE_STATES
from .entity import VehicleFleetEntity

PARALLEL_UPDATES = 0

CHARGE_STATES = {
    "Starting": "starting",
    "Charging": "charging",
    "Stopped": "stopped",
    "Complete": "complete",
    "Disconnected": "disconnected",
    "NoPower": "no_power",
}


@dataclass(frozen=True, kw_only=True)
class VehicleFleetSensorDescription(SensorEntityDescription):
    """Sensor description with a value transform."""

    value_fn: Callable[[Any], StateType] = lambda x: x


def _tire(pos: str) -> VehicleFleetSensorDescription:
    return VehicleFleetSensorDescription(
        key=f"vehicle_state_tpms_pressure_{pos}",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfPressure.BAR,
        suggested_unit_of_measurement=UnitOfPressure.PSI,
        device_class=SensorDeviceClass.PRESSURE,
        suggested_display_precision=1,
        entity_category=EntityCategory.DIAGNOSTIC,
    )


DESCRIPTIONS: tuple[VehicleFleetSensorDescription, ...] = (
    VehicleFleetSensorDescription(
        key="charge_state_charging_state",
        options=list(CHARGE_STATES.values()),
        device_class=SensorDeviceClass.ENUM,
        value_fn=lambda v: CHARGE_STATES.get(v) if isinstance(v, str) else None,
    ),
    VehicleFleetSensorDescription(
        key="charge_state_battery_level",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=PERCENTAGE,
        device_class=SensorDeviceClass.BATTERY,
    ),
    VehicleFleetSensorDescription(
        key="charge_state_battery_range",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfLength.MILES,
        device_class=SensorDeviceClass.DISTANCE,
        suggested_display_precision=1,
    ),
    VehicleFleetSensorDescription(
        key="charge_state_charge_limit_soc",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=PERCENTAGE,
        device_class=SensorDeviceClass.BATTERY,
    ),
    VehicleFleetSensorDescription(
        key="charge_state_charger_power",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfPower.KILO_WATT,
        device_class=SensorDeviceClass.POWER,
    ),
    VehicleFleetSensorDescription(
        key="climate_state_inside_temp",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        device_class=SensorDeviceClass.TEMPERATURE,
        suggested_display_precision=1,
    ),
    VehicleFleetSensorDescription(
        key="climate_state_outside_temp",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        device_class=SensorDeviceClass.TEMPERATURE,
        suggested_display_precision=1,
    ),
    VehicleFleetSensorDescription(
        key="vehicle_state_odometer",
        state_class=SensorStateClass.TOTAL_INCREASING,
        native_unit_of_measurement=UnitOfLength.MILES,
        device_class=SensorDeviceClass.DISTANCE,
        suggested_display_precision=0,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    _tire("fl"),
    _tire("fr"),
    _tire("rl"),
    _tire("rr"),
    VehicleFleetSensorDescription(
        key="state",
        options=list(VEHICLE_STATES),
        device_class=SensorDeviceClass.ENUM,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda v: v if v in VEHICLE_STATES else None,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: VehicleFleetConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up sensors."""
    entities: list[SensorEntity] = []
    for vehicle in entry.runtime_data.vehicles:
        entities.extend(VehicleFleetSensor(vehicle, d) for d in DESCRIPTIONS)
        entities.append(VehicleFleetDataAgeSensor(vehicle))
    async_add_entities(entities)


class VehicleFleetSensor(VehicleFleetEntity, SensorEntity):
    """A value sensor. Keeps its last value while the car sleeps."""

    entity_description: VehicleFleetSensorDescription

    def __init__(self, vehicle, description: VehicleFleetSensorDescription) -> None:
        """Initialize."""
        super().__init__(vehicle, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> StateType:
        """Return the (last known) value."""
        value = self._value
        return None if value is None else self.entity_description.value_fn(value)


class VehicleFleetDataAgeSensor(VehicleFleetEntity, SensorEntity):
    """When vehicle data was last read (the car was online at that time)."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, vehicle) -> None:
        """Initialize."""
        super().__init__(vehicle, "data_age")

    @property
    def native_value(self) -> datetime | None:
        """Return the last vehicle_data time."""
        return self.coordinator.data_updated

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Billed vehicle_data reads made since HA started (this entry)."""
        return {"vehicle_data_reads_since_start": self.coordinator.vehicle_data_calls}
