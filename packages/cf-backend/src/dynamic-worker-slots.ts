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

  #oursHeld(): boolean {
    return loaderLedgerStats(this.ledger).inFlightWorkers.some((key) => this.#asked.has(key));
  }

  #ask(key: string, by: number): void {
    const count = (this.#asked.get(key) ?? 0) + by;

    if (count === 0) this.#asked.delete(key);
    else this.#asked.set(key, count);
  }

  #cap(refusal: Error): KinuError {
    return new KinuError('unavailable', withDynamicWorkerCapNamed(this.ledger, refusal).message, { cause: refusal });
  }

  held<A>(key: string, open: () => Promise<AgentFacetCalls>, call: (isolate: AgentFacetCalls) => Promise<A>): Effect.Effect<A, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const isolate = yield* Effect.promise(open);

      for (;;) {
        const ledger = loaderLedgerStats(this.ledger);

        // No headroom during a refusal's pause is not a full ledger: the pause ends by itself.
        if (!this.#oursHeld() && !ledger.inFlightWorkers.includes(key) && ledger.pauseMs === 0 && ledger.headroom === 0) {
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

export function agentCallsThrough(through: <A>(call: (isolate: AgentFacetCalls) => Promise<A>) => Effect.Effect<A, KinuError>): AgentFacetCalls {
  return {
    run: (...args) => settle(through((isolate) => isolate.run(...args))),
    enqueue: (...args) => settle(through((isolate) => isolate.enqueue(...args))),
    send: (...args) => settle(through((isolate) => isolate.send(...args))),
    admit: (...args) => settle(through((isolate) => isolate.admit(...args))),
    retry: (...args) => settle(through((isolate) => isolate.retry(...args))),
    interruptChat: (...args) => settle(through((isolate) => isolate.interruptChat(...args))),
    wake: (...args) => settle(through((isolate) => isolate.wake(...args))),
    modelSettingsChanged: (...args) => settle(through((isolate) => isolate.modelSettingsChanged(...args))),
    owed: (...args) => settle(through((isolate) => isolate.owed(...args))),
    idle: (...args) => settle(through((isolate) => isolate.idle(...args))),
    history: (...args) => settle(through((isolate) => isolate.history(...args))),
    historyPage: (...args) => settle(through((isolate) => isolate.historyPage(...args))),
    messageCount: (...args) => settle(through((isolate) => isolate.messageCount(...args))),
    inspect: (...args) => settle(through((isolate) => isolate.inspect(...args))),
    inheritedContext: (...args) => settle(through((isolate) => isolate.inheritedContext(...args))),
    workingContext: (...args) => settle(through((isolate) => isolate.workingContext(...args))),
    turnRequests: (...args) => settle(through((isolate) => isolate.turnRequests(...args))),
    turnRequest: (...args) => settle(through((isolate) => isolate.turnRequest(...args))),
    spend: (...args) => settle(through((isolate) => isolate.spend(...args))),
    figures: (...args) => settle(through((isolate) => isolate.figures(...args))),
    context: (...args) => settle(through((isolate) => isolate.context(...args))),
    searchConversations: (...args) => settle(through((isolate) => isolate.searchConversations(...args))),
    scrollConversation: (...args) => settle(through((isolate) => isolate.scrollConversation(...args))),
    browseConversations: (...args) => settle(through((isolate) => isolate.browseConversations(...args))),
    admitted: (...args) => settle(through((isolate) => isolate.admitted(...args))),
    interrupt: (...args) => settle(through((isolate) => isolate.interrupt(...args))),
    recover: (...args) => settle(through((isolate) => isolate.recover(...args))),
    archivePage: (...args) => settle(through((isolate) => isolate.archivePage(...args))),
    deliverAdvice: (...args) => settle(through((isolate) => isolate.deliverAdvice(...args))),
  };
}
