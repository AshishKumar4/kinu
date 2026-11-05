import type { ActorHandle, ActorHost, AgentConfigStore, SqlExecutor, UserCaller } from '@kinu.run/core';
import type { KinuError } from '@kinu.run/core/obs';
import type { Effect } from 'effect';
import type { UserHubClient } from '../account-reads';
import type { CFSeat } from '../actor-hosting';
import type { OwnedModelServices } from '../owned-model-services';
import type { CFRuntime } from '../runtime';

/**
 * What every concern of the workspace's Durable Object reads of it, built once in its constructor. Each member is a
 * value or a read of state the object keeps: its actor handle refuses while storage does, and its runtime is built on
 * first use, so neither is captured.
 */
export interface WorkspaceActorContext {
  readonly actor: () => ActorHandle;
  readonly runtime: () => CFRuntime;
  /** The root actor's own config store. */
  readonly config: () => AgentConfigStore;
  readonly host: () => ActorHost<CFSeat>;
  /** The object's SQL, bound to its storage. */
  readonly sql: () => SqlExecutor;
  readonly models: OwnedModelServices;
  readonly workspaceName: () => string;
  /** The account that owns the workspace: its user id once claimed, and its user object asked as this workspace. */
  readonly owner: {
    readonly userId: () => string | null;
    readonly hub: () => Promise<{ readonly stub: UserHubClient; readonly caller: UserCaller }>;
  };
  /** Work the object owns past the caller, and frames to its windows (`null`: the workspace's own). */
  readonly life: {
    readonly detach: (work: Effect.Effect<void, KinuError>) => void;
    readonly broadcast: (frame: string, actorId: string | null) => void;
  };
}
