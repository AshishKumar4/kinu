/** Group barrier for store reads: turns "this reader serializes" into an assertable `widest`.
 *  Releases on a full group or loop idle (`setImmediate`), never a duration, so load can't fail it. */
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
