import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, OPT_IN_COMMANDS, OPT_IN_EXPERIMENTAL_COMMANDS, READ_TOOLS, VALET_COMMANDS } from "./helpers.js";
import { ALL_TOOL_DEFS, COMMAND_TOOL_NAMES, listTools } from "../src/tools.js";


test("read-only mode lists only read tools", () => {
  const names = listTools({ readOnly: true, locationEnabled: false }).map((t) => t.name).sort();
  assert.deepEqual(names, [...READ_TOOLS].sort());
});

test("commands appear only when read-only is off; location only when enabled", () => {
  const names = listTools({ readOnly: false, locationEnabled: true }).map((t) => t.name).sort();
  assert.deepEqual(names, [...READ_TOOLS, ...COMMANDS, "get_location"].sort());
  assert.deepEqual([...COMMAND_TOOL_NAMES].sort(), [...COMMANDS, ...OPT_IN_COMMANDS].sort());
});

test("opt-in commands: valet / experimental extras need read-only off AND their own flag", () => {
  const names = (m: Parameters<typeof listTools>[0]) => listTools(m).map((t) => t.name);
  for (const n of OPT_IN_COMMANDS) {
    assert.ok(!names({ readOnly: false, locationEnabled: true }).includes(n), `${n} hidden by default`);
    assert.ok(!names({ readOnly: true, locationEnabled: true, valetEnabled: true, experimentalEnabled: true }).includes(n), `${n} hidden when read-only`);
  }
  const valet = names({ readOnly: false, locationEnabled: true, valetEnabled: true });
  assert.ok(VALET_COMMANDS.every((n) => valet.includes(n)));
  assert.ok(OPT_IN_EXPERIMENTAL_COMMANDS.every((n) => !valet.includes(n)));
  const exp = names({ readOnly: false, locationEnabled: true, experimentalEnabled: true });
  assert.ok(OPT_IN_EXPERIMENTAL_COMMANDS.every((n) => exp.includes(n)));
  assert.ok(VALET_COMMANDS.every((n) => !exp.includes(n)));
  for (const d of ALL_TOOL_DEFS.filter((x) => x.optIn)) assert.equal(d.kind, "command", d.tool.name);
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

test("energy reads are reads; energy writes are command tools (hidden, confirm-gated)", () => {
  const reads = ALL_TOOL_DEFS.filter((d) => d.kind === "read" && /energy/i.test(d.tool.name));
  assert.deepEqual(reads.map((d) => d.tool.name).sort(), ["get_energy_history", "get_energy_live_status", "get_energy_site_info", "list_energy_sites"]);
  const writes = ALL_TOOL_DEFS.filter((d) => /backup_reserve|operation_mode|storm_mode|grid_import|export_rule/i.test(d.tool.name));
  assert.deepEqual(writes.map((d) => d.tool.name).sort(), ["set_backup_reserve", "set_grid_import_export", "set_operation_mode", "set_storm_mode"]);
  assert.ok(writes.every((d) => d.kind === "command" && COMMAND_TOOL_NAMES.has(d.tool.name)));
});
