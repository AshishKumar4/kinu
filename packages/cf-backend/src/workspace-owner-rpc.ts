/**
 * The object that owns one workspace, as the methods a caller in this Worker
 * needs of it.
 *
 * WHAT THIS IS NOT ANY MORE. This file used to be `workspace-box-rpc.ts`, and
 * most of it was a FILE-FORWARDING SHIM: a 25-arm `WorkspaceBoxOp` union, a
 * `WorkspaceBoxResults` map keyed by op name, an `applyWorkspaceBoxOp`
 * dispatcher on the owner and a `createWorkspaceBoxClient` that re-implemented
 * `NimbusSandboxHandle` over one monomorphic RPC. Every byte of it existed
 * because a facet was a SEPARATE Durable Object that shared its parent's tree
 * but could not reach it: `files.read`, `files.write`, `exec`, `ports.expose`
 * all had to cross an isolate boundary. Hosted logical actors share the root's
 * isolate and therefore its box directly — `createCFRuntime` is handed the very
 * handle the workspace composed — so the union, the dispatcher and the client
 * are deleted rather than renamed. Nothing forwards a file operation any more.
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

