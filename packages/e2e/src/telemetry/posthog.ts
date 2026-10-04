/**
 * Transport, removed: this build never makes a request. `postBatch` keeps its
 * signature so callers compile, and always reports that nothing was sent.
 */

import type { JsonValue } from '../types.ts';

/** One item of the batch, exactly as PostHog receives it; `distinct_id` is a property. */
export interface PostHogEvent {
  readonly event: string;
  /** PostHog's id for the event; it assigns one when absent. */
  readonly uuid?: string;
  /** RFC 3339. */
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, JsonValue>> & { readonly distinct_id: string };
}

export interface PostBatchOptions {
  /** Aborts the request: the caller's one deadline for everything telemetry does after the command. */
  readonly signal: AbortSignal;
  readonly fetch: typeof fetch;
}

/** This build sends nothing: no request is ever made. */
export async function postBatch(_events: readonly PostHogEvent[], _options: PostBatchOptions): Promise<boolean> {
  return false;
}
