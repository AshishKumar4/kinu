/** Cross-workspace owner calls. Hosted actors share the root's isolate and workspace box, so their
 * file and execution operations need no owner RPC. */

import { objectNamed } from '@kinu.run/core';
import { type SlateCaller } from '@kinu.run/core/slates';
import type {
  BlueprintBundle, BlueprintFork, JsonValue, OperationCaller, OperationListing, OperationResult, SlateAnswer,
  SlateCallRequest, SlateCallResult, SlateOperation, SlateSurfaceResult, SharedSlateFiles, SlateFileChange,
} from '@kinu.run/core';
import type { ObjectNamespace } from '@kinu.run/core';

/** Slate operations made as a caller; the browser's `@callable slate` mints the root caller locally. */
export interface WorkspaceOwnerRpc {
  slateAs(caller: SlateCaller, operation: SlateOperation): Promise<SlateCallResult>;
  /** Whether a slate still builds, asked as a caller; a check, never a preview. */
  slateBuildAs(caller: SlateCaller, slate: string): Promise<SlateCallResult>;
  slateCallAs(caller: SlateCaller, id: string, name: string, request: SlateCallRequest): Promise<SlateSurfaceResult>;
  /** An actor's operation, by `ns.op`, as eval runs it; refused when the actor does not reach it now. */
  callOperation(caller: OperationCaller, id: string, input: JsonValue, call: { readonly callId: string }): Promise<OperationResult>;
  listOperations(caller: OperationCaller): Promise<readonly OperationListing[]>;
  /** Stops a `callOperation` still running; one that has answered is not touched. */
  cancelOperation(callId: string): Promise<void>;
  /** Admits a fork of `parent` (`<workspace>/<slate>`): its room, when made, knows the code is not its owner's. */
  admitBlueprint(bundle: BlueprintBundle, parent: string): Promise<SlateAnswer<BlueprintFork>>;
  /** A slate's text files, for an editor its room let in. */
  slateFilesFor(slate: string): Promise<SlateAnswer<SharedSlateFiles>>;
  /** An editor's change to a slate, which its room let in: written, built, and published as theirs. */
  editSlateAs(slate: string, editor: string, files: SlateFileChange): Promise<SlateAnswer<readonly string[]>>;
  /** A fork's bundle of a slate: its code alone. */
  slateForkBundle(slate: string, source: string): Promise<SlateAnswer<BlueprintBundle>>;
  /** The modules of a slate's image, by content digest, for its room to load; refused when one is gone. */
  slateImageModules(slate: string, digests: readonly string[]): Promise<SlateAnswer<Readonly<Record<string, string>>>>;
  /** The slate's room, made on its first need by this workspace, which alone names its owner. */
  ensureSlateRoom(slate: string): Promise<SlateAnswer<{ readonly handle: string }>>;
}

/** The class is not named here: this module is in graphs whose `Env` is not the worker's. */
export type WorkspaceOwnerNamespace<Id> = ObjectNamespace<Id, WorkspaceOwnerRpc>;

export function workspaceOwner<Id>(
  env: { OrchestratorAgent: WorkspaceOwnerNamespace<Id> },
  workspaceName: string,
): WorkspaceOwnerRpc {
  return objectNamed(env.OrchestratorAgent, workspaceName);
}
