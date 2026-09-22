import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSet } from 'ai';
import { actorReferenceOf, sameActorReference, type ActorReference } from '../identity/actor-handle';
import { WORKSPACE_RUN_ID } from '../events/model-call';
import type { ProfileAuthorityInputs, ResolvedTurnProfile } from './resolve';

export interface OperationProfile {
  readonly actor: ActorReference;
  readonly profile: ResolvedTurnProfile;
  readonly inputs: ProfileAuthorityInputs | null;
  readonly runId: string;
  readonly turnId: string;
}

const scope = new AsyncLocalStorage<OperationProfile | undefined>();

export function captureOperationProfile(input: Omit<OperationProfile, 'turnId'> & { readonly turnId: string | null }): OperationProfile {
  return Object.freeze({ ...input, actor: actorReferenceOf(input.actor), turnId: input.turnId ?? WORKSPACE_RUN_ID,
    inputs: input.inputs === null ? null : Object.freeze(structuredClone(input.inputs)),
  });
}

export function currentOperationProfile(actor: ActorReference): OperationProfile | null {
  const current = scope.getStore();

  return current && sameActorReference(current.actor, actor) ? current : null;
}

export async function resolveOperationProfile(input: {
  readonly actor: ActorReference;
  readonly resolve: () => Promise<ResolvedTurnProfile>;
}): Promise<OperationProfile> {
  const current = currentOperationProfile(input.actor);

  if (current) return current;

  return captureOperationProfile({
    actor: input.actor, profile: await input.resolve(),
    inputs: null, runId: WORKSPACE_RUN_ID, turnId: null,
  });
}

export function runOperationProfile<Result>(context: OperationProfile | null, invoke: () => Result): Result {
  return scope.run(context ?? undefined, invoke);
}

export function withOperationProfile(tools: ToolSet, context: OperationProfile): ToolSet {
  const bound: ToolSet = {};

  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute;
    bound[name] = execute === undefined ? { ...entry } : { ...entry,
      execute: (input, options) => scope.run(context, () => execute(input, options)),
    };
  }

  return bound;
}

/** Every continuation runs in the issuer's scope; a null context clears the consumer's. */
export async function* operationProfileStream<Value>(events: AsyncIterable<Value>, context: OperationProfile | null): AsyncGenerator<Value> {
  const iterator = runOperationProfile(context, () => events[Symbol.asyncIterator]());

  try {
    for (;;) {
      const next = await runOperationProfile(context, () => iterator.next());

      if (next.done) return;
      yield next.value;
    }
  } finally {
    await runOperationProfile(context, async () => { await iterator.return?.(); });
  }
}
