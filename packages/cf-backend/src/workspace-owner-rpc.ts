/**
 * The object that owns one workspace, as the methods a caller in this Worker
 * needs of it.
 *
 * WHAT IS NOT HERE. Nothing forwards a file operation: no `WorkspaceBoxOp`
 * union, no results map keyed by op name, no dispatcher on the owner and no
 * client re-implementing `NimbusSandboxHandle` over one monomorphic RPC. A
 * hosted logical actor shares the root's isolate and therefore its box directly
 * — `createCFRuntime` is handed the very handle the workspace composed — so
 * `files.read`, `files.write`, `exec` and `ports.expose` cross no isolate
 * boundary, and there is nothing for a forwarding layer to carry.
 *
 * WHAT REMAINS is genuinely cross-WORKSPACE, which is a different question from
 * cross-actor: a slate binding held by a process in one workspace calling into
 * the object that owns another, and an actor reaching its own workspace owner
 * from a Worker entrypoint. Those are real Durable Object hops and stay.
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

