/**
 * 0.6.2: review follow-ups from 0.6.1 (run-together lowercase and digit-suffixed location keys).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dropLocation, isLocationKey } from "../src/tools/energy.js";

test("isLocationKey: run-together lowercase and digit-suffixed keys are dropped", () => {
  for (const k of ["latlng", "latlon", "lnglat", "lonlat", "LatLng", "lat_lng", "homelatitude", "homelongitude", "sitelocation",
    "gpscoordinates", "homecoordinate", "lastlocationid", "geolocation2", "lat1", "lon2", "lng3", "longitude2", "latitude10",
    "home_lat1", "homeLatitude2", "site-location3", "coords1", "gps1", "Location", "LOCATIONS"]) {
    assert.ok(isLocationKey(k), k);
  }
});

test("isLocationKey: lookalikes are kept (no short-stem substring match)", () => {
  for (const k of ["translation", "platform", "relative", "plateau", "flatness", "salon", "longevity", "dissolved", "geometryVersion",
    "allocation", "allocations", "energy_allocation_wh", "reallocated", "translation2", "platform1", "chargeLimit", "session_id",
    "energy_added_wh", "vin_hash", "flat1", "slat", "colon", "along", "category", "latency_ms", "longest_session"]) {
    assert.ok(!isLocationKey(k), k);
  }
});

test("dropLocation: run-together and digit-suffixed keys removed at any depth, lookalikes kept", () => {
  const out = dropLocation({
    translation: "t", platform: "p", allocation: 3,
    latlng: "11.11,22.22", lat1: 33.33, longitude2: 44.44,
    deep: [{ homelatitude: 55.55, sitelocation: { x: 66.66 }, gpscoordinates: [77.77], latency_ms: 5 }],
  });
  const j = JSON.stringify(out);
  for (const v of ["11.11", "22.22", "33.33", "44.44", "55.55", "66.66", "77.77"]) assert.ok(!j.includes(v), v);
  assert.deepEqual(out, { translation: "t", platform: "p", allocation: 3, deep: [{ latency_ms: 5 }] });
});
