/**
 * The object that owns one workspace, as the methods a caller in this Worker
 * needs of it.
 *
 * Hosted actors share the root's isolate and its composed workspace box, so
 * their file and execution operations need no owner RPC. This module declares
 * genuinely cross-workspace owner calls, including slate bindings held by a
 * process in another workspace.
 */

import type { SlateBindingRequest, SlateCallResult, SlateOperation } from '@kinu.run/core';
import type { SlateCaller } from './slates/bindings';

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
}

interface WorkspaceOwnerNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): WorkspaceOwnerRpc;
}

/**
 * Narrowed the way `userDOStubFor` narrows the UserDO binding, and for the same
 * reason: instantiating `DurableObjectStub<OrchestratorAgent>` here makes the
 * SDK's mapped stub type walk that class's entire RPC surface, which TypeScript
 * gives up on ("type instantiation is excessively deep"). The narrow view also
 * says what a caller may reach, which is exactly this.
 */
export function workspaceOwner(
  env: { OrchestratorAgent: Pick<DurableObjectNamespace, 'idFromName' | 'get'> },
  workspaceName: string,
): WorkspaceOwnerRpc {
  const view: Partial<WorkspaceOwnerNamespace> = {};
  Object.assign(view, {
    idFromName: (name: string) => env.OrchestratorAgent.idFromName(name),
    get: (id: DurableObjectId) => env.OrchestratorAgent.get(id),
  });
  // SAFETY: the view above is constructed with exactly the two members
  // WorkspaceOwnerNamespace declares, and orchestrator.ts declares both slate
  // methods with these signatures, delegating to SlateHost.
  const namespace = view as WorkspaceOwnerNamespace;
  return namespace.get(namespace.idFromName(workspaceName));
}

