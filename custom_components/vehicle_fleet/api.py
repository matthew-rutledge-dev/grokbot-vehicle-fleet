"""Minimal async Fleet API client for the Vehicle Fleet integration.

Reads go to the regional Fleet API. Signed vehicle commands go only to the
user-configured command proxy (tesla-http-proxy). The wake call goes to the
Fleet API and is only reachable from a user-pressed button.
"""

from __future__ import annotations

import ipaddress
import re
import ssl
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote, urlsplit

import aiohttp

from .const import (
    AUTO_DETECT_REGIONS,
    BASE_URL_PATTERN,
    HTTP_TIMEOUT,
    LOGGER,
    REGION_BASE_URLS,
)


class FleetError(Exception):
    """Base error for Fleet API calls."""

    def __init__(self, code: str, message: str, status: int | None = None) -> None:
        """Store a short code, message and the HTTP status."""
        super().__init__(message)
        self.code = code
        self.status = status


class FleetAuthError(FleetError):
    """The access token was rejected (401)."""


class FleetVehicleOffline(FleetError):
    """The vehicle is asleep or offline (408 from vehicle endpoints)."""


class FleetRateLimited(FleetError):
    """HTTP 429. ``retry_after`` is seconds, when Tesla sent one."""

    def __init__(self, message: str, retry_after: int | None) -> None:
        """Store the retry hint."""
        super().__init__("rate_limited", message, 429)
        self.retry_after = retry_after


class CommandsDisabled(FleetError):
    """Read-only mode: commands are off in the options."""


def check_proxy_url(url: str) -> str:
    """Return a normalized proxy URL or raise ValueError.

    https always; plain http only for loopback hosts (local proxy or tests).
    Mirrors the Node server's checkUrl.
    """
    url = url.strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("invalid_url")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("invalid_url")
    if parts.scheme == "http":
        host = parts.hostname
        loopback = host == "localhost"
        if not loopback:
            try:
                loopback = ipaddress.ip_address(host).is_loopback
            except ValueError:
                loopback = False
        if not loopback:
            raise ValueError("http_not_loopback")
    return url


def build_ssl_context(ca_cert_path: str | None) -> ssl.SSLContext | None:
    """Build an SSL context trusting an extra CA (blocking; run in executor)."""
    if not ca_cert_path:
        return None
    return ssl.create_default_context(cafile=ca_cert_path)


class FleetClient:
    """Thin wrapper over aiohttp with a token getter supplied by OAuth2Session."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        token_getter: Callable[[], Awaitable[str]],
        base_url: str,
        *,
        commands_enabled: bool = False,
        proxy_url: str | None = None,
        proxy_ssl: ssl.SSLContext | None = None,
    ) -> None:
        """Initialize the client."""
        self._session = session
        self._token = token_getter
        self.base_url = base_url.rstrip("/")
        self.commands_enabled = commands_enabled
        self.proxy_url = proxy_url.rstrip("/") if proxy_url else None
        self._proxy_ssl = proxy_ssl

    async def _request(
        self,
        method: str,
        url: str,
        json: dict[str, Any] | None = None,
        ssl_ctx: ssl.SSLContext | None = None,
    ) -> Any:
        token = await self._token()
        headers = {"Authorization": f"Bearer {token}"}
        kwargs: dict[str, Any] = {
            "headers": headers,
            "timeout": aiohttp.ClientTimeout(total=HTTP_TIMEOUT.total_seconds()),
        }
        if json is not None:
            kwargs["json"] = json
        if ssl_ctx is not None:
            kwargs["ssl"] = ssl_ctx
        try:
            async with self._session.request(method, url, **kwargs) as resp:
                try:
                    body = await resp.json(content_type=None)
                except (ValueError, aiohttp.ContentTypeError):
                    body = None
                status = resp.status
                retry_after = resp.headers.get("Retry-After")
        except (aiohttp.ClientError, TimeoutError) as err:
            raise FleetError("network", f"request failed: {type(err).__name__}") from err

        if status == 401:
            raise FleetAuthError("unauthorized", "token rejected", status)
        if status == 408:
            raise FleetVehicleOffline("vehicle_offline", "vehicle is offline or asleep", status)
        if status == 429:
            after = int(retry_after) if retry_after and retry_after.isdigit() else None
            raise FleetRateLimited("rate limited", after)
        if status >= 400:
            msg = ""
            if isinstance(body, dict):
                msg = str(body.get("error") or body.get("error_description") or "")
            raise FleetError("http_error", f"HTTP {status} {msg}".strip(), status)
        if isinstance(body, dict) and "response" in body:
            return body["response"]
        return body

    # Reads -----------------------------------------------------------------

    async def vehicles(self) -> list[dict[str, Any]]:
        """GET /api/1/vehicles. Never wakes the car."""
        res = await self._request("GET", f"{self.base_url}/api/1/vehicles")
        return res if isinstance(res, list) else []

    async def vehicle(self, vin: str) -> dict[str, Any]:
        """GET /api/1/vehicles/{vin}: summary incl. state. Never wakes the car."""
        res = await self._request("GET", f"{self.base_url}/api/1/vehicles/{quote(vin)}")
        return res if isinstance(res, dict) else {}

    async def vehicle_data(self, vin: str, endpoints: list[str]) -> dict[str, Any]:
        """GET vehicle_data (billed). Callers only use it while the car is online."""
        q = quote(";".join(endpoints), safe="")
        res = await self._request(
            "GET",
            f"{self.base_url}/api/1/vehicles/{quote(vin)}/vehicle_data?endpoints={q}",
        )
        return res if isinstance(res, dict) else {}

    # Writes (user-pressed entities only) ------------------------------------

    def _require_commands(self) -> None:
        if not self.commands_enabled:
            raise CommandsDisabled("commands_disabled", "commands are off (read-only mode)")

    async def wake_up(self, vin: str) -> dict[str, Any]:
        """POST wake_up (billed as a wake). Only from the Wake button."""
        self._require_commands()
        res = await self._request(
            "POST", f"{self.base_url}/api/1/vehicles/{quote(vin)}/wake_up", json={}
        )
        return res if isinstance(res, dict) else {}

    async def command(self, vin: str, name: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST a signed vehicle command through the configured command proxy."""
        self._require_commands()
        if not self.proxy_url:
            raise FleetError("no_proxy", "no command proxy configured")
        if not re.fullmatch(r"[a-z_]+", name):
            raise FleetError("bad_command", "invalid command name")
        res = await self._request(
            "POST",
            f"{self.proxy_url}/api/1/vehicles/{quote(vin)}/command/{name}",
            json=body or {},
            ssl_ctx=self._proxy_ssl,
        )
        if isinstance(res, dict) and res.get("result") is False:
            raise FleetError("rejected", f"vehicle refused: {res.get('reason') or 'no reason given'}")
        return res if isinstance(res, dict) else {}


async def detect_base_url(
    session: aiohttp.ClientSession, token_getter: Callable[[], Awaitable[str]]
) -> tuple[str | None, str]:
    """Auto-detect the account region via /api/1/users/region (na, then eu)."""
    last: Exception | None = None
    for region in AUTO_DETECT_REGIONS:
        client = FleetClient(session, token_getter, REGION_BASE_URLS[region])
        try:
            res = await client._request("GET", f"{client.base_url}/api/1/users/region")
        except FleetAuthError:
            raise
        except FleetError as err:
            last = err
            continue
        url = res.get("fleet_api_base_url") if isinstance(res, dict) else None
        if not isinstance(url, str) or not re.fullmatch(BASE_URL_PATTERN, url):
            last = FleetError("bad_region", "region endpoint returned an unexpected base URL")
            continue
        reg = res.get("region") if isinstance(res.get("region"), str) else None
        return reg, url
    LOGGER.debug("Region auto-detect failed: %s", last)
    raise last or FleetError("bad_region", "region detection failed")
