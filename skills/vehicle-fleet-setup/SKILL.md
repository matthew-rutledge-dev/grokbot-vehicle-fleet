---
name: vehicle-fleet-setup
description: use this only when the operator explicitly asks to set up or reconfigure the vehicle-fleet plugin (developer app, public key, OAuth refresh token, command proxy, virtual key pairing, plugin variables)
---

# Vehicle fleet setup (operator-driven)

Never run silently. Never ask for secrets in chat; the operator sets plugin variables (or host secrets) and runs commands in their own terminal. Placeholders below: `example-user`, `keys.example.com`, `https://proxy.example.com`, `5YJ000000EXAMPLE`.

## 1. Developer app (operator, on developer.tesla.com)

- Create an application; note the client ID (and secret).
- Generate a key pair (`openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem`; `openssl ec -in private-key.pem -pubout -out public-key.pem`).
- Host the public key at `https://keys.example.com/.well-known/appspecific/com.tesla.3p.public-key.pem`. Keep the private key secret (it stays with the proxy).
- Register the partner account in each region you use (partner register endpoint; a `412` later means this step is missing).
- Set a **billing limit** on the developer portal.

## 2. First refresh token

Pick the smallest scopes: read-only = `openid offline_access vehicle_device_data vehicle_location` (the default token now includes `vehicle_location`; turning location off on the server with `TESLA_FLEET_ENABLE_LOCATION=0` does not remove the scope, so re-run `url --no-location` and sign in once to drop it); add `energy_device_data` only for Powerwall/solar reads (`url --energy` or `TESLA_AUTH_ENERGY=1`); Command scopes are opt-in: `url --commands` (or `TESLA_AUTH_COMMANDS=1`) adds `vehicle_cmds` and `vehicle_charging_cmds`; `url --energy-commands` (or `TESLA_AUTH_ENERGY_COMMANDS=1`) adds `energy_cmds` for Powerwall settings.

```bash
export TESLA_CLIENT_ID=...        # in your terminal, not in chat
export TESLA_CLIENT_SECRET=...
export TESLA_REDIRECT_URI=http://localhost:8765/callback   # must be registered on the app
export TESLA_AUTH_SCOPES="openid offline_access vehicle_device_data vehicle_location"
node scripts/auth-helper.mjs url
node scripts/auth-helper.mjs exchange "<full redirect URL>"
```

The helper writes the token store (0600) and prints no secrets. Alternatively set `TESLA_REFRESH_TOKEN` as a plugin variable.

## 3. Command proxy (only if vehicle commands are wanted)

Vehicle commands must be signed by Tesla's `tesla-http-proxy` from [teslamotors/vehicle-command](https://github.com/teslamotors/vehicle-command). The operator runs it; the plugin never downloads, builds or starts it. Energy-site commands do not use it. Placeholders: host `proxy.example.com`, port `4443` (Tesla's example), paths under `./config`.

**Security first.** The proxy has no client authentication of its own: anyone who can reach it and holds a valid OAuth token for your account can send commands signed with your key. Bind it to loopback, or to a LAN address with a firewall limiting it to the machine that runs the MCP server. **Never expose it to the internet** (no port forwarding, no public tunnel).

### 3a. Files in `./config`

- `fleet-key.pem`: the private key from step 1 (the one whose public key you host). Keep it `chmod 600`.
- `tls-key.pem` / `tls-cert.pem`: the proxy's TLS server key and certificate chain.

For a self-signed setup, make a small CA and a server cert whose SAN matches the host name the MCP server will use:

```bash
mkdir -p config && cd config
# CA (keep ca-key.pem offline/private)
openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -subj '/CN=Example Proxy CA' -keyout ca-key.pem -out ca-cert.pem -sha256 -days 3650 \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
# Server key + CSR
openssl req -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -subj '/CN=proxy.example.com' -keyout tls-key.pem -out server.csr
# Server cert signed by the CA, SAN = the host name you will put in TESLA_COMMAND_PROXY_URL
printf 'subjectAltName=DNS:proxy.example.com\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyAgreement\n' > server.ext
openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -out tls-cert.pem -days 825 -sha256 -extfile server.ext
chmod 600 ca-key.pem tls-key.pem fleet-key.pem
```

(For `localhost` only, the vehicle-command README's single self-signed `openssl req -x509 ... -subj '/CN=localhost'` command is enough; then `tls-cert.pem` itself is the file to trust.) If you use an IP address instead of a name, use `subjectAltName=IP:<address>`.

### 3b. Run it (official image, pinned)

Use the official Docker image `tesla/vehicle-command`, pinned to a release tag (e.g. `0.4.1`; check the repo's releases) rather than `latest`. The image's entrypoint is `tesla-http-proxy`; the flags below are the ones in the official README (`-tls-key`, `-cert`, `-key-file`, `-host`, `-port`).

```bash
docker run -d --name tesla-http-proxy --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --security-opt=no-new-privileges:true \
  -v "$PWD/config:/config:ro" \
  -p 127.0.0.1:4443:4443 \
  tesla/vehicle-command:0.4.1 \
  -tls-key /config/tls-key.pem -cert /config/tls-cert.pem -key-file /config/fleet-key.pem \
  -host 0.0.0.0 -port 4443
```

**File ownership:** the image runs as a distroless non-root user, so run it as the uid:gid that owns `./config` (as above); otherwise it cannot read the `chmod 600` key files.

`-host 0.0.0.0` is inside the container; the `-p 127.0.0.1:4443:4443` publish is what limits who can reach it. For a LAN-only host, publish on that LAN address instead and firewall it to the MCP machine.

Compose equivalent (the official `docker-compose.yml` uses these environment variables):

```yaml
services:
  tesla_http_proxy:
    image: tesla/vehicle-command:0.4.1
    user: "1000:1000"   # the uid:gid that owns ./config (see `id -u` / `id -g`)
    restart: unless-stopped
    ports:
      - "127.0.0.1:4443:4443"
    environment:
      - TESLA_HTTP_PROXY_TLS_CERT=/config/tls-cert.pem
      - TESLA_HTTP_PROXY_TLS_KEY=/config/tls-key.pem
      - TESLA_HTTP_PROXY_HOST=0.0.0.0
      - TESLA_HTTP_PROXY_PORT=4443
      - TESLA_HTTP_PROXY_TIMEOUT=10s
      - TESLA_KEY_FILE=/config/fleet-key.pem
    security_opt:
      - no-new-privileges:true
    volumes:
      - ./config:/config:ro
```

Without Docker, the same flags work on a release build: `tesla-http-proxy -tls-key config/tls-key.pem -cert config/tls-cert.pem -key-file config/fleet-key.pem -host 127.0.0.1 -port 4443`.

### 3c. Health check (no token, nothing sent to a car)

```bash
# TLS verifies against your CA and the SAN matches; prints OK
curl --cacert config/ca-cert.pem https://proxy.example.com:4443/health
# A request without a token is refused by the proxy with 403
curl --cacert config/ca-cert.pem -o /dev/null -w '%{http_code}\n' -X POST \
  https://proxy.example.com:4443/api/1/vehicles/5YJ000000EXAMPLE/command/flash_lights
```

If the first command fails with a certificate error, fix the SAN or the CA file before going further (the plugin never disables TLS verification).

### 3d. Point the plugin at it

- `TESLA_COMMAND_PROXY_URL=https://proxy.example.com:4443` (alias `TESLA_FLEET_PROXY_URL`)
- `TESLA_COMMAND_PROXY_CA_CERT=/path/to/config/ca-cert.pem` (alias `TESLA_FLEET_PROXY_CA_FILE`): the CA (or the self-signed cert) to trust for the proxy only.

### 3e. First test, in order (after pairing the key in step 4)

1. `TESLA_FLEET_READ_ONLY=false` and `TESLA_FLEET_DRY_RUN=1`, reload, and ask for e.g. `flash_lights` with confirm: the result shows `wouldSend` and nothing is sent. `describe_boundary` should show `proxyConfigured: true`.
2. After step 4: `get_fleet_status` must show the virtual key as paired.
3. Unset `TESLA_FLEET_DRY_RUN`, reload, car awake on its own, then one harmless live command with the user's yes: `flash_lights`. Errors: `proxy_unreachable` (not running / wrong host), `proxy_tls_error` (CA or SAN), `virtual_key_missing` (pair first).

## 4. Pair the virtual key

Open `https://www.tesla.com/_ak/keys.example.com` on the phone with the Tesla app and approve. Set `TESLA_FLEET_KEY_DOMAIN=keys.example.com` so refusals show the right link.

## 5. Plugin variables

`TESLA_CLIENT_ID` (required); optionally `TESLA_FLEET_REGION`, `TESLA_DEFAULT_VIN`, `TESLA_FLEET_ENABLE_LOCATION=0` (only to opt out of location; it is on by default), `TESLA_FLEET_DEFAULT_LOCATION_PRECISION` (`coarse` default), and `TESLA_FLEET_READ_ONLY=false` **only** if the operator wants commands. For a first run with commands on, set `TESLA_FLEET_DRY_RUN=1`: confirmed commands are validated and return the exact request, nothing is sent. Optional warm-up defaults: `TESLA_FLEET_DEFAULT_CLIMATE_TEMP_C` (e.g. `21`), `TESLA_FLEET_DEFAULT_SEAT_HEAT_LEVEL` (`0`-`3`), `TESLA_FLEET_DEFAULT_HEATED_SEATS` (`driver`/`front`/`none`), `TESLA_FLEET_COLD_OUTSIDE_BELOW_C`, `TESLA_FLEET_DEFROST_OUTSIDE_BELOW_C`, `TESLA_FLEET_STEERING_WHEEL_HEAT_WHEN_COLD`. Only if the operator asks for a trusted local consumer on the same host to share the access token: `TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE` (absolute path in a private directory, e.g. `<state-dir>/grokbot-vehicle-fleet/access-token`; not `/tmp` or a shared or synced folder; off by default). The running MCP server writes it (at startup, then about 10 min before each expiry); it stays fresh only while the server runs. Warn the operator first that the file holds a token with **all** granted scopes (vehicle data, full-precision location regardless of the location settings, and `vehicle_cmds` / `energy_cmds` if granted; energy commands need no proxy), so any reader can act as the plugin; for read-only consumers recommend a separate read-only sign-in (e.g. `energy_device_data` only) with its own token store instead. Run `scripts/bootstrap-mcp.sh` (or `.ps1`), reload MCP servers, then `describe_boundary` to verify (shows set/missing only).
