# Changelog

## 0.1.0 (unreleased)

- First scaffold: one `vehicle-fleet` stdio MCP server, five skills, three manifests (Grok Build, Grok Bot/root, Cursor) and two MCP configs.
- Read tools (cached-first, never wake), opt-in coarse location, confirm-gated command tools hidden unless `TESLA_FLEET_READ_ONLY` is explicitly off (fails closed).
- TokenManager with single-flight refresh and atomic, locked, persisted refresh-token rotation; access tokens memory-only.
- Command proxy with configured CA (TLS never disabled); key-pairing and online pre-checks; no automatic retries.
- Local rate buckets under the documented per-vehicle limits; Fleet API error mapping.
- Optional operator-run `scripts/auth-helper.mjs`.
- Tests: unit (mocked HTTP) + MCP stdio smoke against a local fake server; CI on ubuntu + windows.
