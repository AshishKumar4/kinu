/** Cross-workspace owner calls. Hosted actors share the root's isolate and workspace box, so their
 * file and execution operations need no owner RPC. */

import { objectNamed } from '@kinu.run/core';
import { type SlateCaller, type SlateCallFrom } from '@kinu.run/core/slates';
import type {
  BlueprintBundle, BlueprintFork, JsonValue, LiveShareRecord, OperationCaller, OperationListing, OperationResult, ShareViewerClaim, SlateAnswer,
  RoomService, SlateCallRequest, SlateCallResult, SlateFileChange, SlateOperation, SlateShareRecord, SlateSurfaceResult,
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
  /** One call a slate's process made through its binding, with the lineage the host minted into that binding. */
  slateCallAs(from: SlateCallFrom, request: SlateCallRequest): Promise<SlateSurfaceResult>;
  /** One of its slates' files, for an editor (the asking workspace's owner) a live share adds to edit it now. */
  slateFilesFor(slate: string, editor: SlateEditor): Promise<SlateCallResult>;
  /** An editor's change to one of its slates, refused unless a live share adds them to edit it now; answers the paths. */
  editSlateAs(slate: string, editor: SlateEditor, files: SlateFileChange): Promise<SlateCallResult>;
  /** A personal part's run of `slate`, for the signed-in `viewer` the route names (docs/SLATE-SHARING-NIMBUS.md §3). */
  runSlatePart(viewer: PartViewer | null, slate: string, part: string, request: PartRunRequest): Promise<PartRunAnswer | null>;
  /** One call of a running part's process, through its `PartBinding`. */
  slatePartCall(slate: string, run: string, name: string, call: { readonly path: readonly string[]; readonly args: readonly JsonValue[] }): Promise<SlateSurfaceResult>;
  /** A paused part run its viewer let go. */
  releaseSlatePart(viewer: PartViewer, continuation: string): Promise<boolean>;
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
  readLiveShare(share: string, reader: string | null): Promise<SlateAnswer<LiveShareReading>>;
  galleryNeeds(share: string): Promise<SlateAnswer<RoomService[]>>;
  shareLiveWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<LiveShareRecord>>;
  // Fork flag and the caller's admission are checked in the owner's object, never trusted from the route.
  liveShareBundle(share: string, userId: string): Promise<SlateAnswer<BlueprintBundle>>;
}

/** Who edits a slate another workspace shares with them: that workspace's owner, named by their own workspace. */
export interface SlateEditor {
  readonly userId: string;
  readonly email: string;
}

/** The class is not named here: this module is in graphs whose `Env` is not the worker's. */
export type WorkspaceOwnerNamespace<Id> = ObjectNamespace<Id, WorkspaceOwnerRpc>;

export function workspaceOwner<Id>(
  env: { OrchestratorAgent: WorkspaceOwnerNamespace<Id> },
  workspaceName: string,
): WorkspaceOwnerRpc {
  return objectNamed(env.OrchestratorAgent, workspaceName);
}
