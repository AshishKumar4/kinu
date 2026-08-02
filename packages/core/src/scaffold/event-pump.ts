/**
 * ScaffoldEvent pump — the one place a scaffold run becomes a stream.
 *
 * `runScaffold` reports progress through an `emit(ScaffoldEvent)` callback, but
 * every consumer wants a stream: the DO backend renders an AI-SDK UI message
 * stream (`ui-stream.ts`), the CLI backend renders `runChat`'s ChatEvent stream
 * (`chat-transform.ts`). Both need the same push→pull bridge — kick the run off,
 * drain emitted events as they arrive, stop at `done`, and finish with the
 * `ScaffoldRunResult` so a failed run can be surfaced in the consumer's own
 * vocabulary. That bridge lives here once so the two backends cannot drift.
 */

import type { ScaffoldEvent, ScaffoldEmitFn, ScaffoldRunResult } from './executor.js';

/**
 * Drive a scaffold run and yield its events in order, returning the run's
 * result. The final `done` event IS yielded (consumers close their envelope on
 * it); nothing is yielded after it. A run that settles without emitting `done`
 * simply ends the stream.
 */
export async function* pumpScaffoldEvents(
  run: (emit: ScaffoldEmitFn) => Promise<ScaffoldRunResult>,
): AsyncGenerator<ScaffoldEvent, ScaffoldRunResult> {
  const queue: ScaffoldEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;

  const wake = () => {
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(); }
  };
  const emit: ScaffoldEmitFn = (event) => { queue.push(event); wake(); };

  // Mark finished when the run settles, so the drain loop terminates even if
  // the scaffold never emits a 'done'.
  const runPromise = run(emit).finally(() => { finished = true; wake(); });

  for (;;) {
    if (queue.length === 0) {
      if (finished) break;
      await new Promise<void>((resolve) => { resolveNext = resolve; });
      continue;
    }
    const event = queue.shift()!;
    yield event;
    if (event.type === 'done') break;
  }

  return await runPromise;
}
