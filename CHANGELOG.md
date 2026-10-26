# Changelog

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
