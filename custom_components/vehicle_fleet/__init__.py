"""Grok Bot Vehicle Fleet: Home Assistant integration (cloud polling, read-only by default)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from aiohttp import ClientResponseError
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.config_entry_oauth2_flow import (
    OAuth2Session,
    async_get_config_entry_implementation,
)
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.storage import Store

from .api import FleetAuthError, FleetClient, FleetError, build_ssl_context
from .const import (
    CONF_BASE_URL,
    CONF_COMMANDS_ENABLED,
    CONF_LOCATION,
    CONF_PROXY_CA_CERT,
    CONF_PROXY_URL,
    CONF_SCAN_INTERVAL_MIN,
    DEFAULT_SCAN_INTERVAL_MIN,
    DOMAIN,
    MIN_SCAN_INTERVAL_MIN,
    REGION_BASE_URLS,
    STORAGE_VERSION,
)
from .coordinator import VehicleFleetCoordinator

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.CLIMATE,
    Platform.DEVICE_TRACKER,
    Platform.LOCK,
    Platform.SENSOR,
    Platform.SWITCH,
]


@dataclass
class VehicleRuntime:
    """One vehicle."""

    vin: str
    coordinator: VehicleFleetCoordinator
    device: DeviceInfo


@dataclass
class VehicleFleetData:
    """Runtime data for a config entry."""

    client: FleetClient
    commands_enabled: bool
    location: bool
    vehicles: list[VehicleRuntime] = field(default_factory=list)


type VehicleFleetConfigEntry = ConfigEntry[VehicleFleetData]


async def async_setup_entry(hass: HomeAssistant, entry: VehicleFleetConfigEntry) -> bool:
    """Set up from a config entry."""
    implementation = await async_get_config_entry_implementation(hass, entry)
    oauth = OAuth2Session(hass, entry, implementation)

    async def token_getter() -> str:
        try:
            await oauth.async_ensure_token_valid()
        except ClientResponseError as err:
            if err.status in (400, 401):
                raise FleetAuthError("refresh_failed", "token refresh failed", err.status) from err
            raise FleetError("refresh_failed", "token refresh failed", err.status) from err
        return oauth.token["access_token"]

    opts: dict[str, Any] = dict(entry.options)
    commands_enabled = bool(opts.get(CONF_COMMANDS_ENABLED, False))
    proxy_url = (opts.get(CONF_PROXY_URL) or "").strip() or None
    ca_path = (opts.get(CONF_PROXY_CA_CERT) or "").strip() or None
    location = bool(opts.get(CONF_LOCATION, True))
    minutes = max(int(opts.get(CONF_SCAN_INTERVAL_MIN, DEFAULT_SCAN_INTERVAL_MIN)), MIN_SCAN_INTERVAL_MIN)

    proxy_ssl = None
    if commands_enabled and ca_path:
        try:
            proxy_ssl = await hass.async_add_executor_job(build_ssl_context, ca_path)
        except (OSError, ValueError) as err:
            raise ConfigEntryNotReady("command proxy CA certificate could not be loaded") from err

    base_url = entry.data.get(CONF_BASE_URL) or REGION_BASE_URLS["na"]
    client = FleetClient(
        async_get_clientsession(hass),
        token_getter,
        base_url,
        commands_enabled=commands_enabled,
        proxy_url=proxy_url if commands_enabled else None,
        proxy_ssl=proxy_ssl,
    )

    try:
        products = await client.vehicles()
    except FleetAuthError as err:
        raise ConfigEntryAuthFailed("token rejected") from err
    except FleetError as err:
        raise ConfigEntryNotReady(str(err)) from err

    data = VehicleFleetData(client=client, commands_enabled=commands_enabled, location=location)
    for product in products:
        vin = product.get("vin")
        if not isinstance(vin, str) or not vin:
            continue
        coordinator = VehicleFleetCoordinator(
            hass,
            entry,
            client,
            vin,
            product,
            interval=timedelta(minutes=minutes),
            location=location,
        )
        await coordinator.async_restore()
        await coordinator.async_config_entry_first_refresh()
        device = DeviceInfo(
            identifiers={(DOMAIN, vin)},
            manufacturer="Tesla",
            name=product.get("display_name") or f"Vehicle {vin[-4:]}",
            serial_number=vin,
        )
        data.vehicles.append(VehicleRuntime(vin=vin, coordinator=coordinator, device=device))

    entry.runtime_data = data
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def _async_reload(hass: HomeAssistant, entry: VehicleFleetConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: VehicleFleetConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Delete saved last values when the entry is removed."""
    prefix = f"{DOMAIN}.{entry.entry_id}."
    storage_dir = hass.config.path(".storage")

    def _list() -> list[str]:
        if not os.path.isdir(storage_dir):
            return []
        return [n for n in os.listdir(storage_dir) if n.startswith(prefix)]

    for name in await hass.async_add_executor_job(_list):
        await Store(hass, STORAGE_VERSION, name).async_remove()
