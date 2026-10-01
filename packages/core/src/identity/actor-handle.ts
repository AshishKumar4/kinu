import { Effect } from 'effect';
import * as v from 'valibot';
import { settleSync } from '../obs/effect';
import type { KinuError } from '../obs/error';
import { createAgentConfigStore, type AgentConfigStore } from '../config/store';
import { createProgramStateStore, type ProgramStateStore } from './program-state';
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
  /** The getters' own validation, run before acting without `config` or `programState`. */
  readonly assertCurrent: () => void;
  readonly config: AgentConfigStore;
  readonly programState: ProgramStateStore;
}

/** Bind an identity to physical storage without exposing its SQL. */
export function bindActorHandle(sql: SqlExecutor, identity: ActorIdentity, validate: () => Effect.Effect<void, KinuError>): ActorHandle {
  let config: AgentConfigStore | undefined;
  let programState: ProgramStateStore | undefined;

  const handle: ActorHandle = Object.freeze({
    ...identity,
    assertCurrent: () => settleSync(validate()),
    get config() {
      handle.assertCurrent();

      return config ??= createAgentConfigStore(sql, identity.actorId, handle.assertCurrent);
    },
    get programState() {
      handle.assertCurrent();

      return programState ??= createProgramStateStore(sql, identity.actorId, handle.assertCurrent);
    },
  });

  handle.assertCurrent();

  return handle;
}
