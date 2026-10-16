/** Cross-workspace owner calls. Hosted actors share the root's isolate and workspace box, so their
 * file and execution operations need no owner RPC. */

import { objectNamed } from '@kinu.run/core';
import { type SlateCaller } from '@kinu.run/core/slates';
import type {
  BlueprintBundle, BlueprintFork, JsonValue, LiveShareRecord, OperationCaller, OperationListing, OperationResult, ShareViewerClaim, SlateAnswer,
  RoomService, SlateCallRequest, SlateCallResult, SlateOperation, SlateShareRecord, SlateSurfaceResult,
} from '@kinu.run/core';
import type { BlueprintReading, PartRunAnswer, PartRunRequest, PartShowRequest, ShareUser } from '@kinu.run/core/slates';
import type { PartViewer } from './slates/part-runs';
import type { ObjectNamespace } from '@kinu.run/core';

/** A live share as its workspace reads it for someone opening it: the row, its slate's words, and whether its address
 *  admits them. */
export interface LiveShareReading {
  readonly record: LiveShareRecord;
  readonly title: string;
  readonly description: string;
  readonly admits: boolean;
}

/** Slate operations made as a caller; the browser's `@callable slate` mints the root caller locally. */
export interface WorkspaceOwnerRpc {
  slateAs(caller: SlateCaller, operation: SlateOperation): Promise<SlateCallResult>;
  /** Whether a slate still builds, asked as a caller; a check, never a preview. */
  slateBuildAs(caller: SlateCaller, slate: string): Promise<SlateCallResult>;
  slateCallAs(caller: SlateCaller, id: string, name: string, request: SlateCallRequest): Promise<SlateSurfaceResult>;
  /** A personal part's run of `slate`, for the signed-in `viewer` the route names (docs/SLATE-SHARING-NIMBUS.md §3). */
  runSlatePart(viewer: PartViewer | null, slate: string, part: string, request: PartRunRequest): Promise<PartRunAnswer | null>;
  /** One call of a running part's process, through its `PartBinding`. */
  slatePartCall(slate: string, run: string, name: string, call: { readonly path: readonly string[]; readonly args: readonly JsonValue[] }): Promise<SlateSurfaceResult>;
  /** What `viewer` confirmed in Kinu's prompt, to the slate's declared `show` method. */
  showSlatePart(viewer: PartViewer, slate: string, part: string, request: PartShowRequest): Promise<SlateCallResult>;
  /** An actor's operation, by `ns.op`, as eval runs it; refused when the actor does not reach it now. */
  callOperation(caller: OperationCaller, id: string, input: JsonValue, call: { readonly callId: string }): Promise<OperationResult>;
  listOperations(caller: OperationCaller): Promise<readonly OperationListing[]>;
  /** Stops a `callOperation` still running; one that has answered is not touched. */
  cancelOperation(callId: string): Promise<void>;
  readBlueprint(share: string): Promise<SlateAnswer<BlueprintReading>>;
  blueprintBundle(share: string): Promise<SlateAnswer<BlueprintBundle>>;
  shareBlueprintWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<SlateShareRecord>>;
  admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>>;
  // The claim is built at the edge, never trusted.
  routeSlateShare(handle: string, claim: ShareViewerClaim, request: Request, pathname: string): Promise<Response>;
  readLiveShare(share: string, reader: string): Promise<SlateAnswer<LiveShareReading>>;
  galleryNeeds(share: string): Promise<SlateAnswer<RoomService[]>>;
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
  return objectNamed(env.OrchestratorAgent, workspaceName);
}
