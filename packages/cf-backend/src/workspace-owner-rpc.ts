/**
 * The object that owns one workspace, as the methods a caller in this Worker
 * needs of it.
 *
 * Hosted actors share the root's isolate and its composed workspace box, so
 * their file and execution operations need no owner RPC. This module declares
 * genuinely cross-workspace owner calls, including slate bindings held by a
 * process in another workspace.
 */

import type {
  BlueprintBundle, BlueprintFork, LiveShareRecord, ShareViewerClaim, SlateAnswer, SlateBindingRequest, SlateCallResult, SlateOperation, SlateShareRecord,
} from '@kinu.run/core';
import type { BlueprintReading, ShareUser } from '@kinu.run/core/slates';
import type { SlateCaller } from './slates/bindings';
import type { ObjectNamespace } from '@kinu.run/core';

/**
 * Every method a caller in this Worker reaches on the object that owns a
 * workspace: the slate operations an actor or a binding entrypoint makes AS a
 * caller. The caller is stamped by actor code on this stub transport; the
 * browser's own `@callable slate` mints the root caller locally and never
 * takes one.
 */
export interface WorkspaceOwnerRpc {
  slateAs(caller: SlateCaller, operation: SlateOperation): Promise<SlateCallResult>;
  slateBindingCallAs(caller: SlateCaller, id: string, name: string, request: SlateBindingRequest): Promise<SlateCallResult>;
  // Blueprints cross workspaces: the app host reads one from its owner and
  // admits it into the forker. Each answer is a value, refusal included.
  readBlueprint(share: string): Promise<SlateAnswer<BlueprintReading>>;
  blueprintBundle(share: string): Promise<SlateAnswer<BlueprintBundle>>;
  shareBlueprintWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<SlateShareRecord>>;
  admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>>;
  // Live shares cross workspaces the same way: the share rail forwards a
  // verified request to the owner's object, and the app host reads one share
  // row back for `/live/open`. The claim is built at the edge, never trusted.
  routeSlateShare(handle: string, claim: ShareViewerClaim, request: Request, pathname: string): Promise<Response>;
  readLiveShare(share: string): Promise<SlateAnswer<{ record: LiveShareRecord; title: string; description: string }>>;
  shareLiveWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<LiveShareRecord>>;
  // A live-share fork asks the owner's object for the running slate's
  // skeleton: the row re-read, the grant's fork flag, and the caller's own
  // admission checked there — never trusted from the route.
  liveShareBundle(share: string, userId: string): Promise<SlateAnswer<BlueprintBundle>>;
}

/**
 * The owner object's namespace as the seam sees it. The class is not named
 * here: this module sits in the slate binding entrypoint's and the workerd
 * probe project's graphs, whose `Env` is not the worker's. `OrchestratorAgent`
 * declares `implements WorkspaceOwnerRpc`, so the worker's own
 * `DurableObjectNamespace<OrchestratorAgent>` is assignable to this one member
 * by member: the stub carries each answer as the value it is.
 */
export type WorkspaceOwnerNamespace<Id> = ObjectNamespace<Id, WorkspaceOwnerRpc>;

/** The owner's object, reached the way any Durable Object is: its stub. */
export function workspaceOwner<Id>(
  env: { OrchestratorAgent: WorkspaceOwnerNamespace<Id> },
  workspaceName: string,
): WorkspaceOwnerRpc {
  return env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspaceName));
}
