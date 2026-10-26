# Changelog

## 0.2.1 (unreleased)

Dependency updates.

- undici 8, TypeScript 7, @types/node 26.
- Node.js 22.19 or newer is now required (`engines` `>=22.19`; undici 8 needs it).
- README: dependency policy (latest versions, majors when CI passes, pins only with a stated reason, bump `engines` with dependencies).

## 0.2.0 (unreleased)

Energy-site reads (Powerwall / solar; Wall Connector via site live status). Read-only; no energy commands.

- New read tools: `list_energy_sites` (`GET /api/1/products`, vehicles filtered out, gateway ids dropped), `get_energy_live_status` (power flows, battery %, grid/island status, storm watch, plus `wall_connectors` state and power; cached 60 s), `get_energy_site_info` (backup reserve, operation mode, storm watch, export rule, battery count, nameplate; address and tariff fields are not returned; cached 10 min) and `get_energy_history` (`calendar_history`, `kind=energy` totals or `kind=backup` events; bounded ranges per period; validated before any call; cached 5 min).
- Site resolution: explicit `energy_site_id` > `TESLA_DEFAULT_ENERGY_SITE_ID` > the only site; the product list is reused for 5 minutes.
- `percentage_charged` is rounded to one decimal; live status includes a power sign note.
- Only scope-related 403s map to `missing_scope` (energy calls: `missing_energy_scope` with the re-consent hint); other 403s stay a generic `forbidden`.
- `energy_site_id` must be a string of digits; numbers are refused, and an unsafe numeric id from the API is refused instead of rounded.
- Auth helper: `url --energy` or `TESLA_AUTH_ENERGY=1` adds the `energy_device_data` scope. The default scopes are unchanged.
- Energy reads are counted as `data` in `get_api_usage`.
- Tool counts: 15 read-only (11 vehicle + 4 energy), 26 with commands on.
- Manifests, MCP configs, README, skills and troubleshooting reference updated.

## 0.1.2 (unreleased)

Fixes from the first read-only live test.

- VIN resolution reuses the vehicle list for 5 minutes instead of listing vehicles again on every read (saves one billable call per tool call when no default VIN is set). `list_vehicles` still fetches a fresh list.
- `TESLA_FLEET_CLIENT_ID`, `TESLA_FLEET_CLIENT_SECRET` and `TESLA_FLEET_PROXY_URL` are accepted as aliases (server and auth helper); the primary `TESLA_*` name wins. Both MCP configs pass the aliases through.
- `api_status` returns Tesla's plain-text status body (`ok`) instead of a `non_json_response` error object. Plain-text success bodies are kept as text; error bodies keep the structured shape.
- `get_closures` reports `windowsOpen` as unknown when the data source has no window fields (cached data often omits them) instead of an empty object.
- Docs: PowerShell env loaders should run under PowerShell 7 (`pwsh`).

## 0.1.1 (unreleased)

Review fixes.

- Node.js 22 or newer is now required (`engines` `>=22`); Node 20 is end of life.
- CI runs on Node 22 and 24 (ubuntu + windows), with workflow concurrency (cancel in progress) and a 15-minute job timeout.
- Broader token redaction: error output and startup stderr also redact the stored, spent and rotated refresh tokens and the in-memory access token, not only the `TESLA_REFRESH_TOKEN` seed.
- Bootstrap scripts and CI install with `npm ci --ignore-scripts`.
- Dependabot: weekly updates for GitHub Actions and npm.

## 0.1.0 (unreleased)

- First scaffold: one `vehicle-fleet` stdio MCP server, five skills, three manifests (Grok Build, Grok Bot/root, Cursor) and two MCP configs.
- Read tools (cached-first, never wake), opt-in coarse location, confirm-gated command tools hidden unless `TESLA_FLEET_READ_ONLY` is explicitly off (fails closed).
- TokenManager with single-flight refresh and atomic, locked, persisted refresh-token rotation; access tokens memory-only.
- Command proxy with configured CA (TLS never disabled); key-pairing and online pre-checks; no automatic retries.
- Local rate buckets under the documented per-vehicle limits; Fleet API error mapping.
- Optional operator-run `scripts/auth-helper.mjs`.
- Local Fleet API usage counter and `get_api_usage` read tool: counts every Fleet API / proxy response by pricing category (data, command, wake; `other` kept apart and not priced; `auth` info only), billable (<500) vs not billed (>=500), UTC month buckets persisted to `usage.json` next to the token store (totals only), estimated cost before/after the monthly discount. Rates overridable via `TESLA_FLEET_RATE_*` and `TESLA_FLEET_MONTHLY_DISCOUNT_USD`. Local estimate only; the developer portal billing page is the source of truth.
- Tool counts: 11 read-only, 22 with commands on (+ `get_location` when enabled).
- Tests: unit (mocked HTTP) + MCP stdio smoke against a local fake server; CI on ubuntu + windows.
