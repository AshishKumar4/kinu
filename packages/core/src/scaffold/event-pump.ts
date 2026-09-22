/** Push→pull bridge from `runScaffold`'s emit callback to a stream, shared by the DO and CLI backends. */

import type { ScaffoldEvent, ScaffoldEmitFn, ScaffoldRunResult } from './executor';

/** Yields events through `done` inclusive, then returns the run's result. */
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

  // Ends the drain even if the scaffold never emits 'done'.
  const runPromise = run(emit).finally(() => { finished = true; wake(); });

  for (;;) {
    const event = queue.shift();

    if (event === undefined) {
      if (finished) break;
      await new Promise<void>((resolve) => { resolveNext = resolve; });
      continue;
    }

    yield event;

    if (event.type === 'done') break;
  }

  return await runPromise;
}
