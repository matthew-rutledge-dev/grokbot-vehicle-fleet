"""0.8.1 review follow-ups: VIN display, option parsing, token refresh errors."""

from __future__ import annotations

import logging
from datetime import timedelta

import pytest
from aiohttp import ClientConnectionError
from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import async_fire_time_changed
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.vehicle_fleet import parse_interval
from custom_components.vehicle_fleet.const import DOMAIN, TOKEN_URL

from .conftest import PROXY, VIN, calls_to, make_entry, mock_fleet, setup_entry

COMMAND_DOMAINS = ("lock", "climate", "switch", "button")
BATTERY = "sensor.example_car_battery_level"


def _command_entities(entity_registry: er.EntityRegistry, entry) -> list:
    return [
        e
        for e in er.async_entries_for_config_entry(entity_registry, entry.entry_id)
        if e.domain in COMMAND_DOMAINS
    ]


def _raw_exception_logged(caplog: pytest.LogCaptureFixture) -> bool:
    """A traceback logged at WARNING or above (DEBUG detail from HA core is fine)."""
    return any(r.exc_info and r.levelno >= logging.WARNING for r in caplog.records)


def _expire(hass: HomeAssistant, entry) -> None:
    hass.config_entries.async_update_entry(
        entry, data={**entry.data, "token": {**entry.data["token"], "expires_at": 0}}
    )


# 1. No full VIN on the device page --------------------------------------------


async def test_device_shows_no_vin(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    device_registry: dr.DeviceRegistry,
    entity_registry: er.EntityRegistry,
) -> None:
    """No serial number; the VIN stays only in identifiers / unique_ids."""
    mock_fleet(aioclient_mock, "asleep")
    entry = make_entry()
    await setup_entry(hass, entry)
    devices = dr.async_entries_for_config_entry(device_registry, entry.entry_id)
    assert len(devices) == 1
    device = devices[0]
    assert (DOMAIN, VIN) in device.identifiers
    assert device.serial_number is None
    for value in (device.name, device.name_by_user, device.model, device.hw_version, device.sw_version):
        assert value is None or VIN not in value
    assert entity_registry.async_get("sensor.example_car_battery_level").unique_id.startswith(VIN)


# 2. commands_enabled must be a real True; stored proxy URL re-validated -------


@pytest.mark.parametrize("value", ["false", "true", 1, "yes", None])
async def test_non_bool_commands_flag_stays_read_only(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    entity_registry: er.EntityRegistry,
    value,
) -> None:
    """Only the boolean True enables commands."""
    mock_fleet(aioclient_mock, "online")
    entry = make_entry({"commands_enabled": value, "proxy_url": PROXY})
    await setup_entry(hass, entry)
    assert entry.runtime_data.commands_enabled is False
    assert entry.runtime_data.client.commands_enabled is False
    assert _command_entities(entity_registry, entry) == []


@pytest.mark.parametrize(
    "proxy",
    ["", "http://proxy.example.com", "ftp://proxy.example.com", "https://user:pw@proxy.example.com", 42],
)
async def test_invalid_stored_proxy_falls_back_to_read_only(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    entity_registry: er.EntityRegistry,
    caplog: pytest.LogCaptureFixture,
    proxy,
) -> None:
    """A stored proxy URL that fails the options-flow rules means read-only plus a warning."""
    mock_fleet(aioclient_mock, "online")
    entry = make_entry({"commands_enabled": True, "proxy_url": proxy})
    with caplog.at_level(logging.WARNING):
        await setup_entry(hass, entry)
    assert entry.state is ConfigEntryState.LOADED
    assert entry.runtime_data.commands_enabled is False
    assert entry.runtime_data.client.proxy_url is None
    assert _command_entities(entity_registry, entry) == []
    assert "running read-only" in caplog.text


async def test_valid_stored_proxy_enables_commands(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entity_registry: er.EntityRegistry
) -> None:
    """Control: a valid proxy and a real True keep commands on (normalized URL)."""
    mock_fleet(aioclient_mock, "online")
    entry = make_entry({"commands_enabled": True, "proxy_url": f" {PROXY}/ "})
    await setup_entry(hass, entry)
    assert entry.runtime_data.commands_enabled is True
    assert entry.runtime_data.client.proxy_url == PROXY
    assert _command_entities(entity_registry, entry)


# 3. Poll interval parsing --------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "minutes"),
    [
        (None, 15),
        ("abc", 15),
        ("", 15),
        ({}, 15),
        (True, 15),
        (float("nan"), 15),
        (float("inf"), 15),
        (1, 5),
        (-3, 5),
        ("30", 30),
        (12.7, 12),
        (99999, 1440),
    ],
)
def test_parse_interval(raw, minutes: int) -> None:
    """Unparsable: default; otherwise clamped to [5, 1440]."""
    assert parse_interval(raw) == minutes


@pytest.mark.parametrize(("raw", "minutes"), [("abc", 15), (1, 5)])
async def test_corrupt_interval_does_not_break_setup(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, raw, minutes: int
) -> None:
    """Setup succeeds and uses the default or the clamped minimum."""
    mock_fleet(aioclient_mock, "asleep")
    entry = make_entry({"scan_interval_minutes": raw})
    await setup_entry(hass, entry)
    assert entry.state is ConfigEntryState.LOADED
    coordinator = entry.runtime_data.vehicles[0].coordinator
    assert coordinator.update_interval == timedelta(minutes=minutes)


# 4. Token refresh network errors ------------------------------------------------


@pytest.mark.parametrize("exc", [ClientConnectionError(), TimeoutError()])
async def test_refresh_network_error_at_setup_retries(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, caplog: pytest.LogCaptureFixture, exc
) -> None:
    """No response from the token endpoint at setup: setup retry, not a crash or reauth."""
    entry = make_entry()
    entry.add_to_hass(hass)
    _expire(hass, entry)
    mock_fleet(aioclient_mock, "asleep")
    aioclient_mock.post(TOKEN_URL, exc=exc)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert not [f for f in hass.config_entries.flow.async_progress() if f["context"]["source"] == "reauth"]
    assert calls_to(aioclient_mock, "/api/1/vehicles") == []
    assert "Error setting up entry" not in caplog.text
    assert not _raw_exception_logged(caplog)


async def test_refresh_5xx_at_setup_retries(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """A 5xx from the token endpoint is transient: setup retry."""
    entry = make_entry()
    entry.add_to_hass(hass)
    _expire(hass, entry)
    aioclient_mock.post(TOKEN_URL, status=503)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_refresh_rejected_at_setup_starts_reauth(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """A 400 from the token endpoint (revoked refresh token) starts reauth."""
    entry = make_entry()
    entry.add_to_hass(hass)
    _expire(hass, entry)
    aioclient_mock.post(TOKEN_URL, status=400, json={"error": "invalid_grant"})
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_ERROR
    assert any(
        f["context"]["source"] == "reauth" for f in hass.config_entries.flow.async_progress()
    )


@pytest.mark.parametrize("exc", [ClientConnectionError(), TimeoutError()])
async def test_refresh_network_error_while_polling_is_update_failed(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    caplog: pytest.LogCaptureFixture,
    exc,
) -> None:
    """During polling a refresh network error marks entities unavailable (UpdateFailed), no raw exception."""
    mock_fleet(aioclient_mock, "online")
    entry = make_entry()
    await setup_entry(hass, entry)
    assert hass.states.get(BATTERY).state == "77"

    _expire(hass, entry)
    await hass.async_block_till_done()
    # The token update must not reload the entry (no repeated setup reads).
    assert entry.state is ConfigEntryState.LOADED
    mock_fleet(aioclient_mock, "online")
    aioclient_mock.post(TOKEN_URL, exc=exc)
    freezer.tick(timedelta(minutes=16))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()

    coordinator = entry.runtime_data.vehicles[0].coordinator
    assert coordinator.last_update_success is False
    assert hass.states.get(BATTERY).state == STATE_UNAVAILABLE
    assert calls_to(aioclient_mock, "/vehicle_data") == []
    assert "Unexpected error" not in caplog.text
    assert not _raw_exception_logged(caplog)


async def test_token_update_does_not_reload_but_options_do(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Entry data changes (token refresh) don't reload; option changes do."""
    mock_fleet(aioclient_mock, "asleep")
    entry = make_entry()
    await setup_entry(hass, entry)
    first = entry.runtime_data

    hass.config_entries.async_update_entry(
        entry, data={**entry.data, "token": {**entry.data["token"], "access_token": "example-new"}}
    )
    await hass.async_block_till_done()
    assert entry.runtime_data is first

    hass.config_entries.async_update_entry(
        entry, options={**entry.options, "scan_interval_minutes": 30}
    )
    await hass.async_block_till_done()
    assert entry.runtime_data is not first
    assert entry.runtime_data.vehicles[0].coordinator.update_interval == timedelta(minutes=30)
