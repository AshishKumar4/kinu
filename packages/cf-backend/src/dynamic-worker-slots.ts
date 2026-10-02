/** Agent isolates are Dynamic Workers: ten calls may await them per object (platform-catalog). */
import { beginLoaderFetch, dynamicWorkerHeadroom, loaderLedgerStats, withDynamicWorkerCapNamed } from '@nimbus-sh/fabric/budgets.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { Cause, Effect, Exit } from 'effect';
import { KinuError, settle } from '@kinu.run/core/obs';
import type { AgentFacetCalls } from './agent-facet/agent-facet';

const REFUSED = 'Dynamic worker concurrency limit exceeded';

export class AgentIsolateSlots {
  #running = 0;

  readonly #waiting: Array<() => void> = [];

  constructor(private readonly ledger: DurableObjectState) {}

  #wait(refusal: Error): Effect.Effect<void, KinuError> {
    if (this.#running === 0) {
      return Effect.fail(new KinuError('unavailable', withDynamicWorkerCapNamed(this.ledger, refusal).message, { cause: refusal }));
    }

    const { promise, resolve } = Promise.withResolvers<void>();

    this.#waiting.push(resolve);

    return Effect.promise(() => promise);
  }

  #hold(key: string): () => void {
    const end = beginLoaderFetch(this.ledger, key);

    this.#running += 1;

    return () => {
      end();
      this.#running -= 1;

      for (const wake of this.#waiting.splice(0)) wake();
    };
  }

  held<A>(key: string, open: () => Promise<AgentFacetCalls>, call: (isolate: AgentFacetCalls) => Promise<A>): Effect.Effect<A, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const isolate = yield* Effect.promise(open);

      for (;;) {
        if (!loaderLedgerStats(this.ledger).inFlightWorkers.includes(key) && dynamicWorkerHeadroom(this.ledger) === 0) {
          yield* this.#wait(new Error(`${REFUSED}: every slot is held`));
          continue;
        }

        const end = this.#hold(key);
        const exit = yield* Effect.exit(Effect.tryPromise({ try: () => call(isolate), catch: (cause) => cause })).pipe(Effect.ensuring(Effect.sync(end)));

        if (Exit.isSuccess(exit)) return exit.value;
        const failure = Cause.squash(exit.cause);

        if (classifyError(failure) !== 'dynamic_worker_cap') return yield* Effect.die(failure);
        yield* this.#wait(failure instanceof Error ? failure : new Error(REFUSED));
      }
    });
  }
}

export function agentCallsThrough(through: <A>(call: (isolate: AgentFacetCalls) => Promise<A>) => Effect.Effect<A, KinuError>): AgentFacetCalls {
  return {
    deliver: (...args) => settle(through((isolate) => isolate.deliver(...args))),
    holds: (...args) => settle(through((isolate) => isolate.holds(...args))),
    openTurn: (...args) => settle(through((isolate) => isolate.openTurn(...args))),
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
    clear: (...args) => settle(through((isolate) => isolate.clear(...args))),
    recover: (...args) => settle(through((isolate) => isolate.recover(...args))),
    archivePage: (...args) => settle(through((isolate) => isolate.archivePage(...args))),
    deliverAdvice: (...args) => settle(through((isolate) => isolate.deliverAdvice(...args))),
  };
}
