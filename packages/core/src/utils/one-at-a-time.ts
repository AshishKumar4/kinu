/** A call while `load` runs shares one more run after it: a burst is two reads, not one per call. */
export function oneAtATime<T>(load: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  let next: Promise<T> | null = null;

  const start = (): Promise<T> => {
    const run = load().finally(() => {
      if (running === run) running = null;
    });

    running = run;

    return run;
  };

  return () => {
    if (running === null) return start();

    const after = (): Promise<T> => {
      next = null;

      return start();
    };

    next ??= running.then(after, after);

    return next;
  };
}
