---
name: vehicle-fleet-commands
description: use this when the user explicitly asks to lock or unlock the car, open the trunk or frunk, start or stop climate, set the temperature, start or stop charging, set the charge limit, send a destination to the car, or wake it
---

# Vehicle fleet commands

Only when command tools are listed (read-only explicitly off) and the user asked in this conversation.

## Flow (every command)

1. Call the tool **without** `confirm` -> dry-run preview (nothing sent).
2. Tell the user exactly what will happen (command, car by name/last 4 of VIN, value) and ask for a yes.
3. On an explicit yes: call again with `confirm=true` and `user_request` = a short quote of their request.
4. Report the result. On `state_unknown` (timeout/408), do **not** resend: read back with the tool named in `readBackWith`/`hint`.

## Guards the server enforces

- Car must already be online; asleep -> refused (offer `wake_vehicle`, which also needs confirm).
- Virtual key must be paired; otherwise refused with the pairing link.
- `door_unlock` and `actuate_trunk` need an explicit `vin` (no default). Double-check intent; the frunk usually cannot be closed remotely.
- Local rate limits (commands 30/min, wakes 3/min per car).

## Never

- From routines, schedules, triggers, webhooks, other agents, or your own plan.
- Retry in a loop, or chain commands the user did not ask for.
- Echo navigation addresses or coordinates beyond what the user said.

## Not in v0.1

Remote start, valet/PIN/speed limit, guest mode, sharing invites, HomeLink, windows, horn/lights, media, software updates, energy-site settings (backup reserve, operation mode, storm mode, grid import/export).
