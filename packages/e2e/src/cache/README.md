# Replay cache

How `agent.act()` steps are recorded and replayed without a model call, the
rules each stage follows, and where they are tested. The user-facing version
is `docs/cache.mdx`; this file is for people changing the code.

One rule runs through every stage: **fail to miss**. Anything the cache cannot
prove ends in a miss or a hand-off to the agent, never a wrong action and
never a failed step. The only exception is `cache.strict`, which turns a stale
recording into `REPLAY_STALE` on purpose.

## Lifecycle of one step

```
claimKey ─▶ store.read ─▶ decideTraceReplay ─▶ replayTrace ─▶ endStateMatches ─▶ verdict
   │             │                │                  │                │
   │           miss            wrong-context    hand-off at the    end-mismatch
   │             │             / truncated      first divergence        │
   ▼             ▼                ▼                  ▼                ▼
 recorder ◀──────────────── the agent runs the step (from the top or mid-step)
   │
   ▼
conclude ─▶ staged (write | keep) ─▶ flushStagedTraces at attempt end
```

| Stage | Code | What it decides |
| --- | --- | --- |
| Key | `identity.ts`, `context.ts` (`claimKey`) | Which entry belongs to this step. |
| Read | `store.ts`, `trace.ts` (`readTraceEntry`), `template.ts` (`expandTrace`) | Whether a trusted entry exists, with this call's `unique()` values filled in. |
| Precondition | `decide.ts`, `route.ts` | Whether the app is on the screen the recording began on. |
| Replay | `agent/replay.ts`, `relocate.ts` | Each recorded action, re-aimed at the live screen. |
| Postcondition | `anchors.ts`, `agent/step-cache.ts` (`endStateMatches`) | Whether the replay reproduced the recorded effect, and caused it. |
| Write | `recorder.ts`, `agent/step-cache.ts` (`stage`, `conclude`) | What to stage: a new recording, a keep, or an eviction. |
| Settle | `context.ts` (`flushStagedTraces`) | Which staged entries a later verification confirmed. |
| Strict | `rekeyed.ts`, `agent/step-cache.ts` (`failIfStale`) | Whether a missing or diverging recording fails the step. |

`agent/step-cache.ts` (`StepTraceSession`) owns everything cache-shaped about
one step. The dispatch owns budgets, the grammar, and the verdict.

## Key

The key (`TraceCacheKey`) is a JCS SHA-256 over every field that can change
what a replay does: project, test, target, platform, engine name and
major.minor, SPI version, kind, instruction digest, params digest (each
`unique()` value as a placeholder), occurrence index, app identity, agent
name, agent context digest, and `REPLAY_POLICY_VERSION`. A stale entry can
only be a miss, never a wrong answer.

The occurrence index (`callIndex`) counts repeats of the same signature
(instruction and params) per agent, not every step. An optional cookie dialog
that appears on one run and not the next renumbers nothing else.

Bump `REPLAY_POLICY_VERSION` only when an existing recording could now
relocate to a different node than it did before. Rules that only add
fallbacks after the exact match fails do not need a bump: an entry that
replayed before still matches the same node first.

## Relocation: the ladder

A recorded target is a descriptor (`TraceTargetDescriptor`): role, name,
text, test id, placeholder, input purpose, plus `within` (the key of its
named row, list item, or group) and `position` (its place among twins).
Engines fill the first six from the node; the web engine does not emit
per-node `selector`s, so the selector is provenance only and never matched.

`relocateRecorded` walks a ladder. Each rung keeps less of the recording,
most stable evidence first. The first rung that settles on exactly one node
(or on the recorded `position` among the same count of twins) wins.

| Rung | Matches on | Absorbs | Report |
| --- | --- | --- | --- |
| Exact | every recorded identity field (text too when there is no name or test id) | nothing | none |
| Exact, test id re-minted | every field but the test id, when no node still carries the recorded test id | test ids minted per render | none |
| Test id + role | `testId`, `role` | copy changes: name, text, placeholder | `test-id` |
| Test id | `testId` | copy and role changes | `test-id` |
| Accessible | `role`, `name` | test id, placeholder, or text changes | `accessible` |
| Role family | `name`, role in the same family | `link` to `button`, `checkbox` to `switch`, `textbox` to `combobox` | `role-family` |
| Label shape | `role`, the shape of the name (else the text) | a tally or time in the label: `Like (0 likes)` to `Like (1 like)`, `Bob · 2m` to `Bob · now` | `label-shape` |

The label shape (`label-shape.ts`) folds only a count governing a noun and
a relative time or age. A number that names rather than counts stays as it
reads: `Delete item 3` never finds `Delete item 4`, nor `Page 2` `Page 3`,
nor `Count: 1` `Count: 0`. A label that is nothing but a time compares as it
reads.

What never loosens:

- `within` must hold on every rung. The same "Delete" in another row is
  another control, and with only one row left the ladder would otherwise
  delete the wrong record.
- An ambiguous exact match diverges. Every fallback rung only widens the
  candidate set, so falling back cannot resolve it.
- A control recorded among twins resolves only by its place among the same
  count of them, on every rung. A lone survivor of three recorded "Like"
  buttons is ambiguous, not found: it is whichever one still reads as
  recorded, which after an earlier run liked the recorded one is the wrong
  one.
- An anonymous control (role only) has no fallback. Its recorded place among
  its unnamed twins is all it has.
- Two kinds of evidence that disagree hand off. When the test id rungs settle
  on one node and the name rungs on another, the result is `target-ambiguous`.
  The same check guards the exact tier: a re-minted test id is forgiven only
  when no node still carries the recorded one.
- A fallback match needs a second look (`FallbackSighting` in
  `agent/replay.ts`). A node found only by a fallback is acted on once the
  next raw look finds the same node by the same rung again. A wizard's
  outgoing page can hold "Next" under the test id of the incoming page's
  "Save"; the second look sees the page that replaced it. This costs one
  more poll of the settling backoff per drifted control (100 ms when the
  first look found it), nothing for exact matches.
- When the test id and the name disagree, the result is a conflict, not
  look-alikes: a recorded point never picks between them, and the replay
  keeps looking while the screen settles before it hands off.

Live steps (`observation-feed.ts`, re-finding a node that went stale a moment
ago) use the exact match only (`relocateDescriptor`). The ladder is for
recordings made on another day.

### Healing

A replay that passed after a fallback re-records the step in `read-write`
mode instead of keeping the entry, unless the only drift was a tally or a
time in a label (`transient`), which moves again on the next run and would
rewrite the entry every time. The dispatch records every replayed action
against the live node, so the staged trace carries today's descriptors and
anchors, and the next run matches exactly. The entry is written only once a
later verification confirms it, like any recording. In `read-only` mode the
entry keeps replaying through the fallback; `step.cache.relocated` (report),
`relocated` (run summary), and `agent_steps_relocated` (telemetry) make that
visible.

## Pacing

A replay runs no model, so its speed is set by how long it waits for the
app. Most actions arm a change wait (`SETTLE_AFTER` in
`agent/settle-policy.ts`): the next settled look waits for the screen to
leave the shape the action was resolved against, up to 2 s after a tap,
key, fill, or navigation and 500 ms after a scroll or a project tool, then
reads the first capture after it (`after-change`, after a fill) or waits for
it to hold still (`held-still`, after the rest). A secret fill arms none. An
action whose effect the tree never shows (a right-click that opens a native
menu, a key that moves a caret, a tap that only arms the next control) waits
its whole change wait every time.

The recording notes how each action settled. `ObservationFeed` reports
whether any capture of a settled look left the shape the action was
resolved against (a save that showed "Saving..." and came back changed the
screen), the dispatcher tells the recorder which action armed the wait
(`armedChange`), and an action that changed nothing is stored `quiet`. A
note is kept only when it can answer for one action: when another action's
wait was still pending, or another action landed before the look, nothing
is marked. The pace is cleared once the call settles, so a call that fails
before its action runs never hands it to the executor. A replay arms a 300 ms change wait for a
quiet action instead (`QUIET_CHANGE_WAIT_MS`, `ActionDispatcher.paceNext`),
so it is paced by what the recording saw rather than by timeouts. The held
still check after it, relocation polling, and the end-state wait are
unchanged, so a change that does come late is still waited for.

`quiet` is a timing, so it never counts as a new flow (`flowOf`). An entry
recorded before pacing learns it once: from the next recording of the same
flow, or from a whole replay, which waited every action's full change wait
(`completeEntry`). A folded scroll is always paced in full.

Measured on the web benchmark's agentic suite (median of three read-only
runs each, every step replayed): the steps with a quiet action went from
2.3 to 2.6 s down to 0.6 to 1.0 s, and the suite's replayed steps from
28.9 s to 20.3 s, excluding one 431-page `scrollUntil` whose time is the
paging itself. Run to run spread stays under 2%.

## Anchors: the postcondition

Actions that ran prove the clicks happened, not that the save took. A
recording keeps the step's delta (`describeDelta`): up to eight descriptors
that appeared and eight that vanished, announcements (`alert`, `alertdialog`,
`status`) first, then leaves, then containers. A replay passes alone only
when:

1. the end route matches (`sameRoute`, polled while a navigation commits),
2. every appeared anchor is present and every gone one is absent
   (`deltaHolds`), compared on every anchor field, value and states included,
3. no alert is on screen that was not there before and was not recorded,
4. at least one change happened during the replay (`deltaEvidenced`),
   measured from the first screen the replay saw on its end route. An
   outcome already on screen proves nothing.

Anchors are compared by shape (`anchorShape`): ids, dates, times, and
durations read as `#`, so `Saved at 10:42` is the effect `Saved at 10:45`
repeats. Shapes are weaker than exact text, so volatile anchors are recorded
only when nothing stable changed (alerts always). Counts that name what they
count (`3 records imported`) are the step's result when the step made them
appear on its own screen, and data otherwise.

Anchors deliberately do not use the relocation ladder. For a target, a
relabeled button is still the button. For an anchor, the text is the effect.

## Routes

`route.ts` reduces a location to a route: origin (dropped on the app's own
origin, so a recording follows the app to a preview deployment), path
segments, and sorted query terms. Segments and values that look minted per
record (uuids, hex and digit runs, long mixed tokens, prefixed ids like
`INV-2041`, dates, text with whitespace) become `:id`. Fragment routers
(`#/x` and `#!/x`) route by the fragment. A device screen title
(`<bundle id> / <title>`) is not a URL; its words follow the segment rules,
so `Order 48213` and `Order 48214` are one screen.

## `unique()` templates

A value marked `unique()` is a slot: the key digests a placeholder
(`{{param:<pointer>}}`), the recording stores the placeholder wherever the
value appeared in any spelling (as given, `uri`, `form`, `slug`), and replay
fills it from the current call. A pointer is percent-escaped for `%`, `|`,
and `}` so any param key round-trips. A `unique()` value that another param
spells is a collision: the step is not recorded (`notRecorded:
param-collision`).

## Write side

`StepTraceSession.conclude`, in `read-write` mode only:

| Step ended | After | Staged |
| --- | --- | --- |
| passed | the agent had to act after an `end-mismatch` | evict: the flow is proven not to produce the effect |
| passed | a whole replay, every control exact | `keep`: the file stays byte for byte |
| passed | a whole replay that used a fallback | `write`: heal (see above) |
| passed | a live run or a hand-off | `write` of what was recorded, or evict the read entry when nothing is recordable; after an entry that did not serve the step (anything but a gap), the write replaces it even as the same flow, so a stale `quiet` mark cannot outlive it |
| failed | a replay ran any action | evict, unless `cache.strict` failed it |
| no verdict | cancelled, or no model answered | nothing |

`flushStagedTraces` confirms a staged entry only when a verification step
(a locator or engine matcher, `agent.assert`, `agent.waitFor`) passed after
it. On a failed attempt, confirmation stops at what had been verified when
the first failure landed, a soft assertion included. Unconfirmed entries are
evicted, unless every failure was a model that never answered.

A write is skipped when the stored entry already holds the same flow
(`holdsSameFlow`, ignoring the summary, the measured end wait, and a gap's
`derived` rule), so a committed cache directory stays clean across runs.

## Testing map

| Area | Tests |
| --- | --- |
| Ladder, conflicts, `within`, position, label shapes | `tests/unit/relocate-ladder.test.ts`, `relocate-*.test.ts` |
| Replay engine, second look, scrolls, points | `tests/unit/trace-replay.test.ts` |
| Anchors and shapes | `tests/unit/trace-anchors.test.ts` |
| Routes | `tests/unit/trace-route.test.ts`, `trace-decide.test.ts` |
| Templates | `tests/unit/trace-template.test.ts` |
| Key, store, entry format | `trace-identity`, `trace-store`, `trace-cache`, `trace-recorder`, `trace-redaction` |
| Session write side, strict, healing | `tests/unit/step-cache.test.ts` |
| Pacing | `tests/unit/trace-pacing.test.ts`, the `/arm` case in `agent-trace-cache.test.ts` |
| End to end with a browser | `tests/integration/agent-trace-cache.test.ts`, `trace-cache-replay.test.ts` |
| Real apps | `apps/web-benchmark` (`--strict-cache` in CI), `apps/mobile-benchmark` |

## Live drift probe

Unit tests cannot show that a replay against a changed app does the right
thing end to end. The probe that checks it is a scratch server whose pages
differ between a `record` and a `drift` mode, run through the real CLI and a
real model: record once, copy the entries to each build, replay. Not
committed (the dead-code check rejects its server); rebuild it from this
table when a rule here changes, and run it on `main` and the branch.

| Page | Drift | Expected |
| --- | --- | --- |
| counter | `Increment` does nothing | `end-mismatch`, never a pass on `Count: 0` |
| items | `Delete item 3` gone, `Delete item 4` left | `target-not-found`, item 4 untouched |
| form | field id `mat-input-2` moves to another field | replays by label |
| testid | `Save` relabeled `Save changes`, same test id | replays, `test-id`, heals |
| likes | `Like (0 likes)` to `Like (3 likes)` | replays, `label-shape`, not healed |
| settings | link becomes a button | replays, `role-family`, heals |
| clock | none; the effect reads the time | replays (failed every run before anchor shapes) |
| async | none; the control renders 1.2 s after load | replays after relocation polling |
| shuffle | none; rows in random order | replays on the named row |
| ago | `posted 2m ago` to `posted 5m ago` | replays, `label-shape`, not healed |
| confirm | a new confirm dialog after Delete | `end-mismatch` on the new alert, evicted, re-recorded |
| removed | the control is gone | `target-not-found` |
| ab | label picked per load under a stable test id | replays, `test-id` |

Last run 2026-10-04: every row as expected on this branch; `main` handed off
or missed on testid, likes, settings, clock, ago, and on ab when the label
flipped, with 16 model calls to the branch's 5.

## Audit, 2026-10-03

A full read of the subsystem, with an independent bug hunt that proved each
finding with a probe against the real modules.

PR #637 (`oskar/cache-relocate-label-drift`) took the first run at label
drift. This change keeps its label fold and its twins rule, and its drift
probe (a scratch server whose pages differ between a recording run and a
replay run) is how the ladder was checked end to end. It leaves out #637's
element id rung: the same probe showed framework counter ids (`mat-input-2`)
typing into the wrong field, and telling authored ids from counters needs a
naming heuristic.

Fixed in the change that added this file:

- **No graceful degradation.** Relocation required every recorded field, so
  a relabeled button with a stable test id handed off to the model on every
  run, and drift was repaired only after a failed relocation. Now the ladder
  above, healing, and the `relocated` count.
- **A moved test id was forgiven.** The re-minted test id tier matched a
  node by its other fields even when another node still carried the recorded
  test id. Now `target-ambiguous`.
- **Volatile-only anchors failed their own replay.** A step whose only effect
  was `Saved at 10:42` recorded that text and compared it exactly, so every
  replay ended in `end-mismatch` and rewrote the entry. Now every anchor is
  compared by shape.
- **`unique()` param keys with `|` or `}}`** wrote a placeholder that could not
  be parsed back: `invalid-entry` forever, `REPLAY_STALE` under strict.
  Pointers are now escaped; old placeholders still read.
- **Device titles with record ids** (`Order 48213`) never matched across
  runs. Their words now follow the path segment rules.
- **Hash-bang routes** (`#!/companies`, `#!/settings`) all compared as one
  screen. Now routed by the fragment.
- **A soft assertion failure** did not stop later checks from confirming
  entries staged before it. Settlement now stops at the first soft failure.
- **A replay cut off by a hard stop** (step timeout) was not marked consumed,
  so its entry survived the failure. Now evicted like any failed replay.

Open, by decision or for later:

- `--repeat-each` repeats share one key; concurrent repeats can evict an
  entry another repeat just confirmed. The CLI help already suggests
  `--no-cache` with it.
- `within` never loosens. A row whose first text changed makes its controls
  unreachable until a re-record. Loosening it risks acting on the wrong row.
- A label with a count the tally fold does not read (`Inbox (3)`, a bare
  number) and a stable test id replays through the test id rung and heals
  every `read-write` run, which rewrites the entry each time.
- The non-test-id rungs accept a candidate whose own test id differs from
  the recorded one, as the re-minted tier always has. A real, stable test id
  that changed on purpose is caught only by the end anchors.
