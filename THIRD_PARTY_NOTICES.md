# Third-party notices

## Runtime dependencies (npm, `mcp/vehicle-fleet`)

| Package | License |
|---|---|
| `@modelcontextprotocol/sdk` | MIT |
| `undici` | MIT |

Development only: `typescript` (Apache-2.0), `tsx` (MIT), `@types/node` (MIT). Transitive dependencies are listed with their licenses in `mcp/vehicle-fleet/package-lock.json`.

## Not bundled

- `tesla-http-proxy` from `teslamotors/vehicle-command` (Apache-2.0) - run by the installer; not downloaded, built, or redistributed by this plugin.

## Protocol details and test vectors (Apache-2.0)

`mcp/vehicle-fleet/src/signed/` implements the Vehicle Command Protocol (session handshake, HMAC-SHA256 command authentication, AES-GCM response decryption) in TypeScript from the specification and reference implementation in `teslamotors/vehicle-command` (Copyright Tesla, Inc., Apache License 2.0): protobuf field numbers and enum values from `pkg/protocol/protobuf/*.proto`, the algorithm from `pkg/protocol/protocol.md` and `internal/authentication`. `test/signed.test.ts` uses the published debug keys and worked examples from `protocol.md`, and expected values produced by running that repository's Go code. No Go code or `.proto` file is copied.

`VehicleAction.videoRequestAction = 57` (`VideoRequestAction { string url = 1; }`) and `dashcamSaveClipAction = 47` are not in Tesla's published protos; their field numbers follow `Teslemetry/tesla-protocol` (Apache License 2.0), which marks them as extensions. Only the field numbers are used.

## Prior art (ideas only, no code copied)

- `pjordan/tesla-fleet-mcp` (MIT)
- `tylergibbs1/tesla-mcp-server` (MIT)

If any code from these projects is adapted in the future, its MIT copyright and permission notice will be reproduced here.
