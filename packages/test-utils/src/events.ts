// RunEvent stream assertions — verify ordered sequences of typed events.
import type { RunEvent, RunEventType } from '@proteus/core';

/** Loose matcher: each entry is either a type-only check or a partial-match. */
export type EventMatcher = RunEventType | Partial<RunEvent> & { type: RunEventType };

/** Assert that `events` contains a contiguous subsequence matching `matchers`.
 *  Use for "we saw run_start → text_delta → turn_end in order" assertions
 *  without caring about other event types interleaved. */
export function assertEventSequence(
  events: ReadonlyArray<RunEvent>,
  matchers: ReadonlyArray<EventMatcher>,
): { ok: boolean; missing?: EventMatcher; at?: number } {
  let i = 0;
  for (const m of matchers) {
    const want = typeof m === 'string' ? { type: m } : m;
    while (i < events.length) {
      const ev = events[i];
      if (matchesEvent(ev, want)) {
        i++;
        break;
      }
      i++;
    }
    if (i > events.length) return { ok: false, missing: m, at: i };
  }
  return { ok: true };
}

function matchesEvent(ev: RunEvent, want: Partial<RunEvent> & { type: RunEventType }): boolean {
  if (ev.type !== want.type) return false;
  for (const [k, v] of Object.entries(want)) {
    if (k === 'type') continue;
    const actual = (ev as unknown as Record<string, unknown>)[k];
    if (actual !== v) return false;
  }
  return true;
}

/** Collect events from any AsyncIterable<RunEvent> (e.g. an InferenceLoop run). */
export async function collectEvents(stream: AsyncIterable<RunEvent>, limit = 1000): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) {
    out.push(ev);
    if (out.length >= limit) break;
  }
  return out;
}
