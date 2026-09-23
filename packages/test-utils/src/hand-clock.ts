/** A clock a test advances; `whenArmed(n)` lets a test wait for a subject to reach its wait. It imports
 *  nothing, so a package that must not reach core (devbox) drives its subjects with the same clock. */

/** The shape core's `Clock` and devbox's `StartClock` share (D19, docs/DEVBOX-DECISIONS.md). */
interface ArmableClock {
  now(): number;
  after(ms: number, fire: () => void): () => void;
}

export interface HandClock extends ArmableClock {
  /** Move the clock forward, firing every timer due inside the step. */
  advance(ms: number): void;
  /** Move to the earliest armed timer and fire it alone. */
  tick(): void;
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
