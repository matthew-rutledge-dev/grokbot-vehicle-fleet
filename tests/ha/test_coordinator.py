"""Asleep/online gating: no billed vehicle_data read unless the car is online."""

from __future__ import annotations

from datetime import timedelta

from freezegun.api import FrozenDateTimeFactory
from homeassistant.const import STATE_UNKNOWN
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import async_fire_time_changed
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.vehicle_fleet.const import DOMAIN

from .conftest import VIN, calls_to, make_entry, mock_fleet, setup_entry

BATTERY = "sensor.example_car_battery_level"


async def test_asleep_makes_no_vehicle_data_call(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Asleep at setup: only list + summary reads, no vehicle_data, no wake."""
    mock_fleet(aioclient_mock, "asleep")
    await setup_entry(hass, make_entry())

    assert calls_to(aioclient_mock, "/vehicle_data") == []
    assert calls_to(aioclient_mock, "/wake_up", "post") == []
    assert len(calls_to(aioclient_mock, f"/vehicles/{VIN}")) == 1
    assert hass.states.get(BATTERY).state == STATE_UNKNOWN
    assert hass.states.get("sensor.example_car_vehicle_state").state == "asleep"
    assert hass.states.get("binary_sensor.example_car_status").state == "off"
    assert hass.states.get("sensor.example_car_data_age").state == STATE_UNKNOWN


async def test_online_reads_once_then_keeps_values_when_asleep(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
) -> None:
    """Online: one vehicle_data read. Later asleep: values kept, no new read."""
    mock_fleet(aioclient_mock, "online")
    await setup_entry(hass, make_entry())

    reads = calls_to(aioclient_mock, "/vehicle_data")
    assert len(reads) == 1
    assert "location_data" in reads[0][1].query["endpoints"]
    assert hass.states.get(BATTERY).state == "77"
    assert hass.states.get("binary_sensor.example_car_front_passenger_door").state == "on"
    assert hass.states.get("binary_sensor.example_car_front_driver_door").state == "off"
    assert hass.states.get("sensor.example_car_charging").state == "disconnected"
    assert hass.states.get("device_tracker.example_car_location").attributes["latitude"] == 1.2345
    age = hass.states.get("sensor.example_car_data_age")
    assert age.state != STATE_UNKNOWN
    assert age.attributes["vehicle_data_reads_since_start"] == 1

    mock_fleet(aioclient_mock, "asleep")
    freezer.tick(timedelta(minutes=16))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()

    assert calls_to(aioclient_mock, "/vehicle_data") == []
    assert len(calls_to(aioclient_mock, f"/vehicles/{VIN}")) == 1
    assert hass.states.get(BATTERY).state == "77"
    assert hass.states.get("sensor.example_car_vehicle_state").state == "asleep"
    assert hass.states.get("sensor.example_car_data_age").state == age.state


async def test_interval_option_respected(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
) -> None:
    """No poll before the configured interval elapses."""
    mock_fleet(aioclient_mock, "asleep")
    await setup_entry(hass, make_entry({"scan_interval_minutes": 30}))
    mock_fleet(aioclient_mock, "asleep")
    freezer.tick(timedelta(minutes=20))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert aioclient_mock.call_count == 0
    freezer.tick(timedelta(minutes=11))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert len(calls_to(aioclient_mock, f"/vehicles/{VIN}")) == 1


async def test_408_counts_as_asleep(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """A 408 from the summary is treated as asleep (no data read, not an error)."""
    aioclient_mock.get(
        "https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles",
        json={"response": [{"vin": VIN, "display_name": "Example Car", "state": "online"}]},
    )
    aioclient_mock.get(
        f"https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/{VIN}", status=408
    )
    await setup_entry(hass, make_entry())
    assert calls_to(aioclient_mock, "/vehicle_data") == []
    assert hass.states.get("sensor.example_car_vehicle_state").state == "asleep"


async def test_restored_values_while_asleep(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, hass_storage
) -> None:
    """Values saved before a restart show while the car stays asleep."""
    entry = make_entry()
    hass_storage[f"{DOMAIN}.{entry.entry_id}.{VIN[-6:]}"] = {
        "version": 1,
        "key": f"{DOMAIN}.{entry.entry_id}.{VIN[-6:]}",
        "data": {
            "charge_state_battery_level": 55,
            "drive_state_latitude": 1.0,
            "data_updated": "2026-01-01T00:00:00+00:00",
        },
    }
    mock_fleet(aioclient_mock, "asleep")
    await setup_entry(hass, entry)
    assert calls_to(aioclient_mock, "/vehicle_data") == []
    assert hass.states.get(BATTERY).state == "55"
    assert hass.states.get("sensor.example_car_data_age").state.startswith("2026-01-01")


async def test_location_opt_out(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Location off: no location_data endpoint and no tracker."""
    mock_fleet(aioclient_mock, "online")
    await setup_entry(hass, make_entry({"location": False}))
    reads = calls_to(aioclient_mock, "/vehicle_data")
    assert len(reads) == 1
    assert "location_data" not in reads[0][1].query["endpoints"]
    assert hass.states.get("device_tracker.example_car_location") is None


async def test_rate_limit_keeps_values(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
) -> None:
    """429 keeps the last values and does not mark entities unavailable."""
    mock_fleet(aioclient_mock, "online")
    await setup_entry(hass, make_entry())
    aioclient_mock.clear_requests()
    aioclient_mock.get(
        f"https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/{VIN}",
        status=429,
        headers={"Retry-After": "120"},
    )
    freezer.tick(timedelta(minutes=16))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert hass.states.get(BATTERY).state == "77"


async def test_expired_token_is_refreshed(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """An expired access token is refreshed via OAuth2Session before reads."""
    from custom_components.vehicle_fleet.const import TOKEN_URL

    entry = make_entry()
    entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(
        entry, data={**entry.data, "token": {**entry.data["token"], "expires_at": 0}}
    )
    mock_fleet(aioclient_mock, "asleep")
    aioclient_mock.post(
        TOKEN_URL,
        json={
            "access_token": "example-refreshed-token",
            "refresh_token": "example-refresh-token-2",
            "expires_in": 3600,
            "token_type": "Bearer",
        },
    )
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert len(calls_to(aioclient_mock, "/oauth2/v3/token", "post")) == 1
    reads = calls_to(aioclient_mock, f"/vehicles/{VIN}")
    assert reads[0][3]["Authorization"] == "Bearer example-refreshed-token"
    assert entry.data["token"]["access_token"] == "example-refreshed-token"


async def test_401_starts_reauth(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """A rejected token at setup starts a reauth flow."""
    from homeassistant.config_entries import ConfigEntryState

    aioclient_mock.get(
        "https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles", status=401
    )
    entry = make_entry()
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress()
    assert any(f["context"]["source"] == "reauth" for f in flows)
