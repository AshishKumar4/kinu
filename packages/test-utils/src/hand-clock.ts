/**
 * The one hand clock: a `Clock` a test advances.
 *
 * Every timer a subject arms is a row here; `advance(ms)` moves the clock and
 * fires what came due, in due order, so a subject that re-arms inside a
 * firing (a repeating probe, a poll loop's next wait) is fired again on the
 * same advance when its next due time is inside it. `whenArmed(n)` resolves
 * once `n` timers have ever been armed: the way a test waits for a subject
 * to REACH its wait before stepping past it, instead of assuming the order
 * of two continuations.
 */
import type { Clock } from '@kinu.run/core';

export interface HandClock extends Clock {
  /** Move the clock forward, firing every timer due inside the step. */
  advance(ms: number): void;
  /** Move to the earliest armed timer and fire it alone. */
  tick(): void;
  /** Timers armed and not yet fired or disarmed. */
  armed(): number;
  /** Resolves once `count` timers have ever been armed. */
  whenArmed(count: number): Promise<void>;
}

interface Armed { readonly due: number; readonly fire: () => void }

export function handClock(startAt = 0): HandClock {
  let now = startAt;
  let sequence = 0;
  let everArmed = 0;
  const timers = new Map<number, Armed>();
  const waiting: { readonly count: number; readonly resolve: () => void }[] = [];

  const earliest = (): [number, Armed] | undefined => {
    let found: [number, Armed] | undefined;

    for (const entry of timers) {
      if (found === undefined || entry[1].due < found[1].due) found = entry;
    }

    return found;
  };

  const fire = (entry: [number, Armed]): void => {
    timers.delete(entry[0]);
    now = Math.max(now, entry[1].due);
    entry[1].fire();
  };

  return {
    now: () => now,
    after: (ms, callback) => {
      const id = sequence += 1;
      timers.set(id, { due: now + Math.max(0, ms), fire: callback });
      everArmed += 1;

      for (const waiter of waiting.splice(0)) {
        if (everArmed >= waiter.count) waiter.resolve();
        else waiting.push(waiter);
      }

      return () => { timers.delete(id); };
    },
    advance: (ms) => {
      const target = now + ms;

      for (let next = earliest(); next !== undefined && next[1].due <= target; next = earliest()) fire(next);
      now = target;
    },
    tick: () => {
      const next = earliest();

      if (next !== undefined) fire(next);
    },
    armed: () => timers.size,
    whenArmed: (count) => {
      if (everArmed >= count) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiting.push({ count, resolve });

      return promise;
    },
  };
}
