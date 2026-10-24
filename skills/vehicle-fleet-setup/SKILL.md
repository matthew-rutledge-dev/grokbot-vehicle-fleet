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

Pick the smallest scopes: read-only = `openid offline_access vehicle_device_data`; add `vehicle_location` only for location; `vehicle_cmds` / `vehicle_charging_cmds` only for commands.

```bash
export TESLA_CLIENT_ID=...        # in your terminal, not in chat
export TESLA_CLIENT_SECRET=...
export TESLA_REDIRECT_URI=http://localhost:8765/callback   # must be registered on the app
export TESLA_AUTH_SCOPES="openid offline_access vehicle_device_data"
node scripts/auth-helper.mjs url
node scripts/auth-helper.mjs exchange "<full redirect URL>"
```

The helper writes the token store (0600) and prints no secrets. Alternatively set `TESLA_REFRESH_TOKEN` as a plugin variable.

## 3. Command proxy (only if commands are wanted)

Run Tesla's `tesla-http-proxy` (from `teslamotors/vehicle-command`) yourself, bound to loopback or a private host, with your private key and a TLS cert whose SAN matches the host. Then set:

- `TESLA_COMMAND_PROXY_URL=https://proxy.example.com:4443`
- `TESLA_COMMAND_PROXY_CA_CERT=/path/to/proxy-ca-or-cert.pem`

The plugin never downloads, builds, or starts the proxy.

## 4. Pair the virtual key

Open `https://www.tesla.com/_ak/keys.example.com` on the phone with the Tesla app and approve. Set `TESLA_FLEET_KEY_DOMAIN=keys.example.com` so refusals show the right link.

## 5. Plugin variables

`TESLA_CLIENT_ID` (required); optionally `TESLA_FLEET_REGION`, `TESLA_DEFAULT_VIN`, `TESLA_FLEET_ENABLE_LOCATION=1`, and `TESLA_FLEET_READ_ONLY=false` **only** if the operator wants commands. Run `scripts/bootstrap-mcp.sh` (or `.ps1`), reload MCP servers, then `describe_boundary` to verify (shows set/missing only).
