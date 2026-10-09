/**
 * The programs an invocation's own work launched that have not ended. A program's launcher is a request made from the
 * context of the invocation whose work launched it, and a promise in flight when that invocation returns is cancelled
 * with it (do.background_task.cancelled_on_reset): on staging a launcher run was declared hung within a second of the
 * alarm its work started under returning (research HUNG-RPC: launcher runs that outlived their parent). An invocation
 * that holds runs its work as the holder of every program that work launches, now or later, and waits for them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Effect } from 'effect';
import { hold } from '../obs/index';

const holder = new AsyncLocalStorage<ProgramsInFlight>();

/** `run`, counted by the invocation whose work launched it, when that invocation holds its programs. */
export function launched<A>(run: Promise<A>): Promise<A> {
  holder.getStore()?.add(run);

  return run;
}

export class ProgramsInFlight {
  /** Each running program, by the run that settles as it leaves. */
  private readonly running = new Map<Promise<unknown>, Promise<unknown>>();
  private readonly waiters = new Set<() => void>();

  get size(): number {
    return this.running.size;
  }

  /** `body` runs as the holder of the programs it launches, and of those the work it starts launches later. */
  run<A>(body: () => Promise<A>): Promise<A> {
    return holder.run(this, body);
  }

  add(run: Promise<unknown>): void {
    // Its outcome is its launcher's to read; this reads only that it ended.
    this.running.set(run, hold(Effect.ensuring(Effect.promise(() => run), Effect.sync(() => {
      this.running.delete(run);

      for (const wake of this.waiters) wake();
    }))));
  }

  /**
   * Waits until none runs, programs launched while it waits included, or until `until`. Answers how many were still
   * running when `until` came first; zero when all of them ended.
   */
  async settled(until: Promise<void>): Promise<number> {
    const out = until.then(() => 'out' as const);

    while (this.running.size > 0) {
      const moved = Promise.withResolvers<'moved'>();
      const wake = (): void => { moved.resolve('moved'); };

      this.waiters.add(wake);

      try {
        // Read again once listening: a program that ended before the waiter joined would never wake it.
        if (this.running.size === 0) break;

        if (await Promise.race([moved.promise, out]) === 'out') break;
      } finally {
        this.waiters.delete(wake);
      }
    }

    return this.running.size;
  }
}
