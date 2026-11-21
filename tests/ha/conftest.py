"""Shared fixtures. Placeholder identifiers only."""

from __future__ import annotations

import time
from typing import Any

import pytest
from homeassistant.components.application_credentials import (
    DOMAIN as APPLICATION_CREDENTIALS_DOMAIN,
)
from homeassistant.components.application_credentials import (
    ClientCredential,
    async_import_client_credential,
)
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.vehicle_fleet.config_flow import DEFAULT_OPTIONS
from custom_components.vehicle_fleet.const import DOMAIN, REGION_BASE_URLS

VIN = "5YJ000000EXAMPLE"
BASE = REGION_BASE_URLS["na"]
PROXY = "https://proxy.example.com"
VEHICLE_URL = f"{BASE}/api/1/vehicles/{VIN}"
VEHICLE_DATA_URL = f"{VEHICLE_URL}/vehicle_data"
LIST_URL = f"{BASE}/api/1/vehicles"


def product(state: str = "asleep") -> dict[str, Any]:
    """A vehicle list entry."""
    return {"id": 1, "vin": VIN, "display_name": "Example Car", "state": state}


VEHICLE_DATA: dict[str, Any] = {
    "vin": VIN,
    "state": "online",
    "charge_state": {
        "battery_level": 77,
        "battery_range": 210.5,
        "charge_limit_soc": 80,
        "charger_power": 0,
        "charging_state": "Disconnected",
        "conn_charge_cable": "<invalid>",
    },
    "climate_state": {
        "inside_temp": 21.5,
        "outside_temp": 10.0,
        "is_climate_on": False,
        "driver_temp_setting": 20.0,
    },
    "drive_state": {"latitude": 1.2345, "longitude": 2.3456},
    "vehicle_state": {
        "locked": True,
        "odometer": 12345.6,
        "sentry_mode": True,
        "df": 0,
        "dr": 0,
        "pf": 1,
        "pr": 0,
        "ft": 0,
        "rt": 0,
        "fd_window": 0,
        "fp_window": 0,
        "rd_window": 0,
        "rp_window": 0,
        "tpms_pressure_fl": 2.9,
        "tpms_pressure_fr": 2.9,
        "tpms_pressure_rl": 2.9,
        "tpms_pressure_rr": 2.9,
        "homelink_nearby": True,
    },
}


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Load custom_components/."""


@pytest.fixture(autouse=True)
async def credential(hass: HomeAssistant) -> None:
    """Register a placeholder application credential."""
    assert await async_setup_component(hass, APPLICATION_CREDENTIALS_DOMAIN, {})
    await async_import_client_credential(
        hass, DOMAIN, ClientCredential("example-client-id", "example-client-secret"), DOMAIN
    )


def make_entry(options: dict[str, Any] | None = None) -> MockConfigEntry:
    """A configured entry with a valid (placeholder) token."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="Vehicle Fleet",
        unique_id="example-user",
        data={
            "auth_implementation": DOMAIN,
            "token": {
                "access_token": "example-access-token",
                "refresh_token": "example-refresh-token",
                "expires_at": time.time() + 3600,
                "expires_in": 3600,
                "token_type": "Bearer",
            },
            "region": "na",
            "base_url": BASE,
        },
        options={**DEFAULT_OPTIONS, **(options or {})},
    )


def mock_fleet(
    aioclient_mock: AiohttpClientMocker,
    state: str,
    data: dict[str, Any] | None = None,
) -> None:
    """Register list, summary and (optionally) vehicle_data responses."""
    aioclient_mock.clear_requests()
    aioclient_mock.get(LIST_URL, json={"response": [product(state)], "count": 1})
    aioclient_mock.get(VEHICLE_URL, json={"response": product(state)})
    aioclient_mock.get(VEHICLE_DATA_URL, json={"response": data or VEHICLE_DATA})


def calls_to(aioclient_mock: AiohttpClientMocker, path_suffix: str, method: str = "get") -> list:
    """Recorded calls whose path ends with path_suffix."""
    return [
        c
        for c in aioclient_mock.mock_calls
        if c[0].lower() == method and str(c[1].path).endswith(path_suffix)
    ]


async def setup_entry(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """Add and set up an entry."""
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
