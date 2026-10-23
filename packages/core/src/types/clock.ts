/**
 * Time inside a subject is a clock it is handed (D19, docs/DEVBOX-DECISIONS.md). Structurally
 * matches devbox's `StartClock`, so one hand clock drives both.
 */
export interface Clock {
  now(): number;
  /** Arm `fire` after `ms`; the answer disarms it. */
  after(ms: number, fire: () => void): () => void;
}

export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);

    return () => { clearTimeout(timer); };
  },
};

export function waitOn(clock: Clock, ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  clock.after(ms, resolve);

  return promise;
}

/** Lets the event loop run whatever is waiting before this continues: a yield, not a wait (no time passes for it). Work
 *  that can take long in one isolate turn yields between its slices; see the drawn page's slice. */
export function nextLoopTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);

  return promise;
}

/** Re-arms `after` on each firing, so a hand clock needs no second primitive. */
export function every(clock: Clock, ms: number, fire: () => void): () => void {
  let cancel: () => void = () => {};

  let stopped = false;

  const arm = (): void => {
    cancel = clock.after(ms, () => {
      if (stopped) return;
      fire();

      if (!stopped) arm();
    });
  };

  arm();

  return () => {
    stopped = true;
    cancel();
  };
}
