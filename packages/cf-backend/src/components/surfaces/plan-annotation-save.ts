export interface PlanAnnotationSaveQueue<T> {
  enqueue(values: readonly T[]): Promise<boolean>;
  pending(): number;
}

/** Keeps same-revision annotation replacements in user-action order. */
export function createPlanAnnotationSaveQueue<T>(
  write: (values: readonly T[]) => Promise<boolean>,
): PlanAnnotationSaveQueue<T> {
  let tail = Promise.resolve();
  let pending = 0;

  return {
    enqueue(values) {
      const snapshot = [...values];
      pending++;
      const result = tail.then(() => write(snapshot));
      tail = result.then(
        () => { pending--; },
        () => { pending--; },
      );
      return result;
    },
    pending: () => pending,
  };
}
