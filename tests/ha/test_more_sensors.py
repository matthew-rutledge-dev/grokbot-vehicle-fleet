"""0.8.3 read-only sensors, binary sensors and update entity."""

from __future__ import annotations

from copy import deepcopy
from datetime import timedelta

from homeassistant.components.update import UpdateEntityFeature
from homeassistant.const import (
    STATE_UNAVAILABLE,
    STATE_UNKNOWN,
    UnitOfLength,
    UnitOfSpeed,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from homeassistant.util.unit_conversion import DistanceConverter, SpeedConverter
from freezegun.api import FrozenDateTimeFactory
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from .conftest import VIN, VEHICLE_DATA, calls_to, make_entry, mock_fleet, setup_entry

ENERGY = "sensor.example_car_charge_energy_added"
RATE = "sensor.example_car_charge_rate"
TIME_TO_FULL = "sensor.example_car_time_to_full_charge"
SPEED = "sensor.example_car_speed"
DISTANCE = "sensor.example_car_distance_to_arrival"
TIME_TO_ARRIVAL = "sensor.example_car_time_to_arrival"
DASHCAM = "binary_sensor.example_car_dashcam"
USER_PRESENT = "binary_sensor.example_car_user_present"
UPDATE = "update.example_car_update"


def _data(**overrides: object) -> dict:
    """A vehicle_data payload with the 0.8.3 fields filled in."""
    data = deepcopy(VEHICLE_DATA)
    data["charge_state"].update(
        {
            "charge_energy_added": 12.3,
            "charge_rate": 34.5,
            "minutes_to_full_charge": 90,
        }
    )
    data["drive_state"].update(
        {
            "speed": None,
            "active_route_miles_to_arrival": 12.5,
            "active_route_minutes_to_arrival": 18,
            "active_route_destination": "Example Place",
        }
    )
    data["vehicle_state"].update(
        {
            "dashcam_state": "Recording",
            "is_user_present": True,
            "car_version": "2024.44.25 1h2f3g",
            "software_update": {
                "status": "available",
                "version": "2024.44.30",
                "install_perc": 0,
            },
        }
    )
    for section, values in overrides.items():
        if not isinstance(values, dict):
            raise TypeError(section)
        data.setdefault(section, {}).update(values)
    return data


def _state_in(hass: HomeAssistant, entity_id: str, target_unit: str) -> float:
    """State value converted back to the sensor's native unit."""
    state = hass.states.get(entity_id)
    assert state is not None
    unit = state.attributes["unit_of_measurement"]
    value = float(state.state)
    if target_unit in (
        UnitOfSpeed.MILES_PER_HOUR,
        UnitOfSpeed.KILOMETERS_PER_HOUR,
    ):
        return SpeedConverter.convert(value, unit, target_unit)
    return DistanceConverter.convert(value, unit, target_unit)


def _unique(hass: HomeAssistant, entity_id: str) -> str:
    entry = er.async_get(hass).async_get(entity_id)
    assert entry is not None
    return entry.unique_id


async def test_new_entities_from_vehicle_data(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
) -> None:
    """Values come from the existing vehicle_data payload; one billed read."""
    freezer.move_to("2026-03-01T12:00:00+00:00")
    mock_fleet(aioclient_mock, "online", _data())
    await setup_entry(hass, make_entry())

    assert len(calls_to(aioclient_mock, "/vehicle_data")) == 1
    assert hass.states.get(ENERGY).state == "12.3"
    assert _state_in(hass, RATE, UnitOfSpeed.MILES_PER_HOUR) == 34.5
    assert _state_in(hass, SPEED, UnitOfSpeed.MILES_PER_HOUR) == 0
    assert _state_in(hass, DISTANCE, UnitOfLength.MILES) == 12.5
    assert hass.states.get(DASHCAM).state == "on"
    assert hass.states.get(USER_PRESENT).state == "on"

    now = dt_util.now()
    assert dt_util.parse_datetime(hass.states.get(TIME_TO_FULL).state) == now + timedelta(
        minutes=90
    )
    assert dt_util.parse_datetime(hass.states.get(TIME_TO_ARRIVAL).state) == now + timedelta(
        minutes=18
    )

    update = hass.states.get(UPDATE)
    assert update is not None
    assert update.attributes["installed_version"] == "2024.44.25"
    assert update.attributes["latest_version"] == "2024.44.30"
    assert update.attributes.get("in_progress") in (False, 0, None)

    assert _unique(hass, ENERGY) == f"{VIN}-charge_state_charge_energy_added"
    assert _unique(hass, RATE) == f"{VIN}-charge_state_charge_rate"
    assert _unique(hass, TIME_TO_FULL) == f"{VIN}-charge_state_minutes_to_full_charge"
    assert _unique(hass, SPEED) == f"{VIN}-drive_state_speed"
    assert _unique(hass, DISTANCE) == f"{VIN}-drive_state_active_route_miles_to_arrival"
    assert _unique(hass, TIME_TO_ARRIVAL) == (
        f"{VIN}-drive_state_active_route_minutes_to_arrival"
    )
    assert _unique(hass, DASHCAM) == f"{VIN}-vehicle_state_dashcam_state"
    assert _unique(hass, USER_PRESENT) == f"{VIN}-vehicle_state_is_user_present"
    assert _unique(hass, UPDATE) == f"{VIN}-vehicle_state_software_update_status"


async def test_speed_null_is_zero_and_dashcam_off(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Null speed is 0; a non-recording dashcam is off; parked user absent."""
    mock_fleet(
        aioclient_mock,
        "online",
        _data(
            drive_state={"speed": None},
            vehicle_state={"dashcam_state": "Idle", "is_user_present": False},
        ),
    )
    await setup_entry(hass, make_entry())
    assert _state_in(hass, SPEED, UnitOfSpeed.MILES_PER_HOUR) == 0
    assert hass.states.get(DASHCAM).state == "off"
    assert hass.states.get(USER_PRESENT).state == "off"


async def test_speed_value_when_moving(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """A numeric speed is used as-is (miles per hour, native)."""
    mock_fleet(aioclient_mock, "online", _data(drive_state={"speed": 41}))
    await setup_entry(hass, make_entry())
    assert _state_in(hass, SPEED, UnitOfSpeed.MILES_PER_HOUR) == 41


async def test_no_route_and_no_charge_time_are_unavailable(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """No active route and no remaining charge time: those sensors are unavailable."""
    data = _data(
        charge_state={"minutes_to_full_charge": 0},
        drive_state={
            "active_route_miles_to_arrival": None,
            "active_route_minutes_to_arrival": None,
        },
    )
    mock_fleet(aioclient_mock, "online", data)
    await setup_entry(hass, make_entry())
    assert hass.states.get(DISTANCE).state == STATE_UNAVAILABLE
    assert hass.states.get(TIME_TO_ARRIVAL).state == STATE_UNAVAILABLE
    assert hass.states.get(TIME_TO_FULL).state == STATE_UNAVAILABLE


async def test_missing_route_fields_are_unavailable(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """When the payload has no route fields (the default fixture), they are unavailable."""
    mock_fleet(aioclient_mock, "online")
    await setup_entry(hass, make_entry())
    assert hass.states.get(DISTANCE).state == STATE_UNAVAILABLE
    assert hass.states.get(TIME_TO_ARRIVAL).state == STATE_UNAVAILABLE
    assert hass.states.get(TIME_TO_FULL).state == STATE_UNAVAILABLE
    assert hass.states.get(ENERGY).state == STATE_UNKNOWN
    assert _state_in(hass, SPEED, UnitOfSpeed.MILES_PER_HOUR) == 0


async def test_arrival_sensors_work_with_location_off(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Location off still keeps arrival distance/time; it drops coordinates."""
    mock_fleet(aioclient_mock, "online", _data())
    await setup_entry(hass, make_entry({"location": False}))
    reads = calls_to(aioclient_mock, "/vehicle_data")
    assert len(reads) == 1
    assert "location_data" not in reads[0][1].query["endpoints"]
    assert hass.states.get("device_tracker.example_car_location") is None
    assert _state_in(hass, DISTANCE, UnitOfLength.MILES) == 12.5
    assert hass.states.get(TIME_TO_ARRIVAL).state != STATE_UNAVAILABLE


async def test_update_is_read_only(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """The update entity exists with commands off and does not offer install."""
    mock_fleet(aioclient_mock, "online", _data())
    await setup_entry(hass, make_entry())  # commands stay off
    state = hass.states.get(UPDATE)
    assert state is not None
    features = state.attributes.get("supported_features", 0)
    assert features & UpdateEntityFeature.INSTALL == 0
    assert hass.states.get("lock.example_car_lock") is None


async def test_update_without_pending_matches_installed(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """With no pending update, latest version equals the installed version."""
    mock_fleet(
        aioclient_mock,
        "online",
        _data(
            vehicle_state={
                "car_version": "2024.32.7 abcdef",
                "software_update": {"status": "", "version": ""},
            }
        ),
    )
    await setup_entry(hass, make_entry())
    state = hass.states.get(UPDATE)
    assert state.attributes["installed_version"] == "2024.32.7"
    assert state.attributes["latest_version"] == "2024.32.7"


async def test_update_install_progress(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """An in-progress install reports percent; still no install action."""
    mock_fleet(
        aioclient_mock,
        "online",
        _data(
            vehicle_state={
                "software_update": {
                    "status": "installing",
                    "version": "2024.44.30",
                    "install_perc": 40,
                }
            }
        ),
    )
    await setup_entry(hass, make_entry())
    state = hass.states.get(UPDATE)
    assert state.attributes["in_progress"] is True or state.attributes["in_progress"] == 40
    # Some HA versions expose percent via in_progress (int) or update_percentage.
    assert (
        state.attributes.get("update_percentage") == 40
        or state.attributes.get("in_progress") == 40
    )
    features = state.attributes.get("supported_features", 0)
    assert features & UpdateEntityFeature.INSTALL == 0
