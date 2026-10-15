import { beginLoaderFetchWhenFree, loaderLedgerStats, withDynamicWorkerCapNamed } from '@nimbus-sh/fabric/budgets.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { Cause, Effect, Exit } from 'effect';
import { KinuError, settle } from '@kinu.run/core/obs';
import type { AgentFacetCalls } from './agent-facet/agent-facet';

const REFUSED = 'Dynamic worker concurrency limit exceeded';

/** The platform's refusal of a call it never ran, or null. */
function refusedBy(exit: Exit.Exit<unknown, unknown>): Error | null {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.squash(exit.cause);

  if (classifyError(failure) !== 'dynamic_worker_cap') return null;

  return failure instanceof Error ? failure : new Error(REFUSED);
}

/** Fabric's ledger admits waits in order and pauses after a refusal; only Kinu knows when no wait can end. */
export class AgentIsolateSlots {
  /** Keys Kinu has asked to hold, and how many times: with none of them held, nothing here will free a slot. */
  readonly #asked = new Map<string, number>();

  /** Calls of Kinu's that ran and ended: each freed a platform slot. */
  #ended = 0;

  constructor(private readonly ledger: DurableObjectState) {}

  #oursHeld(ledger = loaderLedgerStats(this.ledger)): boolean {
    return ledger.inFlightWorkers.some((key) => this.#asked.has(key));
  }

  #ask(key: string, by: number): void {
    const count = (this.#asked.get(key) ?? 0) + by;

    if (count === 0) this.#asked.delete(key);
    else this.#asked.set(key, count);
  }

  #cap(refusal: Error): KinuError {
    return new KinuError('unavailable', withDynamicWorkerCapNamed(this.ledger, refusal).message, { cause: refusal });
  }

  /** One call into the isolate under `key`, made once `first` has run, holding a platform slot while it runs. */
  call<A>(
    key: string, open: () => Promise<AgentFacetCalls>, call: (isolate: AgentFacetCalls) => Promise<A>, first: Effect.Effect<unknown, KinuError> = Effect.void,
  ): Promise<A> {
    return settle(Effect.andThen(first, this.#held(key, open, call)));
  }

  #held<A>(key: string, open: () => Promise<AgentFacetCalls>, call: (isolate: AgentFacetCalls) => Promise<A>): Effect.Effect<A, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const isolate = yield* Effect.promise(open);

      for (;;) {
        const ledger = loaderLedgerStats(this.ledger);

        // No headroom during a refusal's pause is not a full ledger: the pause ends by itself. Asked last: free room is
        // the common case, and the ledger is read once a call.
        if (ledger.headroom === 0 && ledger.pauseMs === 0 && !ledger.inFlightWorkers.includes(key) && !this.#oursHeld(ledger)) {
          return yield* Effect.fail(this.#cap(new Error(`${REFUSED}: every slot is held`)));
        }

        this.#ask(key, 1);
        const end = yield* Effect.promise(() => beginLoaderFetchWhenFree(this.ledger, key));
        const sent = this.#ended;

        const exit = yield* Effect.exit(Effect.tryPromise({ try: () => call(isolate), catch: (cause) => cause })).pipe(
          Effect.onExit((settled) => Effect.sync(() => {
            const refusal = Exit.isSuccess(settled) ? refusedBy(settled.value) : null;
            end(refusal ?? undefined);
            this.#ask(key, -1);

            if (refusal === null) this.#ended += 1;
          })),
        );

        if (Exit.isSuccess(exit)) return exit.value;
        const refused = refusedBy(exit);

        if (refused === null) return yield* Effect.die(Cause.squash(exit.cause));

        // A slot of Kinu's freed while the refusal was on its way is room; with none held or freed, none will come.
        if (!this.#oursHeld() && this.#ended === sent) return yield* Effect.fail(this.#cap(refused));
      }
    });
  }
}
