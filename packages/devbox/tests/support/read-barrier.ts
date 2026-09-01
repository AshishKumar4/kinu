/**
 * A group barrier for store reads: the instrument that makes "this reader
 * serializes" a fact a test can assert instead of a duration it measures.
 *
 * Every read parks here until `width` of them are parked TOGETHER, and then
 * all of them settle at once. A reader that awaits its reads one after another
 * can never assemble a group, so it is released by the other trigger — a
 * `setImmediate`, which runs once the event loop has nothing left to do, and
 * for a reader whose only pending work is this park that means nobody else is
 * coming. The serialized reader therefore still FINISHES, with `widest` at
 * one, and the assertion fails on the fan-in it never reached.
 *
 * NO DURATION IS WAITED ON, deliberately: a wall-clock patience would put its
 * own latency into every green run and would turn a loaded machine into a
 * failure. The loop-idle turn is the signal, and a reader that does fan out
 * fills the group in the same turn it issues its reads.
 */
export interface ReadBarrier {
  /** The most reads this barrier ever held at once. */
  readonly widest: number;
  /** Park one read until its group fills or the loop goes idle. */
  hold(): Promise<void>;
}

export function readBarrier(width: number): ReadBarrier {
  let parked: (() => void)[] = [];
  let widest = 0;
  const admit = (): void => {
    const waiting = parked;
    parked = [];
    for (const resume of waiting) resume();
  };
  return {
    get widest(): number {
      return widest;
    },
    hold: async (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      parked.push(resolve);
      widest = Math.max(widest, parked.length);
      if (parked.length >= width) admit();
      else setImmediate(admit);
      await promise;
    },
  };
}
