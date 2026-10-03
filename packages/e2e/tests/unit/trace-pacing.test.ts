/** Recorded pacing: an action whose recording saw nothing change replays without waiting out the change timeout. */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutorActions } from '../../src/agent/executor.ts';
import { QUIET_CHANGE_WAIT_MS, replayTrace, type ReplayHost } from '../../src/agent/replay.ts';
import { flushStagedTraces, type AgentCacheContext } from '../../src/cache/context.ts';
import { TraceRecorder } from '../../src/cache/recorder.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
import { buildTraceEntry, readTraceEntry, type ActionTrace, type RecordedAction } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { redacted, redactedNodes } from '../helpers/redacted.ts';

const menu: SemanticNode = { ref: { id: 'm', revision: 'r1' }, role: 'listitem', name: 'report.pdf' };
const rename: SemanticNode = { ref: { id: 'r', revision: 'r1' }, role: 'menuitem', name: 'Rename' };

function recorder(maxActions?: number): TraceRecorder {
  const same = (text: string) => text;
  return new TraceRecorder({ redact: same, redactCut: same, ...(maxActions === undefined ? {} : { maxActions }) });
}

const conclusion = {
  executor: { name: 'scripted' },
  recordedFor: { testId: 't', targetId: 'web', instructionDigest: 'c'.repeat(64) },
  summary: 'renamed',
  startPath: '/files',
};

describe('TraceRecorder pacing', () => {
  it('marks an action quiet when the screen kept its shape through the action\'s change wait, and only then', () => {
    const recording = recorder();
    recording.record({ name: 'secondaryTap', node: redacted(menu) });
    recording.armedChange();
    recording.noteSettled(false);
    recording.record({ name: 'tap', node: redacted(rename) });
    recording.armedChange();
    recording.noteSettled(true);
    const trace = recording.finalize(conclusion)!;
    expect(trace.actions.map((action) => action.quiet)).toEqual([true, undefined]);
  });

  it('notes a settle against nothing when no action armed a change since the last one', () => {
    const recording = recorder();
    recording.record({ name: 'tap', node: redacted(rename) });
    recording.armedChange();
    recording.noteSettled(true);
    // A second settle with nothing armed in between says nothing about the tap.
    recording.noteSettled(false);
    expect(recording.finalize(conclusion)!.actions[0]!.quiet).toBeUndefined();
  });

  it('never marks an action dropped at the cap, nor the one before it', () => {
    const recording = recorder(1);
    recording.record({ name: 'tap', node: redacted(rename) });
    recording.armedChange();
    recording.noteSettled(true);
    recording.record({ name: 'secondaryTap', node: redacted(menu) });
    recording.armedChange();
    recording.noteSettled(false);
    const trace = recording.finalize(conclusion)!;
    expect(trace.actions).toHaveLength(1);
    expect(trace.actions[0]!.quiet).toBeUndefined();
  });

  it('paces a folded scroll in full, since nothing says which repeat was quiet', () => {
    const recording = recorder();
    recording.record({ name: 'scroll', direction: 'down' });
    recording.armedChange();
    recording.noteSettled(false);
    recording.record({ name: 'scroll', direction: 'down' });
    recording.armedChange();
    recording.noteSettled(false);
    const [scroll] = recording.finalize(conclusion)!.actions;
    expect(scroll).toMatchObject({ name: 'scroll', times: 2 });
    expect(scroll!.quiet).toBeUndefined();
  });

  it('lines its quiet actions up with a replayed entry only when the two lists match action for action', () => {
    const recording = recorder();
    recording.record({ name: 'secondaryTap', node: redacted(menu) });
    recording.armedChange();
    recording.noteSettled(false);
    recording.record({ name: 'tap', node: redacted(rename) });
    expect(recording.quietIndices(['secondaryTap', 'tap'])).toEqual([0]);
    expect(recording.quietIndices(['secondaryTap'])).toEqual([]);
    expect(recording.quietIndices(['tap', 'tap'])).toEqual([]);
  });
});

describe('quiet in an entry', () => {
  const trace: ActionTrace = {
    actions: [{ name: 'secondaryTap', summary: 'secondary-tap "report.pdf"', target: { role: 'listitem', name: 'report.pdf' }, quiet: true }],
    executor: { name: 'scripted' },
    summary: 'opened the menu',
    startPath: '/files',
  };

  it('round-trips, and an entry with any other value for it is not one this runner trusts', () => {
    const entry = JSON.parse(JSON.stringify(buildTraceEntry(trace)));
    expect(readTraceEntry(entry)?.payload.actions[0]).toEqual(trace.actions[0]);
    entry.payload.actions[0].quiet = false;
    expect(readTraceEntry(entry)).toBeUndefined();
    entry.payload.actions[0].quiet = 'yes';
    expect(readTraceEntry(entry)).toBeUndefined();
  });
});

describe('replayTrace pacing', () => {
  function host(paced: (number | undefined)[]): ReplayHost & { calls: string[] } {
    const calls: string[] = [];
    let next: number | undefined;
    const act = (name: string) => async () => {
      calls.push(name);
      paced.push(next);
      next = undefined;
    };
    return {
      calls,
      traceEligible: true,
      observe: async () => ({ kind: 'semantic', nodes: redactedNodes([menu, rename]), viewport: { width: 1280, height: 720 } }),
      actions: { secondaryTap: act('secondaryTap'), tap: act('tap'), pressKey: act('pressKey') } as unknown as ExecutorActions,
      paceNext: (ms) => {
        next = ms;
      },
      signal: new AbortController().signal,
      remainingMs: () => 60_000,
    };
  }

  it('asks for the short change wait right before an action its recording saw change nothing, and for no other', async () => {
    const paced: (number | undefined)[] = [];
    const replay = host(paced);
    const actions: RecordedAction[] = [
      { name: 'secondaryTap', summary: 'open the menu', target: { role: 'listitem', name: 'report.pdf' }, quiet: true },
      { name: 'tap', summary: 'tap Rename', target: { role: 'menuitem', name: 'Rename' } },
      { name: 'pressKey', summary: 'press ArrowLeft', key: 'ArrowLeft', quiet: true },
    ];
    const outcome = await replayTrace(replay, { actions, executor: { name: 'scripted' }, summary: 'renamed' });
    expect(outcome).toMatchObject({ completed: true, executed: 3 });
    expect(replay.calls).toEqual(['secondaryTap', 'tap', 'pressKey']);
    expect(paced).toEqual([QUIET_CHANGE_WAIT_MS, undefined, QUIET_CHANGE_WAIT_MS]);
  });
});

describe('flushStagedTraces and pacing', () => {
  async function fileStore(name: string) {
    const directory = await mkdtemp(join(tmpdir(), `e2e-pacing-${name}-`));
    const store = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
    const keyHash = 'e'.repeat(64);
    const context = (staged: AgentCacheContext['staged'][number]): AgentCacheContext => ({
      mode: 'read-write',
      store,
      replayEligible: true,
      strict: false,
      claimKey: () => ({ keyHash, step: conclusion.recordedFor }),
      staged: [staged],
    });
    return { store, keyHash, file: join(directory, `${keyHash}.json`), context };
  }

  const recorded = (quiet: boolean): ActionTrace => ({
    actions: [
      { name: 'secondaryTap', summary: 'open the menu', target: { role: 'listitem', name: 'report.pdf' }, ...(quiet ? { quiet: true as const } : {}) },
      { name: 'tap', summary: 'tap Rename', target: { role: 'menuitem', name: 'Rename' } },
    ],
    executor: { name: 'scripted' },
    recordedFor: { ...conclusion.recordedFor, callIndex: 0, paramsDigest: 'a'.repeat(64), agent: 'default' },
    summary: 'renamed',
    startPath: '/files',
    endAnchors: [{ role: 'textbox', name: 'File name' }],
  });

  it('gives an entry recorded before pacing the pacing of the first recording that has it, then holds it', async () => {
    const { store, keyHash, file, context } = await fileStore('write');
    const settle = (trace: ActionTrace) => flushStagedTraces(context({ kind: 'write', keyHash, stepIndex: 0, trace }), { lastVerifiedStepIndex: 1, implicatesUnconfirmed: true });
    await store.write(keyHash, recorded(false));
    const unpaced = await readFile(file, 'utf8');
    await settle(recorded(true));
    const paced = await readFile(file, 'utf8');
    expect(paced).not.toBe(unpaced);
    expect(JSON.parse(paced).payload.actions[0].quiet).toBe(true);
    // A later run that happened not to see the menu settle quietly is a timing, not a new flow.
    await settle(recorded(false));
    expect(await readFile(file, 'utf8')).toBe(paced);
  });

  it('writes the pacing a whole replay saw into a kept entry recorded before it, and never over pacing it has', async () => {
    const { store, keyHash, file, context } = await fileStore('keep');
    const keep = (quiet: readonly number[]) =>
      flushStagedTraces(context({ kind: 'keep', keyHash, stepIndex: 0, recordedFor: recorded(false).recordedFor!, quiet }), {
        lastVerifiedStepIndex: 1,
        implicatesUnconfirmed: true,
      });
    await store.write(keyHash, recorded(false));
    await keep([0]);
    const paced = await readFile(file, 'utf8');
    expect(JSON.parse(paced).payload.actions.map((action: RecordedAction) => action.quiet)).toEqual([true, undefined]);
    await keep([1]);
    expect(await readFile(file, 'utf8')).toBe(paced);
    // An index past the entry's actions is another list's, and is ignored.
    const { store: other, keyHash: otherKey, file: otherFile, context: otherContext } = await fileStore('keep-range');
    await other.write(otherKey, recorded(false));
    const before = await readFile(otherFile, 'utf8');
    await flushStagedTraces(otherContext({ kind: 'keep', keyHash: otherKey, stepIndex: 0, recordedFor: recorded(false).recordedFor!, quiet: [5] }), {
      lastVerifiedStepIndex: 1,
      implicatesUnconfirmed: true,
    });
    expect(await readFile(otherFile, 'utf8')).toBe(before);
  });
});
