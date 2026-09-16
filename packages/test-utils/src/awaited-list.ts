/**
 * A list a test can wait on.
 *
 * The end condition for "the subject produced N of these" is the push that
 * makes it true, so a wait here resolves inside `push` and never polls. A
 * predicate that never becomes true is a wait that never ends — which is the
 * rule: the process's own end (the harness teardown, the ladder's gate
 * deadline) ends it and names the suite, never a clock inside the test.
 */
export class AwaitedList<T> {
  readonly items: T[] = [];

  private readonly waiting: { readonly holds: (items: readonly T[]) => boolean; readonly resolve: () => void }[] = [];

  push(item: T): void {
    this.items.push(item);

    for (const waiter of this.waiting.splice(0)) {
      if (waiter.holds(this.items)) waiter.resolve();
      else this.waiting.push(waiter);
    }
  }

  /** Resolves once `holds` is true of the items, now or after a later push. */
  until(holds: (items: readonly T[]) => boolean): Promise<void> {
    if (holds(this.items)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiting.push({ holds, resolve });

    return promise;
  }
}
