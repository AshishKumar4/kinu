import * as v from 'valibot';
import { createAgentConfigStore, type AgentConfigStore } from '../config/store';
import { createProgramStateStore, type ProgramStateStore } from '../tools/state-codemode';
import type { SqlExecutor } from '../types/primitives';

export const ActorReferenceSchema = v.strictObject({
  actorId: v.pipe(v.string(), v.nonEmpty()),
  workspaceId: v.pipe(v.string(), v.nonEmpty()),
  parentActorId: v.nullable(v.pipe(v.string(), v.nonEmpty())),
});
export type ActorReference = Readonly<v.InferOutput<typeof ActorReferenceSchema>>;
export const ActorIdentitySchema = v.strictObject({
  ...ActorReferenceSchema.entries, name: v.pipe(v.string(), v.nonEmpty()), storageKey: v.pipe(v.string(), v.nonEmpty()),
});
export type ActorIdentity = Readonly<v.InferOutput<typeof ActorIdentitySchema>>;

/** Project a bound handle onto the immutable reference that can cross RPC. */
export function actorReferenceOf(actor: ActorReference): ActorReference {
  return Object.freeze({ actorId: actor.actorId, workspaceId: actor.workspaceId, parentActorId: actor.parentActorId });
}
export function sameActorReference(left: ActorReference, right: ActorReference): boolean {
  return left.actorId === right.actorId && left.workspaceId === right.workspaceId && left.parentActorId === right.parentActorId;
}
export interface ActorHandle extends ActorIdentity {
  /** Re-run the binding's own validation, for a holder about to act as this
   *  actor without reading `config` or `programState` first. A store bound to a
   *  handle captures `actorId` once and calls this before every statement, so a
   *  handle whose row was retired, re-parented or re-pathed stops authorising
   *  writes at exactly the point the property getters below already stop
   *  serving stores. It exposes the callback those getters run — no second
   *  authority and no policy of its own. */
  readonly assertCurrent: () => void;
  readonly config: AgentConfigStore;
  readonly programState: ProgramStateStore;
}

/** Bind a validated identity to physical storage without exposing its SQL. */
export function bindActorHandle(sql: SqlExecutor, reference: ActorIdentity, validate: () => void): ActorHandle {
  const identity = v.parse(ActorIdentitySchema, reference);
  validate();
  let config: AgentConfigStore | undefined;
  let programState: ProgramStateStore | undefined;
  return Object.freeze({
    ...identity,
    assertCurrent: validate,
    get config() {
      validate();
      return config ??= createAgentConfigStore(sql, identity.actorId, validate);
    },
    get programState() {
      validate();
      return programState ??= createProgramStateStore(sql, identity.actorId, validate);
    },
  });
}
