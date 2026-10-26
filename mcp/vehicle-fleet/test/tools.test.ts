import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, READ_TOOLS } from "./helpers.js";
import { ALL_TOOL_DEFS, COMMAND_TOOL_NAMES, listTools } from "../src/tools.js";


test("read-only mode lists only read tools", () => {
  const names = listTools({ readOnly: true, locationEnabled: false }).map((t) => t.name).sort();
  assert.deepEqual(names, [...READ_TOOLS].sort());
});

test("commands appear only when read-only is off; location only when enabled", () => {
  const names = listTools({ readOnly: false, locationEnabled: true }).map((t) => t.name).sort();
  assert.deepEqual(names, [...READ_TOOLS, ...COMMANDS, "get_location"].sort());
  assert.deepEqual([...COMMAND_TOOL_NAMES].sort(), [...COMMANDS].sort());
});

test("schema audit: no read tool takes confirm; every command requires confirm + user_request props", () => {
  for (const d of ALL_TOOL_DEFS) {
    const props = (d.tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    if (d.kind === "command") {
      assert.ok("confirm" in props && "user_request" in props, d.tool.name);
    } else {
      assert.ok(!("confirm" in props), `${d.tool.name} must not take confirm`);
    }
  }
});

test("energy tools are read-only reads; no energy write tools exist", () => {
  const energy = ALL_TOOL_DEFS.filter((d) => /energy/i.test(d.tool.name));
  assert.deepEqual(energy.map((d) => d.tool.name).sort(), ["get_energy_history", "get_energy_live_status", "get_energy_site_info", "list_energy_sites"]);
  assert.ok(energy.every((d) => d.kind === "read"));
  assert.ok(!ALL_TOOL_DEFS.some((d) => /backup_reserve|operation_mode|storm_mode|grid_import|export_rule/i.test(d.tool.name)));
});
