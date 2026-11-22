"""Binary sensors. Keys mirror HA core's tesla_fleet."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import VehicleFleetConfigEntry
from .const import STATE_ONLINE
from .entity import VehicleFleetEntity

PARALLEL_UPDATES = 0


@dataclass(frozen=True, kw_only=True)
class VehicleFleetBinaryDescription(BinarySensorEntityDescription):
    """Binary sensor description."""

    is_on: Callable[[Any], bool] = bool


def _open(key: str, device_class: BinarySensorDeviceClass) -> VehicleFleetBinaryDescription:
    # Fleet reports doors/trunks/windows as 0 (closed) or non-zero (open).
    return VehicleFleetBinaryDescription(
        key=key, device_class=device_class, is_on=lambda v: bool(v)
    )


DESCRIPTIONS: tuple[VehicleFleetBinaryDescription, ...] = (
    VehicleFleetBinaryDescription(
        key="state",
        device_class=BinarySensorDeviceClass.CONNECTIVITY,
        entity_category=EntityCategory.DIAGNOSTIC,
        is_on=lambda v: v == STATE_ONLINE,
    ),
    VehicleFleetBinaryDescription(
        key="charge_state_conn_charge_cable",
        device_class=BinarySensorDeviceClass.CONNECTIVITY,
        entity_category=EntityCategory.DIAGNOSTIC,
        is_on=lambda v: v != "<invalid>",
    ),
    VehicleFleetBinaryDescription(
        key="vehicle_state_sentry_mode",
        device_class=BinarySensorDeviceClass.RUNNING,
    ),
    _open("vehicle_state_df", BinarySensorDeviceClass.DOOR),
    _open("vehicle_state_dr", BinarySensorDeviceClass.DOOR),
    _open("vehicle_state_pf", BinarySensorDeviceClass.DOOR),
    _open("vehicle_state_pr", BinarySensorDeviceClass.DOOR),
    _open("vehicle_state_ft", BinarySensorDeviceClass.OPENING),
    _open("vehicle_state_rt", BinarySensorDeviceClass.OPENING),
    _open("vehicle_state_fd_window", BinarySensorDeviceClass.WINDOW),
    _open("vehicle_state_fp_window", BinarySensorDeviceClass.WINDOW),
    _open("vehicle_state_rd_window", BinarySensorDeviceClass.WINDOW),
    _open("vehicle_state_rp_window", BinarySensorDeviceClass.WINDOW),
    VehicleFleetBinaryDescription(
        key="vehicle_state_dashcam_state",
        device_class=BinarySensorDeviceClass.RUNNING,
        entity_category=EntityCategory.DIAGNOSTIC,
        is_on=lambda v: v == "Recording",
    ),
    VehicleFleetBinaryDescription(
        key="vehicle_state_is_user_present",
        device_class=BinarySensorDeviceClass.PRESENCE,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: VehicleFleetConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up binary sensors."""
    async_add_entities(
        VehicleFleetBinarySensor(vehicle, d)
        for vehicle in entry.runtime_data.vehicles
        for d in DESCRIPTIONS
    )


class VehicleFleetBinarySensor(VehicleFleetEntity, BinarySensorEntity):
    """Binary sensor."""

    entity_description: VehicleFleetBinaryDescription

    def __init__(self, vehicle, description: VehicleFleetBinaryDescription) -> None:
        """Initialize."""
        super().__init__(vehicle, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool | None:
        """Return the (last known) state."""
        value = self._value
        return None if value is None else self.entity_description.is_on(value)
