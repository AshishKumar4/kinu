import * as v from 'valibot';
import type { Effect } from 'effect';
import type { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { createAgentConfigStore, type AgentConfigStore } from '../config/store';
import type { SqlExecutor } from '../types/primitives';

export const ActorReferenceSchema = v.strictObject({
  actorId: v.pipe(v.string(), v.nonEmpty()),
  workspaceId: v.pipe(v.string(), v.nonEmpty()),
  parentActorId: v.nullable(v.pipe(v.string(), v.nonEmpty())),
});

export type ActorReference = Readonly<v.InferOutput<typeof ActorReferenceSchema>>;

export interface ActorIdentity extends ActorReference {
  readonly name: string;
  readonly storageKey: string;
}

/** Project a bound handle onto the immutable reference that can cross RPC. */
export function actorReferenceOf(actor: ActorReference): ActorReference {
  return Object.freeze({ actorId: actor.actorId, workspaceId: actor.workspaceId, parentActorId: actor.parentActorId });
}

export function sameActorReference(left: ActorReference, right: ActorReference): boolean {
  return left.actorId === right.actorId && left.workspaceId === right.workspaceId && left.parentActorId === right.parentActorId;
}

export interface ActorHandle extends ActorIdentity {
  /** The getter's own validation, run before acting without `config`. */
  readonly assertCurrent: () => void;
  readonly config: AgentConfigStore;
}

/** Bind an identity to physical storage without exposing its SQL. */
export function bindActorHandle(sql: SqlExecutor, identity: ActorIdentity, validate: () => Effect.Effect<void, KinuError>): ActorHandle {
  let config: AgentConfigStore | undefined;

  const handle: ActorHandle = Object.freeze({
    ...identity,
    assertCurrent: () => settleSync(validate()),
    get config() {
      handle.assertCurrent();

      return config ??= createAgentConfigStore(sql, identity.actorId, handle.assertCurrent);
    },
  });

  handle.assertCurrent();

  return handle;
}
