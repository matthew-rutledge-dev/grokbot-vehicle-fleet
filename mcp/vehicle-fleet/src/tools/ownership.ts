/**
 * Ownership reads: recent alerts, release notes, service status, warranty, recalls.
 * Read-only, no confirm, never wake the vehicle. Recalls come from the public NHTSA API by
 * make / model / model year decoded from the VIN on this machine (no token, no VIN sent);
 * the Fleet API has no recalls endpoint.
 */
import { FleetApiError, LocalRefusal } from "../errors.js";
import type { ToolArgs, ToolContext } from "../context.js";
import { pick } from "./extract.js";
import { VIN_PROP } from "./schema.js";
import type { ToolDef } from "./types.js";

const MAX_ITEMS = 50;
const MAX_TEXT = 2000;

const text = (v: unknown, max = MAX_TEXT) => (typeof v === "string" ? v.slice(0, max) : v);
const list = (v: unknown, key: string): unknown[] => {
  if (Array.isArray(v)) return v;
  const inner = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
  return Array.isArray(inner) ? inner : [];
};

/** Model and model year from a Tesla VIN (position 4 = model line, position 10 = model year). Local only. */
export function decodeTeslaVin(vin: string): { model?: string; modelYear?: number } {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return {};
  const models: Record<string, string> = { S: "Model S", X: "Model X", "3": "Model 3", Y: "Model Y", C: "Cybertruck" };
  const years = "ABCDEFGHJKLMNPRSTVWXY";
  const yi = years.indexOf(vin[9]);
  return { model: models[vin[3]], modelYear: yi >= 0 ? 2010 + yi : undefined };
}

export const ALERT_FIELDS = ["name", "time", "audience", "user_text"] as const;
export const RELEASE_NOTE_FIELDS = ["title", "subtitle", "description", "customer_version"] as const;
export const SERVICE_FIELDS = ["service_status", "service_etc", "service_visit_number", "status_id"] as const;
export const WARRANTY_FIELDS = [
  "warrantyType", "warrantyDisplayName", "expirationDate", "expirationOdometer", "odometerUnit",
  "warrantyExpiredOn", "coverageAgeInYears",
] as const;
export const RECALL_FIELDS = [
  "NHTSACampaignNumber", "ReportReceivedDate", "Component", "Summary", "Consequence", "Remedy",
  "Notes", "overTheAirUpdate", "parkIt", "parkOutSide",
] as const;

const vinTool = (name: string, description: string, run: (vin: string, args: ToolArgs, ctx: ToolContext) => Promise<Record<string, unknown>>): ToolDef => ({
  kind: "read",
  tool: { name, description, inputSchema: { type: "object", properties: { ...VIN_PROP } } },
  handler: async (args, ctx) => {
    const vin = await ctx.fleet.resolveVin(args.vin);
    return { ok: true, vinLast4: vin.slice(-4), ...(await run(vin, args, ctx)) };
  },
});

export const OWNERSHIP_TOOLS: ToolDef[] = [
  vinTool(
    "get_recent_alerts",
    "Recent vehicle alerts (GET recent_alerts; name, time, audience, text; up to 50). One billable data call, cached 5 min. Never wakes.",
    async (vin, _a, ctx) => {
      const { data, ageSec } = await ctx.fleet.recentAlerts(vin);
      const items = list(data, "recent_alerts");
      return {
        servedFromMemorySec: ageSec,
        count: items.length,
        alerts: items.slice(0, MAX_ITEMS).map((a) => {
          const p = pick(a, ALERT_FIELDS);
          return { ...p, user_text: text(p.user_text, 500) };
        }),
      };
    },
  ),
  vinTool(
    "get_release_notes",
    "Firmware release notes for the installed (or staged) version (GET release_notes; title, subtitle, text, version; images left out). One billable data call, cached 1 h. Never wakes.",
    async (vin, _a, ctx) => {
      const { data, ageSec } = await ctx.fleet.releaseNotes(vin);
      const items = list(data, "release_notes");
      return {
        servedFromMemorySec: ageSec,
        count: items.length,
        notes: items.slice(0, MAX_ITEMS).map((n) => {
          const p = pick(n, RELEASE_NOTE_FIELDS);
          return { ...p, description: text(p.description) };
        }),
      };
    },
  ),
  vinTool(
    "get_service_status",
    "Service status (GET service_data: whether the car is at a service center, estimated completion, visit number). One billable data call, cached 10 min. Never wakes.",
    async (vin, _a, ctx) => {
      const { data, ageSec } = await ctx.fleet.serviceData(vin);
      const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const known = pick(d, SERVICE_FIELDS);
      return {
        servedFromMemorySec: ageSec,
        ...known,
        inService: typeof known.service_status === "string" ? known.service_status === "in_service" : undefined,
        otherKeys: Object.keys(d).filter((k) => !(SERVICE_FIELDS as readonly string[]).includes(k)).slice(0, 20),
      };
    },
  ),
  vinTool(
    "get_warranty",
    "Warranty coverage (GET dx/warranty/details: active, upcoming and expired items with type, expiry date and odometer limit). One billable data call, cached 6 h. Never wakes.",
    async (vin, _a, ctx) => {
      const { data, ageSec } = await ctx.fleet.warrantyDetails(vin);
      const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const items = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]).slice(0, MAX_ITEMS).map((w) => pick(w, WARRANTY_FIELDS)) : []);
      return { servedFromMemorySec: ageSec, active: items("activeWarranty"), upcoming: items("upcomingWarranty"), expired: items("expiredWarranty") };
    },
  ),
  {
    kind: "read",
    tool: {
      name: "get_recalls",
      description: "Safety recalls for this car's model and model year from the public NHTSA recalls API (the Fleet API has no recalls endpoint). Model and year are decoded from the VIN on this machine; the VIN and the token are never sent to NHTSA, and the call is not Fleet API usage. Covers the model year, not the exact car: whether a recall is open or done for this car is in the Tesla app. Pass model / model_year if the VIN cannot be decoded. Cached 6 h.",
      inputSchema: {
        type: "object",
        properties: {
          ...VIN_PROP,
          model: { type: "string", enum: ["Model S", "Model 3", "Model X", "Model Y", "Cybertruck"], description: "Override the model decoded from the VIN." },
          model_year: { type: "integer", minimum: 2012, maximum: 2040, description: "Override the model year decoded from the VIN." },
        },
      },
    },
    handler: async (args, ctx) => {
      const vin = await ctx.fleet.resolveVin(args.vin);
      const dec = decodeTeslaVin(vin);
      const model = typeof args.model === "string" && args.model ? args.model : dec.model;
      const year = typeof args.model_year === "number" ? args.model_year : dec.modelYear;
      if (!model || !year || !Number.isInteger(year) || year < 2012 || year > 2040) {
        throw new LocalRefusal("model_year_unknown", "Could not tell the model and model year from this VIN; nothing was sent.",
          "Pass model (e.g. \"Model 3\") and model_year.");
      }
      let res: { data: unknown; ageSec: number };
      try {
        res = await ctx.fleet.nhtsaRecalls(model, year);
      } catch (e) {
        const status = e instanceof FleetApiError ? e.info.status : undefined;
        throw new LocalRefusal("nhtsa_unavailable", `The NHTSA recalls service did not answer${status ? ` (HTTP ${status})` : ""}; try again later.`,
          "Tesla's own VIN recall lookup and the Tesla app show recalls for this exact car.");
      }
      const items = list(res.data, "results");
      return {
        ok: true,
        vinLast4: vin.slice(-4),
        source: "nhtsa",
        model,
        modelYear: year,
        servedFromMemorySec: res.ageSec,
        count: items.length,
        recalls: items.slice(0, MAX_ITEMS).map((r) => {
          const p = pick(r, RECALL_FIELDS);
          for (const k of ["Summary", "Consequence", "Remedy", "Notes"]) if (k in p) p[k] = text(p[k], 1000);
          return p;
        }),
        scope: "Model and model year. Not every car of that year is affected, and completed recalls still show here; check the Tesla app for this car.",
      };
    },
  },
];
