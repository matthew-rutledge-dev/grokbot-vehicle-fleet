"""Config and options flow for the Grok Bot Vehicle Fleet integration."""

from __future__ import annotations

import base64
import json
import logging
import os
from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    SOURCE_REAUTH,
    ConfigEntry,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import config_entry_oauth2_flow
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
)

from .api import (
    FleetAuthError,
    FleetClient,
    FleetError,
    check_proxy_url,
    detect_base_url,
)
from .const import (
    CONF_BASE_URL,
    CONF_COMMANDS_ENABLED,
    CONF_LOCATION,
    CONF_PROXY_CA_CERT,
    CONF_PROXY_URL,
    CONF_REGION,
    CONF_SCAN_INTERVAL_MIN,
    DEFAULT_SCAN_INTERVAL_MIN,
    DOMAIN,
    LOGGER,
    MAX_SCAN_INTERVAL_MIN,
    MIN_SCAN_INTERVAL_MIN,
    REGION_AUTO,
    REGION_BASE_URLS,
)

DEFAULT_OPTIONS: dict[str, Any] = {
    CONF_COMMANDS_ENABLED: False,
    CONF_PROXY_URL: "",
    CONF_PROXY_CA_CERT: "",
    CONF_LOCATION: True,
    CONF_SCAN_INTERVAL_MIN: DEFAULT_SCAN_INTERVAL_MIN,
}


def _jwt_claims(token: str) -> dict[str, Any]:
    """Read (not verify) the JWT payload; used only for the account id and region hint."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
    except (IndexError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


class OAuth2FlowHandler(
    config_entry_oauth2_flow.AbstractOAuth2FlowHandler, domain=DOMAIN
):
    """OAuth2 config flow."""

    DOMAIN = DOMAIN
    VERSION = 1

    def __init__(self) -> None:
        """Initialize."""
        super().__init__()
        self._data: dict[str, Any] = {}
        self._region_hint: str = REGION_AUTO

    @property
    def logger(self) -> logging.Logger:
        """Return the logger."""
        return LOGGER

    async def async_oauth_create_entry(self, data: dict[str, Any]) -> ConfigFlowResult:
        """OAuth finished: set the account id, then ask for the region."""
        claims = _jwt_claims(data["token"]["access_token"])
        uid = claims.get("sub")
        if not isinstance(uid, str) or not uid:
            return self.async_abort(reason="invalid_token")
        await self.async_set_unique_id(uid)
        if self.source == SOURCE_REAUTH:
            self._abort_if_unique_id_mismatch(reason="reauth_account_mismatch")
            entry = self._get_reauth_entry()
            return self.async_update_reload_and_abort(
                entry, data={**entry.data, **data}
            )
        self._abort_if_unique_id_configured()
        self._data = data
        hint = str(claims.get("ou_code", "")).lower()
        self._region_hint = hint if hint in REGION_BASE_URLS else REGION_AUTO
        return await self.async_step_region()

    async def async_step_region(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Pick the Fleet API region (auto-detect by default)."""
        errors: dict[str, str] = {}
        if user_input is not None:
            region = user_input[CONF_REGION]
            session = async_get_clientsession(self.hass)
            token = self._data["token"]["access_token"]

            async def _token() -> str:
                return token

            try:
                if region == REGION_AUTO:
                    detected, base_url = await detect_base_url(session, _token)
                    region = detected or REGION_AUTO
                else:
                    base_url = REGION_BASE_URLS[region]
                vehicles = await FleetClient(session, _token, base_url).vehicles()
            except FleetAuthError:
                errors["base"] = "invalid_auth"
            except FleetError:
                errors["base"] = "cannot_connect"
            else:
                if not vehicles:
                    return self.async_abort(reason="no_vehicles")
                return self.async_create_entry(
                    title="Vehicle Fleet",
                    data={**self._data, CONF_REGION: region, CONF_BASE_URL: base_url},
                    options=dict(DEFAULT_OPTIONS),
                )
        options = [REGION_AUTO, *REGION_BASE_URLS]
        return self.async_show_form(
            step_id="region",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_REGION, default=self._region_hint): SelectSelector(
                        SelectSelectorConfig(
                            options=options,
                            translation_key=CONF_REGION,
                            mode=SelectSelectorMode.DROPDOWN,
                        )
                    )
                }
            ),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """Start reauth."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm reauth."""
        if user_input is None:
            return self.async_show_form(step_id="reauth_confirm")
        return await self.async_step_user()

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        """Options flow."""
        return VehicleFleetOptionsFlow()


class VehicleFleetOptionsFlow(OptionsFlow):
    """Options: poll interval, location, and the command opt-in (off by default)."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Show and validate options."""
        errors: dict[str, str] = {}
        current = {**DEFAULT_OPTIONS, **self.config_entry.options}
        if user_input is not None:
            data = {**DEFAULT_OPTIONS, **user_input}
            data[CONF_SCAN_INTERVAL_MIN] = int(data[CONF_SCAN_INTERVAL_MIN])
            proxy = (data.get(CONF_PROXY_URL) or "").strip()
            ca = (data.get(CONF_PROXY_CA_CERT) or "").strip()
            if proxy:
                try:
                    proxy = check_proxy_url(proxy)
                except ValueError as err:
                    errors[CONF_PROXY_URL] = str(err)
            if data[CONF_COMMANDS_ENABLED] and not proxy and CONF_PROXY_URL not in errors:
                errors[CONF_PROXY_URL] = "proxy_required"
            if ca and not await self.hass.async_add_executor_job(os.path.isfile, ca):
                errors[CONF_PROXY_CA_CERT] = "ca_not_found"
            if not errors:
                data[CONF_PROXY_URL] = proxy
                data[CONF_PROXY_CA_CERT] = ca
                return self.async_create_entry(data=data)
            current = {**current, **user_input}

        schema = vol.Schema(
            {
                vol.Required(
                    CONF_SCAN_INTERVAL_MIN, default=current[CONF_SCAN_INTERVAL_MIN]
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=MIN_SCAN_INTERVAL_MIN,
                        max=MAX_SCAN_INTERVAL_MIN,
                        step=1,
                        mode=NumberSelectorMode.BOX,
                        unit_of_measurement="min",
                    )
                ),
                vol.Required(CONF_LOCATION, default=current[CONF_LOCATION]): BooleanSelector(),
                vol.Required(
                    CONF_COMMANDS_ENABLED, default=current[CONF_COMMANDS_ENABLED]
                ): BooleanSelector(),
                vol.Optional(
                    CONF_PROXY_URL,
                    description={"suggested_value": current[CONF_PROXY_URL]},
                ): TextSelector(),
                vol.Optional(
                    CONF_PROXY_CA_CERT,
                    description={"suggested_value": current[CONF_PROXY_CA_CERT]},
                ): TextSelector(),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema, errors=errors)
