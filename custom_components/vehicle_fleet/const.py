"""Constants for the Grok Bot Vehicle Fleet integration."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Final

DOMAIN: Final = "vehicle_fleet"
LOGGER = logging.getLogger(__package__)

# OAuth endpoints (developer.tesla.com, Third-Party Tokens). Same hosts the Node
# MCP server and its auth helper use.
AUTHORIZE_URL: Final = "https://auth.tesla.com/oauth2/v3/authorize"
TOKEN_URL: Final = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token"

# Read scopes plus command scopes. Commands still stay off until the user turns
# them on in the options flow; the scopes only make that possible without a new
# sign-in.
SCOPES: Final = [
    "openid",
    "offline_access",
    "vehicle_device_data",
    "vehicle_location",
    "vehicle_cmds",
    "vehicle_charging_cmds",
]

# Documented regional Fleet API base URLs (mirrors mcp/vehicle-fleet/src/config.ts).
REGION_BASE_URLS: Final[dict[str, str]] = {
    "na": "https://fleet-api.prd.na.vn.cloud.tesla.com",
    "eu": "https://fleet-api.prd.eu.vn.cloud.tesla.com",
    "cn": "https://fleet-api.prd.cn.vn.cloud.tesla.cn",
}
REGION_AUTO: Final = "auto"
# Regions probed for /api/1/users/region when the region is "auto" (same as Node).
AUTO_DETECT_REGIONS: Final = ("na", "eu")
# A region endpoint answer must look like a Fleet API host before it is used.
BASE_URL_PATTERN: Final = r"^https://fleet-api\.prd\.[a-z]+\.vn\.cloud\.tesla\.(com|cn)$"

CONF_REGION: Final = "region"
CONF_BASE_URL: Final = "base_url"

# Options
CONF_COMMANDS_ENABLED: Final = "commands_enabled"
CONF_PROXY_URL: Final = "proxy_url"
CONF_PROXY_CA_CERT: Final = "proxy_ca_cert"
CONF_LOCATION: Final = "location"
CONF_SCAN_INTERVAL_MIN: Final = "scan_interval_minutes"

DEFAULT_SCAN_INTERVAL_MIN: Final = 15
MIN_SCAN_INTERVAL_MIN: Final = 5
MAX_SCAN_INTERVAL_MIN: Final = 1440

HTTP_TIMEOUT: Final = timedelta(seconds=30)

STATE_ONLINE: Final = "online"
STATE_ASLEEP: Final = "asleep"
STATE_OFFLINE: Final = "offline"
VEHICLE_STATES: Final = [STATE_ONLINE, STATE_ASLEEP, STATE_OFFLINE]

# vehicle_data endpoints read when the car is online.
ENDPOINTS: Final = [
    "charge_state",
    "climate_state",
    "drive_state",
    "vehicle_state",
    "vehicle_config",
]
LOCATION_ENDPOINT: Final = "location_data"

STORAGE_VERSION: Final = 1
