import { detach } from '@kinu.run/core/obs';
import { Effect } from 'effect';

/** Node fires a delay past this at once; a later wake waits this long and is asked for again. */
const LONGEST_TIMER_MS = 2_147_483_647;

/**
 * One timer for the earliest wake asked of it: an ask no sooner than the armed one is already covered, and `clear`
 * forgets it. `fire` answers its own failures. An unreferenced slot never holds the process open.
 */
export class WakeSlot {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #at: number | null = null;

  constructor(private readonly options: { readonly fire: () => Promise<void>; readonly unref: boolean }) {}

  /** When it fires next, or null. */
  get at(): number | null {
    return this.#at;
  }

  arm(at: number): void {
    if (this.#at !== null && this.#at <= at) return;
    this.clear();
    this.#at = at;

    const timer = setTimeout(() => {
      this.clear();
      detach(Effect.promise(() => this.options.fire()));
    }, Math.min(Math.max(0, at - Date.now()), LONGEST_TIMER_MS));

    if (this.options.unref) timer.unref();
    this.#timer = timer;
  }

  clear(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#at = null;
  }
}
