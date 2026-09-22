/**
 * A list a test can wait on. Waits resolve inside `push` and never poll; a wait that never holds is
 * ended by the harness teardown or gate deadline, never by a clock inside the test.
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
