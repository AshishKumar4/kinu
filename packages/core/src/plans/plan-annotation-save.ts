import { serialQueue } from '@kinu.run/agent-utils';

export interface PlanAnnotationSaveQueue<T> {
  enqueue(values: readonly T[]): Promise<boolean>;
  pending(): number;
}

/** Keeps same-revision annotation replacements in user-action order. */
export function createPlanAnnotationSaveQueue<T>(
  write: (values: readonly T[]) => Promise<boolean>,
): PlanAnnotationSaveQueue<T> {
  const inOrder = serialQueue();
  let pending = 0;

  return {
    enqueue(values) {
      const snapshot = [...values];
      pending++;

      return inOrder(() => write(snapshot)).finally(() => { pending--; });
    },
    pending: () => pending,
  };
}
