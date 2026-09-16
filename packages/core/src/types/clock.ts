/**
 * The one clock seam.
 *
 * Time inside a subject is a clock the subject is handed (D19,
 * docs/DEVBOX-DECISIONS.md): production hands `REAL_CLOCK`, a test hands a
 * clock it advances, so "the deadline passed" is a step the test takes and
 * never a sleep racing a real timer. One shape for every subject — the SSE
 * poll pacing, the device tunnel's probes, the head budget, the detach
 * threshold, the web fetch budget, the device status TTL — so a test-utils
 * hand clock drives all of them and no suite hand-writes its own.
 *
 * The shape is the devbox package's `StartClock` (which cannot import this
 * package and declares the same two members): a structural match, so one
 * hand clock drives both.
 */
export interface Clock {
  /** What time it is, in milliseconds. */
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

/** A pause on the clock: resolves after `ms`. */
export function waitOn(clock: Clock, ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  clock.after(ms, resolve);

  return promise;
}

/** A repeating timer on the clock, re-armed after each firing; the answer
 *  stops it. Built on `after` so a hand clock needs no second primitive. */
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
