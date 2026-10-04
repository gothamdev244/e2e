/**
 * Zero-turn trace replay.
 *
 * Replays one recorded trace through the same action grammar the executor
 * uses — every replayed action runs under the step's deadline, action budget,
 * origin policy, secret authorization, and recording. No model is called.
 *
 * Adaptive, never fatal: any reason the trace cannot finish — a gap, a target
 * that moved, an action the live app rejected — ends the replayed prefix and
 * hands the step to the executor mid-step. Runtime hard stops (budget,
 * timeout, cancellation) rethrow untouched; they are the step's truth, not a
 * divergence.
 */

import { isRelocatableDescriptor, MAIN_LIST_SHARE, relocateRecorded, type RelocationFailure, type RelocationResult } from '../cache/relocate.ts';
import { isNodeAction, type ActionTrace, type DerivedReason, type RecordedAction, type TraceTargetDescriptor, type TraceViewport } from '../cache/trace.ts';
import type { SemanticNode, ViewportPoint } from '../engine/surface.ts';
import { describeTarget } from './actions.ts';
import type { RedactedNode } from './observation.ts';
import { hasCause } from '../internal/errors.ts';
import { containsPoint, type Box } from '../internal/geometry.ts';
import { sleep } from '../internal/time.ts';
import type { ScrollDirection } from '../types.ts';
import {
  isRuntimeHardStop,
  type ExecutorActions,
  type ExecutorTarget,
  type ReplayHandOffReason,
} from './executor.ts';
import { SETTLE_AFTER, type SettleMode } from './settle-policy.ts';

/** Backoff between looks at the screen while it settles. */
const RETRY_DELAYS_MS = [100, 300, 600, 1_000, 3_000] as const;

/** Ceiling on one poll's total wait, inside whatever the deadline allows. */
const RETRY_TIMEOUT_MS = 15_000;

/** The nodes of one observation, keyed by their per-observation ids. */
export type ObservedNodes = ReadonlyMap<string, RedactedNode>;

/** One capture's location and viewport, with nodes only when semantic evidence is available. */
export type ObservedScreen = {
  readonly viewport: TraceViewport;
  /**
   * Where the capture was, as the cache compares it (`appLocation`): on the
   * app's own origin its path, query, and fragment; elsewhere the whole
   * location; a device's screen title as it is.
   */
  readonly path?: string;
} & (
  | { readonly kind: 'semantic'; readonly nodes: ObservedNodes }
  | { readonly kind: 'pixels' }
);

/** The only capture variant that can establish trace targets or anchors. */
export type SemanticScreen = Extract<ObservedScreen, { kind: 'semantic' }>;

/** What the replay engine needs from the dispatch, and nothing more. */
export interface ReplayHost {
  /** False once any capture in this step loses semantic evidence. */
  readonly traceEligible: boolean;
  /**
   * One capture, settled as far as `mode` asks: the dispatch's own, so a
   * replayed action never lands on a screen still reacting to the previous
   * one, and the pacing can never drift from the executor-facing observe.
   */
  observe(mode: SettleMode): Promise<ObservedScreen>;
  /** The step's policed action grammar; targets are fresh-observation ids. */
  readonly actions: ExecutorActions;
  readonly signal: AbortSignal;
  remainingMs(): number;
  /**
   * Sets the change wait the next action arms in place of its settle
   * policy's (`ActionDispatcher.paceNext`). Absent on a host that paces
   * every action by its policy.
   */
  paceNext?(changeWaitMs: number | undefined): void;
}

/**
 * The change wait after an action its recording saw leave the screen as it
 * was (`RecordedAction.quiet`): long enough for a change that starts in the
 * same frame to register, short enough that a replay does not spend the full
 * wait the recording spent proving nothing changed.
 */
export const QUIET_CHANGE_WAIT_MS = 300;

/**
 * The grammar with every call paced as quiet: each one asks the host for the
 * short change wait first, and clears it once the call settles, so a call
 * that fails before its action consumes the pace (a refused upload path)
 * never hands it to the next action, the executor's after a hand-off.
 */
function quietActions(host: ReplayHost): ExecutorActions {
  return new Proxy(host.actions, {
    get: (target, key, receiver) => {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        host.paceNext?.(QUIET_CHANGE_WAIT_MS);
        const clear = () => host.paceNext?.(undefined);
        let result: unknown;
        try {
          result = (value as (...args: unknown[]) => unknown).apply(target, args);
        } catch (cause) {
          clear();
          throw cause;
        }
        if (result instanceof Promise) return result.finally(clear);
        clear();
        return result;
      };
    },
  });
}

export interface ReplayOutcome {
  /** True when every recorded action executed; the step self-finalizes. */
  readonly completed: boolean;
  readonly executed: number;
  readonly total: number;
  /** Prose summaries of the executed actions, for the hand-off notice. */
  readonly summaries: readonly string[];
  /** Present exactly when `completed` is false. */
  readonly stopReason?: ReplayHandOffReason;
  /** The action whose commit state is unknown, on `action-uncertain` only. */
  readonly uncertainAction?: string;
  /** On a `gap` at a typed value: the rule that made the value this run's data. */
  readonly derived?: DerivedReason;
  /**
   * How many executed actions found their control only by a fallback rung
   * (`relocateRecorded`); absent when every one matched exactly.
   */
  readonly relocated?: number;
}

/** The list a recorded scroll moved, and the share of the viewport it covered. */
interface ScrolledList {
  readonly descriptor: TraceTargetDescriptor;
  readonly spans?: number;
}

/**
 * One recorded action bound to its grammar call. Built where the action's
 * variant is narrowed, so execution needs no casts and no non-null
 * assertions: a targeted plan cannot exist without its descriptor.
 */
type PlannedCall =
  | { readonly kind: 'gap'; readonly derived?: DerivedReason }
  | {
      readonly kind: 'targeted';
      readonly descriptor: TraceTargetDescriptor;
      readonly invoke: (target: ExecutorTarget) => Promise<void>;
    }
  | { readonly kind: 'free'; readonly invoke: () => Promise<void> }
  /**
   * A scroll, folded from its repeats, each replayed with a settled look
   * between them as the live loop took. A scrolled list is re-found before
   * every repeat, because a device renumbers its tree on each look and names
   * a scroll view after its first visible row. A list that filled the screen
   * when recorded (`spans`) and cannot be re-found scrolls as the viewport,
   * which is what scrolling the main list does; a smaller region hands off.
   * Without a list, the viewport itself is scrolled.
   */
  | {
      readonly kind: 'scroll';
      readonly direction: ScrollDirection;
      readonly times: number;
      readonly list?: ScrolledList;
    }
  /** A drag whose two nodes are re-found on one screen before the drag joins them. */
  | { readonly kind: 'drag'; readonly source: TraceTargetDescriptor; readonly destination: TraceTargetDescriptor }
  /** A list paged until a text showed: on the re-found list, on the viewport for a lost list that filled the screen, else a hand-off. */
  | { readonly kind: 'scrollUntil'; readonly text: string; readonly direction: ScrollDirection; readonly list?: ScrolledList }
  /** A bare point, replayed as given once the viewport is the recorded size. */
  | { readonly kind: 'point'; readonly point: ViewportPoint; readonly viewport: TraceViewport; readonly invoke: PointInvoke }
  /** A bare point placed inside a re-found node's live box. */
  | {
      readonly kind: 'within';
      readonly descriptor: TraceTargetDescriptor;
      readonly fx: number;
      readonly fy: number;
      /**
       * The recorded point and its viewport: among look-alikes of the node,
       * the one the point lies in on a viewport of the same size is it, and
       * when several nested ones hold it the point itself is acted on. The
       * bare point is never acted on once the node is gone.
       */
      readonly point: ViewportPoint;
      readonly viewport: TraceViewport;
      readonly invoke: PointInvoke;
    };

/** The point verb a recorded bare point replays through: `tapAt` or `hoverAt`. */
type PointInvoke = (point: ViewportPoint) => Promise<unknown>;

function planCall(action: RecordedAction, actions: ExecutorActions): PlannedCall {
  if (isNodeAction(action)) return { kind: 'targeted', descriptor: action.target, invoke: (t) => actions[action.name](t) };
  switch (action.name) {
    case 'tool':
      return { kind: 'gap', ...(action.derived === undefined ? {} : { derived: action.derived }) };
    case 'check':
      return { kind: 'targeted', descriptor: action.target, invoke: (t) => actions.check(t, action.checked) };
    case 'upload':
      return { kind: 'targeted', descriptor: action.target, invoke: (t) => actions.upload(t, action.paths) };
    case 'drag':
      return { kind: 'drag', source: action.target, destination: action.destination };
    case 'back':
      return { kind: 'free', invoke: () => actions.back() };
    case 'type':
      return {
        kind: 'targeted',
        descriptor: action.target,
        invoke: (t) => actions.type(t, action.value),
      };
    case 'typeSecret':
      return {
        kind: 'targeted',
        descriptor: action.target,
        invoke: (t) => actions.typeSecret(t, action.secret),
      };
    case 'press':
      return {
        kind: 'targeted',
        descriptor: action.target,
        invoke: (t) => actions.press(t, action.key),
      };
    case 'select':
      return {
        kind: 'targeted',
        descriptor: action.target,
        invoke: (t) => actions.select(t, action.value),
      };
    case 'scroll':
      return {
        kind: 'scroll',
        direction: action.direction,
        times: action.times ?? 1,
        ...(action.target === undefined
          ? {}
          : { list: { descriptor: action.target, ...(action.spans === undefined ? {} : { spans: action.spans }) } }),
      };
    case 'scrollUntil':
      return {
        kind: 'scrollUntil',
        text: action.text,
        direction: action.direction,
        ...(action.target === undefined
          ? {}
          : { list: { descriptor: action.target, ...(action.spans === undefined ? {} : { spans: action.spans }) } }),
      };
    case 'navigate':
      return { kind: 'free', invoke: () => actions.navigate(action.url) };
    case 'typeText':
      return { kind: 'free', invoke: () => actions.typeText(action.value, { replace: action.replace }) };
    case 'pressKey':
      return { kind: 'free', invoke: () => actions.pressKey(action.key) };
    case 'dismissKeyboard':
      return { kind: 'free', invoke: () => actions.dismissKeyboard() };
    case 'tapAt':
    case 'hoverAt': {
      const invoke: PointInvoke = (point) => actions[action.name](point);
      // A container the recorder kept before it learned to leave anonymous
      // ones out cannot be re-found; the point stands on its own, as recorded.
      return action.within === undefined || !isRelocatableDescriptor(action.within.target)
        ? { kind: 'point', point: action.point, viewport: action.viewport, invoke }
        : {
            kind: 'within',
            descriptor: action.within.target,
            fx: action.within.fx,
            fy: action.within.fy,
            point: action.point,
            viewport: action.viewport,
            invoke,
          };
    }
  }
}

export interface ReplayOptions {
  /**
   * The step's settled start capture. The first action's look reads it
   * instead of capturing again: nothing has happened since it was taken.
   */
  readonly initial?: SemanticScreen;
  /**
   * Asked before a free action (a navigate, typed text, a key) that follows
   * another action; true takes the look a targeted action would have taken.
   * A free action reads no screen, so without it the screen the previous
   * action left goes unseen.
   */
  readonly looksBeforeFree?: () => boolean;
}

/** Replays one trace until it completes or diverges. */
export async function replayTrace(
  host: ReplayHost,
  trace: ActionTrace,
  options: ReplayOptions = {},
): Promise<ReplayOutcome> {
  const summaries: string[] = [];
  const total = trace.actions.length;
  let relocated = 0;
  const drift = (): Pick<ReplayOutcome, 'relocated'> => (relocated === 0 ? {} : { relocated });
  const stop = (stopReason: ReplayHandOffReason, partial?: string): ReplayOutcome => {
    if (partial !== undefined) summaries.push(partial);
    return { completed: false, executed: summaries.length, total, summaries, stopReason, ...drift() };
  };

  let previous: RecordedAction | undefined;
  for (const action of trace.actions) {
    if (!host.traceEligible) return stop('action-failed');
    // An action its recording saw change nothing waits only a beat for a
    // change: the pace follows the recording, not the change timeout.
    const actions = action.quiet === true ? quietActions(host) : host.actions;
    const planned = planCall(action, actions);
    if (planned.kind === 'gap') {
      return { ...stop('gap'), ...(planned.derived === undefined ? {} : { derived: planned.derived }) };
    }
    // The look before this action: the start capture serves the first one;
    // after that, the previous action's settle policy says how far a fresh
    // capture settles.
    const look: Look =
      previous === undefined
        ? options.initial === undefined
          ? HELD_STILL
          : { kind: 'in-hand', screen: options.initial }
        : { kind: 'capture', settle: SETTLE_AFTER[previous.name].look };
    // Repeats of a folded scroll done before it failed moved the screen: the
    // hand-off counts them as executed, so the executor is not told the
    // screen is untouched.
    let repeated = 0;
    // Whether this action's control was found only by a fallback rung,
    // counted once the action ran.
    let fellBack = false;
    const note = (found: FoundTarget): void => {
      if (found.fallback !== undefined) fellBack = true;
    };
    const refind = async (descriptor: TraceTargetDescriptor, from: Look): Promise<Relocated> => {
      const result = await relocate(host, descriptor, from);
      if (result.kind === 'found') note(result);
      return result;
    };
    const partial = (): string | undefined =>
      repeated === 0 || planned.kind !== 'scroll' ? undefined : `${action.summary} (${String(repeated)} of ${String(planned.times)} repeats)`;
    try {
      switch (planned.kind) {
        case 'targeted': {
          const found = await refind(planned.descriptor, look);
          if (found.kind === 'failed') return stop(found.failure);
          await planned.invoke({ id: found.id });
          break;
        }
        case 'free':
          if (previous !== undefined && options.looksBeforeFree?.() === true) await firstLook(host, look);
          await planned.invoke();
          break;
        case 'scroll': {
          if (planned.list === undefined) {
            // A viewport scroll relocates nothing, so each later repeat takes
            // a settled look of its own, as the live loop did between them.
            for (let index = 0; index < planned.times; index += 1) {
              if (index > 0) await host.observe('held-still');
              // A folded scroll is paced in full whatever its entry says.
              await (planned.times > 1 ? host.actions : actions).scroll(planned.direction);
              repeated += 1;
            }
            break;
          }
          // A scroll on a list is paced by the relocation before each repeat.
          for (let index = 0; index < planned.times; index += 1) {
            const lost = await scrollOnce(host, refind, planned.direction, planned.list, index === 0 ? look : HELD_STILL);
            if (lost !== undefined) return stop(lost, partial());
            repeated += 1;
          }
          break;
        }
        case 'scrollUntil': {
          if (planned.list === undefined) {
            await actions.scrollUntil(planned.text, planned.direction);
            break;
          }
          const found = await refind(planned.list.descriptor, look);
          if (found.kind === 'found') await actions.scrollUntil(planned.text, planned.direction, { id: found.id });
          else if ((planned.list.spans ?? 0) >= MAIN_LIST_SHARE) await actions.scrollUntil(planned.text, planned.direction);
          else return stop(found.failure);
          break;
        }
        case 'drag': {
          const pair = await relocatePair(host, planned.source, planned.destination, look);
          if (pair.kind === 'failed') return stop(pair.failure);
          pair.ends.forEach(note);
          await actions.drag({ id: pair.ends[0].id }, { id: pair.ends[1].id });
          break;
        }
        case 'point': {
          const screen = await firstLook(host, look);
          if (screen.kind === 'pixels') return stop('action-failed');
          const { viewport } = screen;
          if (viewport.width !== planned.viewport.width || viewport.height !== planned.viewport.height) {
            return stop('viewport-changed');
          }
          await planned.invoke(planned.point);
          break;
        }
        case 'within': {
          const found = await refind(planned.descriptor, look);
          const at = placeWithin(found, planned);
          if (at === undefined) return stop(found.kind === 'failed' ? found.failure : 'target-not-found');
          await planned.invoke(at);
          break;
        }
      }
    } catch (cause) {
      if (isReplayFatal(cause, host.signal)) throw cause;
      if (isUncertainCommit(cause)) {
        // Input may have reached the app (spec 09): the hand-off must name
        // the uncertain action so the executor verifies before re-acting —
        // the runner never repeats an unknown-commit operation itself.
        return { ...stop('action-uncertain', partial()), uncertainAction: action.summary };
      }
      return stop('action-failed', partial());
    }
    summaries.push(action.summary);
    if (fellBack) relocated += 1;
    previous = action;
  }
  return { completed: true, executed: summaries.length, total, summaries, ...drift() };
}

/**
 * Waits for a trace's recorded end state on the live screen: `holds` (the
 * recorded delta, `cache/anchors.ts`) must be true of one look, or the
 * replay must not pass on its own. Waits on the same settling backoff
 * relocation uses, because the recording run's final look came seconds of
 * model latency after its last action and a replay's comes right away: a
 * save still in flight is a wait, not a divergence. A surface that cannot be
 * observed at all is a mismatch too — the executor gets the step and judges
 * the live state; only runtime hard stops propagate.
 */
export async function verifyEndState(
  host: ReplayHost,
  holds: (screen: SemanticScreen) => boolean,
  options: { readonly waitMs?: number; readonly initial?: SemanticScreen } = {},
): Promise<boolean> {
  const startedMs = Date.now();
  try {
    const present = await pollSettled(host, (screen) =>
      holds(screen) ? true : undefined,
      options.initial === undefined ? HELD_STILL : { kind: 'in-hand', screen: options.initial },
    );
    if (present === true) return true;
    // The settling backoff covers a slow re-render; the recorded run may have
    // waited far longer than that for its effect — a report that takes half a
    // minute — and so does the replay, up to what the recording needed, while
    // the step clock leaves room for a hand-off to act.
    const deadline = startedMs + Math.min(options.waitMs ?? 0, Math.max(0, host.remainingMs() - END_WAIT_RESERVE_MS));
    while (Date.now() < deadline && !host.signal.aborted) {
      await sleep(Math.min(END_WAIT_POLL_MS, deadline - Date.now()), host.signal);
      const screen = await host.observe('raw');
      if (screen.kind === 'pixels' || !host.traceEligible) return false;
      if (holds(screen)) return true;
    }
    return false;
  } catch (cause) {
    if (isReplayFatal(cause, host.signal)) throw cause;
    return false;
  }
}

/** Poll cadence while a replay waits for the recorded end state beyond the settling backoff. */
const END_WAIT_POLL_MS = 1_000;
/** Step clock kept back from that wait, so a hand-off still has room to act. */
const END_WAIT_RESERVE_MS = 20_000;

/**
 * Relocates one descriptor against the settling screen, looking again while
 * `retryable` says the failure may pass. A node only a fallback rung found
 * must be found the same way on the next look too (`FallbackSighting`).
 */
async function relocate(
  host: ReplayHost,
  descriptor: TraceTargetDescriptor,
  look: Look,
): Promise<Relocated> {
  let last: Relocated = { kind: 'failed', failure: 'target-not-found' };
  const sighting = new FallbackSighting();
  const settled = await pollSettled(host, (screen): Relocated | undefined => {
    const result = relocateRecorded(descriptor, screen.nodes);
    if (result.kind === 'failed') {
      sighting.reset();
      last = result.failure === 'target-not-found' ? result : { ...result, screen };
      return retryable(result, descriptor) ? undefined : last;
    }
    const node = screen.nodes.get(result.id);
    if (node === undefined || !sighting.confirms([result], screen.nodes)) return undefined;
    return { ...result, node };
  }, look);
  return settled ?? last;
}

/**
 * The second look a fallback match waits for. An exact match is the
 * recorded control; a fallback match kept only part of the recording, and a
 * screen still leaving (a wizard's previous page, whose "Next" shares the
 * test id of this page's "Save") can hold a node that part fits. So a node a
 * fallback found is acted on only when the next look finds the same node,
 * by the same rung, in the same place, again: a screen that moved on in
 * between fails the check, and the poll looks once more. The place is the
 * node's box, which also tells apart identical twins that swapped order
 * between the two looks, where the descriptor alone could not.
 */
class FallbackSighting {
  private previous: string | undefined;

  /** Forgets the last sighting: a look that found nothing breaks the run. */
  reset(): void {
    this.previous = undefined;
  }

  /** Whether `results` stand, recording them as the last sighting when a fallback found any of them. */
  confirms(results: readonly Extract<RelocationResult, { kind: 'found' }>[], nodes: ObservedNodes): boolean {
    if (results.every((result) => result.fallback === undefined)) return true;
    const seen = JSON.stringify(results.map((result) => {
      const node = nodes.get(result.id);
      return [result.fallback ?? null, node === undefined ? null : describeTarget(node) ?? null, placeOf(node)];
    }));
    const confirmed = seen === this.previous;
    this.previous = seen;
    return confirmed;
  }
}

/** A node's box rounded to whole pixels, or null without one: where it sits, as two looks compare it. */
function placeOf(node: RedactedNode | undefined): readonly number[] | null {
  const box = node?.rect;
  return box === undefined ? null : [box.x, box.y, box.width, box.height].map(Math.round);
}

/**
 * Re-finds a drag's two nodes on one screen, so the ids the drag joins name
 * the same look at the app: an engine that renumbers its tree per
 * observation would otherwise hand the drag a source from one screen and a
 * destination from the next. Waits like `relocate` does, and gives up the
 * same way: a missing node or a positioned twin is worth another look, an
 * unpositioned ambiguity is not.
 */
async function relocatePair(
  host: ReplayHost,
  source: TraceTargetDescriptor,
  destination: TraceTargetDescriptor,
  look: Look,
): Promise<
  | { readonly kind: 'found'; readonly ends: readonly [FoundTarget, FoundTarget] }
  | { readonly kind: 'failed'; readonly failure: RelocationFailure }
> {
  let last: RelocationFailure = 'target-not-found';
  const sighting = new FallbackSighting();
  const failed = (descriptor: TraceTargetDescriptor, result: Extract<RelocationResult, { kind: 'failed' }>) => {
    sighting.reset();
    last = result.failure;
    return retryable(result, descriptor) ? undefined : { kind: 'failed' as const, failure: result.failure };
  };
  const settled = await pollSettled(host, (screen) => {
    const from = relocateRecorded(source, screen.nodes);
    if (from.kind === 'failed') return failed(source, from);
    const to = relocateRecorded(destination, screen.nodes);
    if (to.kind === 'failed') return failed(destination, to);
    if (!sighting.confirms([from, to], screen.nodes)) return undefined;
    return { kind: 'found' as const, ends: [from, to] as const };
  }, look);
  return settled ?? { kind: 'failed', failure: last };
}

/**
 * Whether a failed relocation is worth another look. A missing target is: the
 * screen may still be settling. So is ambiguity for a descriptor that recorded
 * its position among twins: a form still rendering shows fewer of them than
 * the recording counted, and the count catches up. Ambiguity for a descriptor
 * without a position never is: two matching nodes will not become one by
 * waiting, and acting on either would be a guess.
 */
function retryable(result: Extract<RelocationResult, { kind: 'failed' }>, descriptor: TraceTargetDescriptor): boolean {
  return result.failure === 'target-not-found' || descriptor.position !== undefined || (result.failure === 'target-ambiguous' && result.conflict === true);
}

/** One relocated target, and the rung that found it. */
type FoundTarget = Extract<RelocationResult, { kind: 'found' }>;

/** A relocation with the node it found, or with the screen its look-alikes are on, for a replay that needs boxes. */
type Relocated =
  | (Extract<RelocationResult, { kind: 'found' }> & { readonly node: RedactedNode })
  | Extract<RelocationResult, { failure: 'target-not-found' }>
  | (Extract<RelocationResult, { failure: 'target-ambiguous' }> & { readonly screen: SemanticScreen });

/**
 * Where a recorded point lands on the live screen: its place inside the
 * re-found node's box, or among the visible look-alikes inside the one that
 * contains the recorded point on a viewport of the recorded size, as the hit
 * test that recorded it skipped
 * hidden nodes. Undefined when the node is gone or has no box, or the point
 * settles nothing: tapping the bare point could press whatever now sits there.
 */
function placeWithin(relocated: Relocated, planned: Extract<PlannedCall, { kind: 'within' }>): ViewportPoint | undefined {
  const inside = (box: Box): ViewportPoint => ({ x: box.x + planned.fx * box.width, y: box.y + planned.fy * box.height });
  if (relocated.kind === 'found') {
    const box = usableBox(relocated.node.rect);
    return box === undefined ? undefined : inside(box);
  }
  if (relocated.failure !== 'target-ambiguous' || relocated.conflict === true) return undefined;
  const { viewport, nodes } = relocated.screen;
  if (viewport.width !== planned.viewport.width || viewport.height !== planned.viewport.height) return undefined;
  const containing = relocated.candidates
    .map((id) => nodes.get(id))
    .filter((node): node is RedactedNode => node !== undefined && node.states?.hidden !== true)
    .map((node) => usableBox(node.rect))
    .filter((box): box is Box => box !== undefined && containsPoint(box, planned.point));
  if (containing.length === 1) return inside(containing[0]!);
  // Several look-alikes hold the point and nest: a host view and the view
  // inside it, a group inside a group, an anonymous container among its
  // kind. Whichever of them is the recorded node, the recorded point on a
  // viewport of the recorded size names the same pixel, and it is acted on
  // as a bare point would be. Siblings that merely overlap under the point
  // (two same-named controls stacked, and which one is on top may have
  // changed) stay ambiguous and hand off.
  return containing.length > 1 && nested(containing) ? planned.point : undefined;
}

/** Whether the boxes form one chain of containers, each holding the next smaller one, rather than siblings that overlap. */
function nested(boxes: readonly Box[]): boolean {
  const byArea = boxes.toSorted((a, b) => a.width * a.height - b.width * b.height);
  return byArea.every((box, index) => index === 0 || containsBox(box, byArea[index - 1]!));
}

function containsBox(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function usableBox(rect: SemanticNode['rect']): Box | undefined {
  return rect === undefined || rect.width <= 0 || rect.height <= 0 ? undefined : rect;
}

/**
 * One repeat of a folded scroll on a list: on the re-found list, on the
 * viewport for a lost list that filled the screen, or the failure to hand
 * the step off on.
 */
async function scrollOnce(
  host: ReplayHost,
  refind: (descriptor: TraceTargetDescriptor, look: Look) => Promise<Relocated>,
  direction: ScrollDirection,
  list: ScrolledList,
  look: Look,
): Promise<RelocationFailure | undefined> {
  const relocated = await refind(list.descriptor, look);
  if (relocated.kind === 'found') {
    await host.actions.scroll(direction, { id: relocated.id });
    return undefined;
  }
  if ((list.spans ?? 0) < MAIN_LIST_SHARE) return relocated.failure;
  await host.actions.scroll(direction);
  return undefined;
}

/**
 * The screen a poll starts from: one already in hand, which nothing has
 * happened to since it was captured, or a fresh capture settled as far as
 * the previous action requires.
 */
type Look =
  | { readonly kind: 'in-hand'; readonly screen: SemanticScreen }
  | { readonly kind: 'capture'; readonly settle: SettleMode };

/** A fresh look that proves the screen holds still: the first look of a replay without a start capture, and the look after an action that moved the screen. */
const HELD_STILL: Look = { kind: 'capture', settle: 'held-still' };

function firstLook(host: ReplayHost, look: Look): Promise<ObservedScreen> {
  switch (look.kind) {
    case 'in-hand':
      return Promise.resolve(look.screen);
    case 'capture':
      return host.observe(look.settle);
  }
}

/**
 * Probes the first look, then re-probes fresh raw captures on a fixed
 * backoff until the probe answers or the wait runs out: a screen
 * mid-transition gets a few looks before replay gives the step up. The first
 * look settles as far as the previous action's policy asks, because replay
 * executes recorded actions far faster than the run that recorded them;
 * without that wait an action can land while the app is still reacting to
 * the previous one (a form mid-clear, a list mid-update) and commit
 * something the recorded run never did. A screen the caller already settled
 * (the step's start capture) is read as it is.
 */
async function pollSettled<T>(
  host: ReplayHost,
  probe: (screen: SemanticScreen) => T | undefined,
  look: Look,
): Promise<T | undefined> {
  const startedMs = Date.now();
  let screen = await firstLook(host, look);
  for (let attempt = 0; ; attempt += 1) {
    if (screen.kind === 'pixels' || !host.traceEligible) return undefined;
    const answer = probe(screen);
    if (answer !== undefined) return answer;
    // The backoff's last delay repeats until the wait runs out: the list
    // shapes the first looks, the timeout bounds them, as the docs promise.
    const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
    if (Date.now() - startedMs + delay > RETRY_TIMEOUT_MS || host.remainingMs() <= delay) {
      return undefined;
    }
    await sleep(delay, host.signal);
    screen = await host.observe('raw');
  }
}

/** True when any error in the cause chain reports an unknown commit state. */
function isUncertainCommit(cause: unknown): boolean {
  return hasCause(cause, ({ code }) => code === 'ACTION_MAY_HAVE_COMMITTED');
}

/**
 * True for errors a replay must surface rather than absorb as divergence:
 * runtime hard stops and cancellation are the step's own accounting.
 */
function isReplayFatal(cause: unknown, signal: AbortSignal): boolean {
  return signal.aborted || isRuntimeHardStop(cause);
}
