---
'e2e': minor
---

The replay cache falls back when a recorded control drifts instead of handing the step to the agent. When no control matches everything recorded, a replay tries the test id with the role, the test id alone, the role and accessible name, the name across one kind of control (a link that became a button), then the label with its counts and relative times read as placeholders (`Like (0 likes)` finds `Like (1 like)`, `Delete item 3` never finds `Delete item 4`), and takes the first that finds exactly one control on two looks in a row. A replay that needed a fallback re-records the step in `read-write` mode. `step.cache.relocated` counts those actions, the run summary shows `relocated`, and telemetry reports `agent_steps_relocated`. A test id that moved to another control is now `target-ambiguous` instead of matched by the label, and so is the one remaining control of several identical ones the step was recorded among.

Replays are paced by what the recording saw: an action that changed nothing on screen when recorded (a right-click that opens a native menu, a key that moves the cursor) no longer waits the full two-second change timeout on every replay. Entries recorded before learn their pacing once, from the next `read-write` run that records or replays them.

Also fixed: a step whose only effect read a time or id (`Saved at 10:42`) no longer fails its own replay; a `unique()` param whose key contains `|` or `}}` replays; a device screen title with a record id (`Order 48213`) matches the next run's; hash-bang routes (`#!/settings`) are told apart; a soft assertion failure stops later checks from confirming cache entries recorded before it; and in `read-write` mode a replay cut off by a step timeout evicts its entry.
