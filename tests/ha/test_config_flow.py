"""Config and options flow."""

from __future__ import annotations

from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import pytest
from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType, InvalidData
from homeassistant.helpers import config_entry_oauth2_flow
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.vehicle_fleet.const import (
    AUTHORIZE_URL,
    DOMAIN,
    REGION_BASE_URLS,
    TOKEN_URL,
)

from .conftest import BASE, LIST_URL, PROXY, make_entry, product

REDIRECT = "https://example.com/auth/external/callback"


def _jwt(hass: HomeAssistant, sub: str = "example-user") -> str:
    return config_entry_oauth2_flow._encode_jwt(hass, {"sub": sub, "ou_code": "NA"})


async def _oauth(hass, hass_client_no_auth, aioclient_mock, sub="example-user"):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.EXTERNAL_STEP
    url = urlparse(result["url"])
    assert f"{url.scheme}://{url.netloc}{url.path}" == AUTHORIZE_URL
    query = parse_qs(url.query)
    assert "vehicle_device_data" in query["scope"][0]
    assert "offline_access" in query["scope"][0]
    state = config_entry_oauth2_flow._encode_jwt(
        hass, {"flow_id": result["flow_id"], "redirect_uri": REDIRECT}
    )
    client = await hass_client_no_auth()
    await client.get(f"/auth/external/callback?code=abcd&state={state}")
    aioclient_mock.post(
        TOKEN_URL,
        json={
            "refresh_token": "example-refresh-token",
            "access_token": _jwt(hass, sub),
            "type": "Bearer",
            "expires_in": 3600,
        },
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"])
    return result


@pytest.mark.usefixtures("current_request_with_host", "credential")
async def test_full_flow_auto_region(
    hass: HomeAssistant,
    hass_client_no_auth: ClientSessionGenerator,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """OAuth, region auto-detect, vehicle list check, entry created read-only."""
    result = await _oauth(hass, hass_client_no_auth, aioclient_mock)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "region"

    aioclient_mock.get(
        f"{REGION_BASE_URLS['na']}/api/1/users/region",
        json={"response": {"region": "na", "fleet_api_base_url": BASE}},
    )
    aioclient_mock.get(LIST_URL, json={"response": [product()]})
    with patch("custom_components.vehicle_fleet.async_setup_entry", return_value=True):
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {"region": "auto"}
        )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    entry = result["result"]
    assert entry.unique_id == "example-user"
    assert entry.data["base_url"] == BASE
    assert entry.data["region"] == "na"
    assert entry.options["commands_enabled"] is False
    assert entry.options["location"] is True
    assert entry.options["scan_interval_minutes"] == 15


@pytest.mark.usefixtures("current_request_with_host", "credential")
async def test_flow_rejects_unexpected_region_url(
    hass: HomeAssistant,
    hass_client_no_auth: ClientSessionGenerator,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """A region answer that is not a Fleet API host is never used."""
    result = await _oauth(hass, hass_client_no_auth, aioclient_mock)
    for region in ("na", "eu"):
        aioclient_mock.get(
            f"{REGION_BASE_URLS[region]}/api/1/users/region",
            json={"response": {"region": "na", "fleet_api_base_url": "https://evil.example.com"}},
        )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {"region": "auto"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


@pytest.mark.usefixtures("current_request_with_host", "credential")
async def test_flow_explicit_region_and_errors(
    hass: HomeAssistant,
    hass_client_no_auth: ClientSessionGenerator,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """An explicit region skips detection; 401 and 5xx map to form errors."""
    result = await _oauth(hass, hass_client_no_auth, aioclient_mock)
    eu_list = f"{REGION_BASE_URLS['eu']}/api/1/vehicles"
    aioclient_mock.get(eu_list, status=401)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"region": "eu"})
    assert result["errors"] == {"base": "invalid_auth"}

    aioclient_mock.clear_requests()
    aioclient_mock.get(eu_list, status=500)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"region": "eu"})
    assert result["errors"] == {"base": "cannot_connect"}

    aioclient_mock.clear_requests()
    aioclient_mock.get(eu_list, json={"response": [product()]})
    with patch("custom_components.vehicle_fleet.async_setup_entry", return_value=True):
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {"region": "eu"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["result"].data["base_url"] == REGION_BASE_URLS["eu"]


@pytest.mark.usefixtures("current_request_with_host", "credential")
async def test_flow_already_configured(
    hass: HomeAssistant,
    hass_client_no_auth: ClientSessionGenerator,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Same account twice aborts."""
    make_entry().add_to_hass(hass)
    result = await _oauth(hass, hass_client_no_auth, aioclient_mock)
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_options_flow_validation(hass: HomeAssistant) -> None:
    """Commands need a proxy URL; http only on loopback; interval saved."""
    entry = make_entry()
    entry.add_to_hass(hass)
    base = {"scan_interval_minutes": 20, "location": False}

    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {**base, "commands_enabled": True}
    )
    assert result["errors"] == {"proxy_url": "proxy_required"}

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {**base, "commands_enabled": True, "proxy_url": "http://proxy.example.com"},
    )
    assert result["errors"] == {"proxy_url": "http_not_loopback"}

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {**base, "commands_enabled": True, "proxy_url": PROXY, "proxy_ca_cert": "/nonexistent/ca.pem"},
    )
    assert result["errors"] == {"proxy_ca_cert": "ca_not_found"}

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {**base, "commands_enabled": True, "proxy_url": PROXY + "/"},
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options["commands_enabled"] is True
    assert entry.options["proxy_url"] == PROXY
    assert entry.options["scan_interval_minutes"] == 20
    assert entry.options["location"] is False


async def test_options_interval_minimum(hass: HomeAssistant) -> None:
    """Intervals below the 5 minute minimum are rejected by the schema."""
    entry = make_entry()
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    with pytest.raises(InvalidData):
        await hass.config_entries.options.async_configure(
            result["flow_id"],
            {"scan_interval_minutes": 1, "location": True, "commands_enabled": False},
        )
