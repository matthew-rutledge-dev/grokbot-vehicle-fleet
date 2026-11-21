"""Read-only gating and command entities (mocked HTTP; nothing real is contacted)."""

from __future__ import annotations

import pytest
from homeassistant.components.button import DOMAIN as BUTTON_DOMAIN
from homeassistant.components.button import SERVICE_PRESS
from homeassistant.components.climate import (
    DOMAIN as CLIMATE_DOMAIN,
)
from homeassistant.components.climate import (
    SERVICE_SET_TEMPERATURE,
)
from homeassistant.components.lock import DOMAIN as LOCK_DOMAIN
from homeassistant.components.switch import DOMAIN as SWITCH_DOMAIN
from homeassistant.const import (
    ATTR_ENTITY_ID,
    ATTR_TEMPERATURE,
    SERVICE_TURN_OFF,
    SERVICE_UNLOCK,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.vehicle_fleet.api import CommandsDisabled, check_proxy_url

from .conftest import BASE, PROXY, VIN, calls_to, make_entry, mock_fleet, setup_entry

CMD_OPTS = {"commands_enabled": True, "proxy_url": PROXY}
COMMAND_DOMAINS = ("lock", "climate", "switch", "button")


async def test_read_only_default_has_no_command_entities(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entity_registry: er.EntityRegistry
) -> None:
    """Default options: no lock/climate/switch/button entities; client refuses."""
    mock_fleet(aioclient_mock, "online")
    entry = make_entry()
    await setup_entry(hass, entry)
    entities = er.async_entries_for_config_entry(entity_registry, entry.entry_id)
    assert entities
    assert not [e for e in entities if e.domain in COMMAND_DOMAINS]

    client = entry.runtime_data.client
    with pytest.raises(CommandsDisabled):
        await client.command(VIN, "door_unlock")
    with pytest.raises(CommandsDisabled):
        await client.wake_up(VIN)
    assert calls_to(aioclient_mock, "", "post") == []


async def test_proxy_ignored_while_read_only(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """A proxy URL alone does not enable commands."""
    mock_fleet(aioclient_mock, "online")
    entry = make_entry({"proxy_url": PROXY})
    await setup_entry(hass, entry)
    assert hass.states.get("lock.example_car_lock") is None
    assert entry.runtime_data.client.proxy_url is None


async def test_unlock_goes_through_proxy(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Unlock: online check, then one POST to the proxy with the bearer token."""
    mock_fleet(aioclient_mock, "online")
    await setup_entry(hass, make_entry(CMD_OPTS))
    assert hass.states.get("lock.example_car_lock").state == "locked"

    aioclient_mock.post(
        f"{PROXY}/api/1/vehicles/{VIN}/command/door_unlock",
        json={"response": {"result": True, "reason": ""}},
    )
    await hass.services.async_call(
        LOCK_DOMAIN, SERVICE_UNLOCK, {ATTR_ENTITY_ID: "lock.example_car_lock"}, blocking=True
    )
    posts = calls_to(aioclient_mock, "/command/door_unlock", "post")
    assert len(posts) == 1
    assert str(posts[0][1]).startswith(PROXY)
    assert posts[0][3]["Authorization"] == "Bearer example-access-token"
    assert not [c for c in aioclient_mock.mock_calls if c[0] == "post" and str(c[1]).startswith(BASE)]
    assert hass.states.get("lock.example_car_lock").state == "unlocked"


async def test_command_refused_while_asleep_no_wake(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Asleep: the command is refused, nothing is sent and the car is not woken."""
    mock_fleet(aioclient_mock, "asleep")
    await setup_entry(hass, make_entry(CMD_OPTS))
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            LOCK_DOMAIN, SERVICE_UNLOCK, {ATTR_ENTITY_ID: "lock.example_car_lock"}, blocking=True
        )
    assert calls_to(aioclient_mock, "", "post") == []


async def test_vehicle_refusal_is_an_error(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """result=false from the car raises and leaves the state unchanged."""
    mock_fleet(aioclient_mock, "online")
    await setup_entry(hass, make_entry(CMD_OPTS))
    aioclient_mock.post(
        f"{PROXY}/api/1/vehicles/{VIN}/command/set_sentry_mode",
        json={"response": {"result": False, "reason": "not allowed"}},
    )
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            SWITCH_DOMAIN,
            SERVICE_TURN_OFF,
            {ATTR_ENTITY_ID: "switch.example_car_sentry_mode"},
            blocking=True,
        )
    assert hass.states.get("switch.example_car_sentry_mode").state == "on"


async def test_set_temperature(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """set_temps sends both seats through the proxy."""
    mock_fleet(aioclient_mock, "online")
    await setup_entry(hass, make_entry(CMD_OPTS))
    aioclient_mock.post(
        f"{PROXY}/api/1/vehicles/{VIN}/command/set_temps",
        json={"response": {"result": True}},
    )
    await hass.services.async_call(
        CLIMATE_DOMAIN,
        SERVICE_SET_TEMPERATURE,
        {ATTR_ENTITY_ID: "climate.example_car_climate", ATTR_TEMPERATURE: 21},
        blocking=True,
    )
    posts = calls_to(aioclient_mock, "/command/set_temps", "post")
    assert posts[0][2] == {"driver_temp": 21, "passenger_temp": 21}


async def test_wake_button_is_the_only_wake(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """The Wake button posts wake_up to the Fleet API once."""
    mock_fleet(aioclient_mock, "asleep")
    await setup_entry(hass, make_entry(CMD_OPTS))
    assert calls_to(aioclient_mock, "/wake_up", "post") == []
    aioclient_mock.post(f"{BASE}/api/1/vehicles/{VIN}/wake_up", json={"response": {"state": "asleep"}})
    await hass.services.async_call(
        BUTTON_DOMAIN, SERVICE_PRESS, {ATTR_ENTITY_ID: "button.example_car_wake"}, blocking=True
    )
    assert len(calls_to(aioclient_mock, "/wake_up", "post")) == 1


async def test_homelink_uses_live_location(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """HomeLink: one live read for lat/lon, then trigger_homelink via the proxy."""
    mock_fleet(aioclient_mock, "online")
    await setup_entry(hass, make_entry(CMD_OPTS))
    aioclient_mock.post(
        f"{PROXY}/api/1/vehicles/{VIN}/command/trigger_homelink",
        json={"response": {"result": True}},
    )
    await hass.services.async_call(
        BUTTON_DOMAIN, SERVICE_PRESS, {ATTR_ENTITY_ID: "button.example_car_homelink"}, blocking=True
    )
    posts = calls_to(aioclient_mock, "/command/trigger_homelink", "post")
    assert posts[0][2] == {"lat": 1.2345, "lon": 2.3456}


async def test_homelink_not_nearby_sends_nothing(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """homelink_nearby false: refused before sending."""
    data = {"vehicle_state": {"homelink_nearby": False}, "drive_state": {"latitude": 1.0, "longitude": 2.0}}
    mock_fleet(aioclient_mock, "online")
    await setup_entry(hass, make_entry(CMD_OPTS))
    mock_fleet(aioclient_mock, "online", data)
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            BUTTON_DOMAIN, SERVICE_PRESS, {ATTR_ENTITY_ID: "button.example_car_homelink"}, blocking=True
        )
    assert calls_to(aioclient_mock, "/command/trigger_homelink", "post") == []


@pytest.mark.parametrize(
    ("url", "ok"),
    [
        ("https://proxy.example.com", True),
        ("https://proxy.example.com:4443/", True),
        ("http://localhost:4443", True),
        ("http://127.0.0.1:4443", True),
        ("http://proxy.example.com", False),
        ("https://user:pw@proxy.example.com", False),
        ("ftp://proxy.example.com", False),
        ("https://proxy.example.com/?x=1", False),
    ],
)
def test_check_proxy_url(url: str, ok: bool) -> None:
    """Proxy URL rules mirror the Node server."""
    if ok:
        assert check_proxy_url(url).startswith(url.split(":")[0])
    else:
        with pytest.raises(ValueError):
            check_proxy_url(url)
