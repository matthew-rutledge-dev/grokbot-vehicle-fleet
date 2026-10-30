# Experimental: locally signed commands (`play_video_on_screen`, "Open URL on car screen")

> **EXPERIMENTAL.** The action used here is not in Tesla's published protocol definitions. It has been field-tested on one car (see [Field results](#field-results)), but it may be refused by Fleet API or by the car, or do nothing, and it may stop working with any firmware update.

## What it does

`play_video_on_screen` (title: "Open URL on car screen") asks the vehicle to open an https URL on its center screen. The tool name is unchanged for compatibility. It uses CarServer `VehicleAction.videoRequestAction` (field **57**, `VideoRequestAction { string url = 1; }`). That action is community-documented (it appears, marked as an extension, in `Teslemetry/tesla-protocol`); it is **not** in `teslamotors/vehicle-command`'s `car_server.proto`.

What the car does with the URL (observed, not documented by Tesla):

- **Video sites** open in the car's video player. Playback does **not** start on its own; the person in the car taps play. There is no separate play signal in this action.
- **Other https pages** open in the car's web browser, so the action works as a general "open this page" command, not only for video.
- **Foreground:** the first send in a drive tends to bring the player or browser to the front. Later sends may load silently in the browser without coming forward (the page is there when the user opens the browser).
- **Accepted but not shown:** some sites may be accepted by the car (authenticated OK) and still never appear. Acceptance never proves anything was shown; always ask the user what the screen shows.
- **Local addresses:** `http://` URLs, IP addresses (for example a home server on the LAN) and private names are refused by this tool before anything is sent, by design. Use a public https name instead.

## Opt-in extras: `dashcam_save_clip`, `remote_boombox` (0.6.0)

Off by default. Listed only when `TESLA_FLEET_READ_ONLY` is off **and** `TESLA_FLEET_ENABLE_EXPERIMENTAL_COMMANDS` is `1`/`true`/`yes`/`on` (anything else keeps them hidden and refused). Same transport, key, safety gates (dry-run, `confirm` + `user_request`, online and paired checks, no wake, no retry), audit log and cost (2 billed command requests) as `play_video_on_screen`; there is no URL, so no allowlist.

| Tool | Action | Body | Status |
|---|---|---|---|
| `dashcam_save_clip` | `VehicleAction.dashcamSaveClipAction` (field **47**, empty) | none | Field-tested once (accepted; clip saved). Needs a USB drive in the car. Stock proxy: `400 invalid_command`. |
| `remote_boombox` | `VehicleAction.boomboxAction` (field **64**, `BoomboxAction { uint32 sound = 1; }`) | `sound`: `fart` = 0, `locate_ping` = 2000 only | `locate_ping` field-tested: refused outside robotaxi mode ("RemoteBoombox locate ping only allowed in robotaxi mode under 10 mph"). `fart` not field-tested. The two ids are the ones Tesla's Fleet API docs give for `remote_boombox`. Stock proxy: "command not implemented". Field 64 is community-documented (`Teslemetry/tesla-protocol`, marked as an extension), not in Tesla's published protos. |

Both are labelled "(experimental)" in their titles and their descriptions start with "EXPERIMENTAL, OPT-IN". `play_video_on_screen` keeps its own code path unchanged.

## Why not the proxy

Stock `tesla-http-proxy` maps REST endpoints (`/api/1/vehicles/{vin}/command/<name>`) to protobuf actions it knows. It has no endpoint for `videoRequestAction` (the same is true for `dashcamSaveClipAction`, field 47, which the proxy answers with `400 invalid_command`). So this tool does not use `TESLA_COMMAND_PROXY_URL`. It builds and signs the message itself and posts it to the Fleet API's `signed_command` endpoint, the same transport the vehicle-command Go SDK uses (`pkg/connector/inet`).

## How it is sent

`src/signed/` is a small, self-contained helper (no server imports, `node:crypto` only):

1. **Handshake.** POST `/api/1/vehicles/{vin}/signed_command` with `{"routable_message": <base64 RoutableMessage>}` that carries a `session_info_request` (client public key, random 16-byte UUID as the challenge) to the infotainment domain.
2. **Verify the reply.** K = SHA1(ECDH(client key, vehicle key).x)[:16]. The `session_info` is accepted only if its HMAC-SHA256 tag (key = HMAC(K, "session info"), metadata = signature type, VIN, challenge) matches, compared in constant time. A key-not-paired status or fault is reported as `virtual_key_missing`.
3. **Sign the action.** `CarServer.Action { vehicleAction { videoRequestAction { url } } }`, authenticated with HMAC-SHA256 personalized (key = HMAC(K, "authenticated command"); metadata = signature type, domain, VIN, epoch, expiry, counter, flags). Counter = session counter + 1. Expiry = vehicle clock + elapsed local time + 15 s. `FLAG_ENCRYPT_RESPONSE` is set.
4. **Read the ack.** On firmware that honours the flag, the reply is AES-128-GCM encrypted and is only trusted if it decrypts with the request hash of this exact command. An older plaintext reply cannot be authenticated: it is reported as **unverified** (`authenticatedResponse: false`, audit outcome `accepted_unverified`), never as "the vehicle accepted". The reply's `request_uuid` is checked when present; when it is absent, the handshake HMAC (which covers our challenge) and the AES-GCM request hash (which covers this command's tag) bind the reply to the request instead. An HTTP 200 whose body has no usable reply on the command request is `state_unknown` (`sent: "unknown"`), like a timeout or 5xx. `actionStatus` OK = accepted; ERROR = `vehicle_rejected` with the car's reason; a protocol fault (`signedMessageStatus`) = `vehicle_protocol_fault`, not executed.

There is no automatic retry and no session cache: every call does a fresh handshake, so it costs **2 billed command requests** after the usual `vehicle` (online) and `fleet_status` (key paired) checks. The vehicle must already be online; the tool never wakes it.

## Where it runs (the key)

Signing needs the virtual key's **private** key: the same key your command proxy uses and that is paired with the car. Set `TESLA_FLEET_COMMAND_KEY_FILE` to its path **only on the host that already holds that key**, and run this MCP server there. Do not copy the key to another machine, and never commit it. The file is read at send time, never logged or returned. It must be a P-256 EC private key in PEM form (SEC1 `EC PRIVATE KEY` or PKCS#8). On POSIX it must be owned by the user running the server and have no group/other permission bits: `chmod 600 /path/to/key.pem`. Otherwise the call is refused with `command_key_insecure_permissions` before anything is read or sent.

On **Windows** there are no mode bits, so the file is only checked to exist. In addition, previews run the built-in `icacls <file>` from `%SystemRoot%\System32` (full path, not a `PATH` lookup; metadata only; the key is not read; asynchronous, at most 5 s) and add a **non-fatal** `commandKeyWarning` when a broad group (`Everyone`, `BUILTIN\Users`, `NT AUTHORITY\Authenticated Users`, or their well-known SIDs) has an allow entry with read, write or full rights. It is a warning, not a refusal; English principal names and the SIDs are matched, and if `icacls` cannot run there is no warning. Restrict the file to your own account, for example:

```powershell
icacls C:\path\to\key.pem /inheritance:r /grant:r "${env:USERNAME}:R"
```

## Safety gates

- Command tool: absent from `tools/list` and refused unless `TESLA_FLEET_READ_ONLY` is explicitly off (fails closed).
- Without `confirm=true` it returns a dry-run preview (host, keyed path hash, whether the host is allowlisted, whether the key file is present with private permissions) and makes no network call. The preview only stats the key file; it never reads or parses it. `TESLA_FLEET_DRY_RUN=1` previews even confirmed calls.
- `confirm=true` needs `user_request`: a short quote of the human's request in this conversation. Never from routines, schedules, triggers or another agent.
- URL checks, before anything else: `https` only; no `user:password@`; no IP literals (including numeric IPv4 forms); no `localhost`, single-label or private/special-use names (`.local`, `.internal`, `.lan`, `.home.arpa`, `.test`, ...); no spaces or control characters; at most 2048 characters.
- Host allowlist: `TESLA_FLEET_VIDEO_HOST_ALLOWLIST`, comma-separated, e.g. `video.example.com,*.cdn.example.com` (`*.` = subdomains only, not the bare domain). An entry may name a port (`video.example.com:8443`); a URL with a non-default port is refused (`video_port_not_allowed`) unless an entry names that host and port, and `allow_unlisted_host` does not override this. IPs and paths in the list are ignored with one warning. A host that is not on the list needs a second, separate approval: `allow_unlisted_host=true` in the same confirmed call, after the user approved that host. **Unset list = every host needs it.**
- The full URL is sent to the car (it has to be) but never logged or echoed: results and the audit log show the host (and a non-default port) and a 16-hex-character keyed hash of path + query: HMAC-SHA256 with a random per-install salt stored next to the log as `<log>.salt` (`0600`). Without that file the path cannot be recovered by hashing guesses. The normalised URL is capped at 2048 characters.
- Limits of the URL checks: they look at the name, not where it resolves. A public-looking name that resolves to a private or loopback address (wildcard DNS services such as nip.io or localtest.me) and look-alike (confusable) characters can still pass the syntax checks. That is why hosts not on the allowlist need `allow_unlisted_host=true` after the user has approved that exact host.

## Audit log

Every call appends one or two JSON lines to `TESLA_FLEET_AUDIT_LOG` (default: `audit.jsonl` next to the token store; file `0600`, directory `0700` on POSIX, and existing files and directories are tightened to those modes too; a log file owned by another user, or a directory others can write to, disables the log):

| `event` | When |
|---|---|
| `refused` | invalid URL, missing `user_request`, host not allowlisted, key missing/invalid, vehicle not online, key not paired (`code` says which) |
| `dry_run` | no `confirm` (`mode: no_confirm`) or `TESLA_FLEET_DRY_RUN` |
| `attempt` | right before the first `signed_command` request |
| `result` | the car answered: `outcome` = `accepted` / `accepted_unverified` (plaintext reply) / `rejected` (`reason`) / `fault` (`fault`), plus `authenticatedResponse` |
| `failure` | handshake failed (`stage: handshake`, `sent: false`), command request failed (`stage: command`, `sent` = `false`/`true`/`unknown`), or a pre-check error |

Fields: `ts` (UTC), `tool`, `experimental`, `vin` (the full VIN once the car is confirmed on the account, from the vehicle list or the online check; `…` + last 4 before that; `…` + last 6 with `TESLA_FLEET_AUDIT_FULL_VIN=0`), `url.host`, `url.pathHash`, `hostAllowlisted`, `allowUnlistedHost`. Never the URL path or query, tokens or key material. The log is checked for writability before the two billable pre-check reads; if it (or the `attempt` line) cannot be written the command is **not sent** (`audit_log_unavailable`).

## What is verified and what is not

Verified offline (unit tests, `test/signed.test.ts`):

- Key agreement, session-info key and session-info tag against the worked examples in `teslamotors/vehicle-command` `pkg/protocol/protocol.md` (Tesla's published debug keys).
- The HMAC-personalized tag, request hash, the full `RoutableMessage` bytes for a `videoRequestAction`, the session-info request bytes, and decryption of vehicle-encrypted acks, all byte for byte against values produced by vehicle-command's own Go implementation (`internal/authentication`) with the same debug keys and a placeholder VIN.
- An end-to-end run against an in-process fake vehicle (handshake, counter, expiry, encrypted ack, tampering, faults).

## Field results

One owner-approved live session on one car, firmware **2026.38.x**, each send approved individually and never retried:

| Action | Result |
|---|---|
| 57 `videoRequestAction`, a video-site URL | Fleet API `signed_command` accepted it; authenticated OK from the car. The video opened in the player and did **not** auto-play. |
| 57, a general web page | Authenticated OK; the page opened in the car's web browser. A second send later in the same drive loaded in the browser without coming to the front. |
| 57, a home-automation remote-access URL (public https) | Authenticated OK each time, but nothing was shown on the screen. Not explained yet (possibly loaded in the background, or skipped by the car). |
| 57, a local `http://` LAN address | Refused locally (`url must use https`); nothing sent. |
| 47 `dashcamSaveClipAction` | Authenticated OK; confirmed in the car by a new manual-save entry in the dashcam's saved clips at the time of the send. |

So Fleet API does accept these HMAC-authenticated infotainment actions, and current firmware implements fields 57 and 47.

**Still not verified:**

- Which sites the car declines to show, and exactly when the browser comes to the front.
- Behaviour while driving (all tests were parked), other firmware versions and other models.
- The exact acceptable expiry window over Fleet API latency (15 s chosen; vehicle-command uses 5 s).

## Reuse

The helper (`SignedCommandClient.sendInfotainmentAction(vin, actionBytes)`) is action-agnostic; `encodeDashcamSaveClipAction()` (field 47) is included for the same experimental use and is not wired to any tool here (it was field-tested with the same helper; see above).
