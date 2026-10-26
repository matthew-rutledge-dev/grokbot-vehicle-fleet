/**
 * Test helpers. Every HTTP call goes to an in-process fake: an unmatched
 * route throws, so no test can reach a real network endpoint.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchLike } from "../src/http.js";
import { buildContext, createServer } from "../src/server.js";
import type { ToolContext } from "../src/context.js";

export const READ_TOOLS = [
  "describe_boundary", "get_api_usage", "api_status", "list_vehicles", "get_vehicle_state", "get_fleet_status",
  "get_battery_charge", "get_climate", "get_closures", "get_tires", "get_vehicle_snapshot",
  "list_energy_sites", "get_energy_live_status", "get_energy_site_info", "get_energy_history",
];
export const VEHICLE_COMMANDS = [
  "wake_vehicle", "climate_warm_up", "door_lock", "door_unlock", "actuate_trunk", "climate_start", "climate_stop",
  "set_temps", "set_seat_heater", "set_steering_wheel_heater", "set_cabin_overheat_protection", "set_defrost_max",
  "set_sentry_mode", "flash_lights", "honk_horn", "charge_start", "charge_stop", "set_charge_limit",
  "set_charging_amps", "charge_port_door_open", "charge_port_door_close", "share_navigation",
];
export const ENERGY_COMMANDS = ["set_backup_reserve", "set_operation_mode", "set_storm_mode", "set_grid_import_export"];
export const COMMANDS = [...VEHICLE_COMMANDS, ...ENERGY_COMMANDS];

export const VIN = "5YJ000000EXAMPLE";
export const BASE = "https://fleet-api.example.test";
export const AUTH = "https://fleet-auth.example.test";
export const PROXY = "https://proxy.example.com";
export const SEED = "seed-refresh-token-EXAMPLE-0001";

export type Call = { method: string; url: string; body?: string; headers: Record<string, string>; dispatcher?: unknown };
export type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
export type Route = (call: Call, n: number) => Reply | Promise<Reply>;

export function fakeFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const impl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method as string} ${u.origin}${u.pathname}`;
    const call: Call = {
      method: init.method as string,
      url,
      body: init.body as string | undefined,
      headers: init.headers as Record<string, string>,
      dispatcher: init.dispatcher,
    };
    calls.push(call);
    const route = routes[key];
    if (!route) throw new Error(`unexpected network call: ${key}`);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const r = await route(call, n);
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { status: r.status, headers: new Headers(r.headers ?? {}), text: async () => text };
  };
  return { impl, calls };
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vehicle-fleet-test-"));
}

export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    TESLA_CLIENT_ID: "example-client-id",
    TESLA_REFRESH_TOKEN: SEED,
    TESLA_FLEET_BASE_URL: BASE,
    TESLA_FLEET_AUTH_BASE_URL: AUTH,
    TESLA_COMMAND_PROXY_URL: PROXY,
    TESLA_TOKEN_STORE: path.join(tmpDir(), "tokens.json"),
    ...extra,
  };
}

/** Standard happy-path routes; override per test. */
export function routes(over: Record<string, Route> = {}): Record<string, Route> {
  let rt = 0;
  return {
    [`POST ${AUTH}/oauth2/v3/token`]: () => {
      rt++;
      return { status: 200, body: { access_token: `access-EXAMPLE-${rt}`, refresh_token: `rotated-EXAMPLE-${rt}`, expires_in: 28800 } };
    },
    [`GET ${BASE}/api/1/vehicles`]: () => ({ status: 200, body: { response: [{ vin: VIN, display_name: "Example", state: "online" }] } }),
    [`GET ${BASE}/api/1/vehicles/${VIN}`]: () => ({ status: 200, body: { response: { vin: VIN, state: "online" } } }),
    [`POST ${BASE}/api/1/vehicles/fleet_status`]: () => ({ status: 200, body: { response: { key_paired_vins: [VIN], unpaired_vins: [], vehicle_info: { [VIN]: { firmware_version: "2026.1.0", vehicle_command_protocol_required: true, total_number_of_keys: 3 } } } } }),
    [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data_cached`]: () => ({ status: 200, body: { response: fixtureData() } }),
    [`GET ${BASE}/api/1/vehicles/${VIN}/vehicle_data`]: () => ({ status: 200, body: { response: fixtureData(true) } }),
    [`POST ${PROXY}/api/1/vehicles/${VIN}/command/door_lock`]: () => ({ status: 200, body: { response: { result: true, reason: "" } } }),
    ...over,
  };
}

export function fixtureData(live = false): Record<string, unknown> {
  const ts = 1_790_000_000_000;
  const data: Record<string, unknown> = {
    charge_state: { timestamp: ts, battery_level: 72, battery_range: 210.5, charge_limit_soc: 80, charging_state: "Stopped" },
    climate_state: { timestamp: ts, inside_temp: 21.5, outside_temp: 12, is_climate_on: false, driver_temp_setting: 21 },
    vehicle_state: {
      timestamp: ts, locked: true, df: 0, dr: 0, pf: 0, pr: 0, ft: 0, rt: 0,
      fd_window: 0, fp_window: 0, rd_window: 0, rp_window: 0, sentry_mode: false,
      tpms_pressure_fl: 2.9, tpms_pressure_fr: 2.9, tpms_pressure_rl: 2.85, tpms_pressure_rr: 2.85,
      tpms_soft_warning_fl: false, tpms_last_seen_pressure_time_fl: 1_790_000_000,
    },
  };
  if (live) data.drive_state = { latitude: 37.123456, longitude: -122.654321, heading: 90, gps_as_of: 1_790_000_000 };
  return data;
}

export async function connect(ctx: ToolContext) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(ctx).connect(a);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(b);
  return client;
}

export function setup(env: Record<string, string>, over: Record<string, Route> = {}) {
  const f = fakeFetch(routes(over));
  const ctx = buildContext({ env, fetchImpl: f.impl, fleetOptions: { sleep: async () => {}, wakePollMs: 5000, wakeTimeoutMs: 15000 } });
  return { ctx, calls: f.calls };
}

export function body(res: unknown): Record<string, unknown> {
  const c = (res as { content: Array<{ text: string }> }).content;
  return JSON.parse(c[0].text) as Record<string, unknown>;
}

export function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}
