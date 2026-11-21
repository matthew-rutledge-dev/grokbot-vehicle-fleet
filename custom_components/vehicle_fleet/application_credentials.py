"""Application credentials platform: bring your own Fleet API app."""

from __future__ import annotations

from typing import Any

from homeassistant.components.application_credentials import (
    AuthImplementation,
    AuthorizationServer,
    ClientCredential,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_entry_oauth2_flow

from .const import AUTHORIZE_URL, SCOPES, TOKEN_URL


class VehicleFleetImplementation(AuthImplementation):
    """OAuth2 implementation with the Fleet API scopes and prompts."""

    def __init__(
        self, hass: HomeAssistant, auth_domain: str, credential: ClientCredential
    ) -> None:
        """Initialize with the documented authorize and token hosts."""
        super().__init__(
            hass,
            auth_domain,
            credential,
            AuthorizationServer(authorize_url=AUTHORIZE_URL, token_url=TOKEN_URL),
        )

    @property
    def extra_authorize_data(self) -> dict[str, Any]:
        """Scopes and prompts appended to the authorize URL."""
        return {
            "scope": " ".join(SCOPES),
            "prompt_missing_scopes": "true",
        }


async def async_get_auth_implementation(
    hass: HomeAssistant, auth_domain: str, credential: ClientCredential
) -> config_entry_oauth2_flow.AbstractOAuth2Implementation:
    """Return the auth implementation for a user-supplied client id/secret."""
    return VehicleFleetImplementation(hass, auth_domain, credential)


async def async_get_description_placeholders(hass: HomeAssistant) -> dict[str, str]:
    """Placeholders for the application credentials dialog."""
    return {
        "developer_url": "https://developer.tesla.com",
        "redirect_url": "https://my.home-assistant.io/redirect/oauth",
    }
