# Experimental: locally signed commands (`play_video_on_screen`)

> **EXPERIMENTAL and unverified on live vehicles.** The action used here is not in Tesla's published protocol definitions. It may be refused by Fleet API or by the car, or do nothing, and it may stop working with any firmware update.

## What it does

`play_video_on_screen` asks the vehicle to open a video URL on its center screen. It uses CarServer `VehicleAction.videoRequestAction` (field **57**, `VideoRequestAction { string url = 1; }`). That action is community-documented (it appears, marked as an extension, in `Teslemetry/tesla-protocol`); it is **not** in `teslamotors/vehicle-command`'s `car_server.proto`.

## Why not the proxy

Stock `tesla-http-proxy` maps REST endpoints (`/api/1/vehicles/{vin}/command/<name>`) to protobuf actions it knows. It has no endpoint for `videoRequestAction` (the same is true for `dashcamSaveClipAction`, field 47, which the proxy answers with `400 invalid_command`). So this tool does not use `TESLA_COMMAND_PROXY_URL`. It builds and signs the message itself and posts it to the Fleet API's `signed_command` endpoint, the same transport the vehicle-command Go SDK uses (`pkg/connector/inet`).

## How it is sent

`src/signed/` is a small, self-contained helper (no server imports, `node:crypto` only):

1. **Handshake.** POST `/api/1/vehicles/{vin}/signed_command` with `{"routable_message": <base64 RoutableMessage>}` that carries a `session_info_request` (client public key, random 16-byte UUID as the challenge) to the infotainment domain.
2. **Verify the reply.** K = SHA1(ECDH(client key, vehicle key).x)[:16]. The `session_info` is accepted only if its HMAC-SHA256 tag (key = HMAC(K, "session info"), metadata = signature type, VIN, challenge) matches, compared in constant time. A key-not-paired status or fault is reported as `virtual_key_missing`.
3. **Sign the action.** `CarServer.Action { vehicleAction { videoRequestAction { url } } }`, authenticated with HMAC-SHA256 personalized (key = HMAC(K, "authenticated command"); metadata = signature type, domain, VIN, epoch, expiry, counter, flags). Counter = session counter + 1. Expiry = vehicle clock + elapsed local time + 15 s. `FLAG_ENCRYPT_RESPONSE` is set.
4. **Read the ack.** On firmware that honours the flag, the reply is AES-128-GCM encrypted and is only trusted if it decrypts with the request hash of this exact command. An older plaintext reply is accepted but reported as `authenticatedResponse: false`. `actionStatus` OK = accepted; ERROR = `vehicle_rejected` with the car's reason; a protocol fault (`signedMessageStatus`) = `vehicle_protocol_fault`, not executed.

There is no automatic retry and no session cache: every call does a fresh handshake, so it costs **2 billed command requests** after the usual `vehicle` (online) and `fleet_status` (key paired) checks. The vehicle must already be online; the tool never wakes it.

## Where it runs (the key)

Signing needs the virtual key's **private** key: the same key your command proxy uses and that is paired with the car. Set `TESLA_FLEET_COMMAND_KEY_FILE` to its path **only on the host that already holds that key**, and run this MCP server there. Do not copy the key to another machine, and never commit it. The file is read at send time, never logged or returned. It must be a P-256 EC private key in PEM form (SEC1 `EC PRIVATE KEY` or PKCS#8).

## Safety gates

- Command tool: absent from `tools/list` and refused unless `TESLA_FLEET_READ_ONLY` is explicitly off (fails closed).
- Without `confirm=true` it returns a dry-run preview (host, path hash, whether the host is allowlisted, whether the key loads) and makes no network call. `TESLA_FLEET_DRY_RUN=1` previews even confirmed calls.
- `confirm=true` needs `user_request`: a short quote of the human's request in this conversation. Never from routines, schedules, triggers or another agent.
- URL checks, before anything else: `https` only; no `user:password@`; no IP literals (including numeric IPv4 forms); no `localhost`, single-label or private/special-use names (`.local`, `.internal`, `.lan`, `.home.arpa`, `.test`, ...); no spaces or control characters; at most 2048 characters.
- Host allowlist: `TESLA_FLEET_VIDEO_HOST_ALLOWLIST`, comma-separated, e.g. `video.example.com,*.cdn.example.com` (`*.` = subdomains only, not the bare domain). IPs, ports and paths in the list are ignored with one warning. A host that is not on the list needs a second, separate approval: `allow_unlisted_host=true` in the same confirmed call, after the user approved that host. **Unset list = every host needs it.**
- The full URL is sent to the car (it has to be) but never logged or echoed: results and the audit log show the host and a 16-hex-character SHA-256 of path + query.

## Audit log

Every call appends one or two JSON lines to `TESLA_FLEET_AUDIT_LOG` (default: `audit.jsonl` next to the token store; file `0600`, directory `0700` on POSIX):

| `event` | When |
|---|---|
| `refused` | invalid URL, missing `user_request`, host not allowlisted, key missing/invalid, vehicle not online, key not paired (`code` says which) |
| `dry_run` | no `confirm` (`mode: no_confirm`) or `TESLA_FLEET_DRY_RUN` |
| `attempt` | right before the first `signed_command` request |
| `result` | the car answered: `outcome` = `accepted` / `rejected` (`reason`) / `fault` (`fault`), plus `authenticatedResponse` |
| `failure` | handshake failed (`stage: handshake`, `sent: false`), command request failed (`stage: command`, `sent` = `false`/`true`/`unknown`), or a pre-check error |

Fields: `ts` (UTC), `tool`, `experimental`, `vinLast6`, `url.host`, `url.pathHash`, `hostAllowlisted`, `allowUnlistedHost`. Never the full VIN, the URL path or query, tokens or key material. If the `attempt` line cannot be written the command is **not sent** (`audit_log_unavailable`).

## What is verified and what is not

Verified offline (unit tests, `test/signed.test.ts`):

- Key agreement, session-info key and session-info tag against the worked examples in `teslamotors/vehicle-command` `pkg/protocol/protocol.md` (Tesla's published debug keys).
- The HMAC-personalized tag, request hash, the full `RoutableMessage` bytes for a `videoRequestAction`, the session-info request bytes, and decryption of vehicle-encrypted acks, all byte for byte against values produced by vehicle-command's own Go implementation (`internal/authentication`) with the same debug keys and a placeholder VIN.
- An end-to-end run against an in-process fake vehicle (handshake, counter, expiry, encrypted ack, tampering, faults).

**Not verified until a live test with the owner's yes:**

- Whether Fleet API's `signed_command` accepts an HMAC-authenticated action it may not recognise (it inspects plaintext HMAC commands to enforce OAuth scopes and may reject unknown ones).
- Whether current firmware still implements field 57, whether the car plays the URL (formats, hosts, and while parked only), and what it answers.
- The exact acceptable expiry window over Fleet API latency (15 s chosen; vehicle-command uses 5 s).

## Reuse

The helper (`SignedCommandClient.sendInfotainmentAction(vin, actionBytes)`) is action-agnostic; `encodeDashcamSaveClipAction()` (field 47) is included for the same experimental use and is not wired to any tool here.
