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
  readonly config: AgentConfigStore;
  readonly programState: ProgramStateStore;
  /** Re-run the validation this binding captured. An actor-scoped store calls
   *  it before any statement, so a store cannot outlive the identity it was
   *  bound to — the same check the getters below already run. */
  readonly assertCurrent: () => void;
}

/** Bind a validated identity to physical storage without exposing its SQL. */
export function bindActorHandle(sql: SqlExecutor, reference: ActorIdentity, validate: () => void): ActorHandle {
  const identity = v.parse(ActorIdentitySchema, reference);
  validate();
  let config: AgentConfigStore | undefined;
  let programState: ProgramStateStore | undefined;
  return Object.freeze({
    ...identity,
    get config() {
      validate();
      return config ??= createAgentConfigStore(sql, identity.actorId, validate);
    },
    get programState() {
      validate();
      return programState ??= createProgramStateStore(sql, identity.actorId, validate);
    },
    assertCurrent(): void { validate(); },
  });
}
