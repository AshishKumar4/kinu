/** Cross-workspace owner calls. Hosted actors share the root's isolate and workspace box, so their
 * file and execution operations need no owner RPC. */

import type {
  BlueprintBundle, BlueprintFork, LiveShareRecord, ShareViewerClaim, SlateAnswer, SlateBindingRequest, SlateCallResult, SlateOperation, SlateShareRecord,
} from '@kinu.run/core';
import type { BlueprintReading, ShareUser } from '@kinu.run/core/slates';
import type { SlateCaller } from './slates/bindings';
import type { ObjectNamespace } from '@kinu.run/core';

/** Slate operations made as a caller; the browser's `@callable slate` mints the root caller locally. */
export interface WorkspaceOwnerRpc {
  slateAs(caller: SlateCaller, operation: SlateOperation): Promise<SlateCallResult>;
  slateBindingCallAs(caller: SlateCaller, id: string, name: string, request: SlateBindingRequest): Promise<SlateCallResult>;
  readBlueprint(share: string): Promise<SlateAnswer<BlueprintReading>>;
  blueprintBundle(share: string): Promise<SlateAnswer<BlueprintBundle>>;
  shareBlueprintWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<SlateShareRecord>>;
  admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>>;
  // The claim is built at the edge, never trusted.
  routeSlateShare(handle: string, claim: ShareViewerClaim, request: Request, pathname: string): Promise<Response>;
  readLiveShare(share: string): Promise<SlateAnswer<{ record: LiveShareRecord; title: string; description: string }>>;
  shareLiveWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<LiveShareRecord>>;
  // Fork flag and the caller's admission are checked in the owner's object, never trusted from the route.
  liveShareBundle(share: string, userId: string): Promise<SlateAnswer<BlueprintBundle>>;
}

/** The class is not named here: this module is in graphs whose `Env` is not the worker's. */
export type WorkspaceOwnerNamespace<Id> = ObjectNamespace<Id, WorkspaceOwnerRpc>;

export function workspaceOwner<Id>(
  env: { OrchestratorAgent: WorkspaceOwnerNamespace<Id> },
  workspaceName: string,
): WorkspaceOwnerRpc {
  return env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspaceName));
}
