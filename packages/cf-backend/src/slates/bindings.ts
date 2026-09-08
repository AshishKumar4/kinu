import { WorkerEntrypoint } from 'cloudflare:workers';
import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { workspaceOwner } from '../workspace-box-rpc';
import type { JsonValue, SlateCallResult, WorkMode } from '@kinu.run/core';

/** One hop of an actor's root-relative facet path, as the SDK records it. */
export interface SlateCallerHop {
  readonly className: string;
  readonly name: string;
}

/**
 * The actor a slate acts FOR: its facet path under the workspace root (empty
 * for the root itself) and the credential its own file plane runs as. Both are
 * stamped by actor code on the Durable Object stub transport — the same trust
 * hop `workspaceBoxOp` uses for `NimbusExecOptions.cred` — never by a browser,
 * a CLI client, or the process that holds a binding.
 */
export interface SlateCaller {
  readonly path: readonly SlateCallerHop[];
  readonly cred: VfsCred;
  readonly workMode: WorkMode;
}

/** The workspace root acting as itself: the owner-facing surfaces mint this locally. */
export const ROOT_SLATE_CALLER: SlateCaller = { path: [], cred: CRED_SESSION_USER, workMode: 'build' };

/** Every field changes the VFS view or the permissions of files it creates. */
export function slateCredentialKey(cred: VfsCred): string {
  return JSON.stringify([cred.uid, cred.gid, cred.groups, cred.umask]);
}

/** Structured path encoding keeps different actor names from sharing a key. */
export function slateCallerKey(caller: SlateCaller): string {
  return JSON.stringify([slateCredentialKey(caller.cred), caller.path, caller.workMode]);
}

/** Only the host mints these props; a process receives the stub, not authority to mint one. */
export interface SlateBindingProps {
  readonly workspace: string;
  readonly id: string;
  readonly name: string;
  readonly caller: SlateCaller;
}

interface SlateBindingEnv {
  OrchestratorAgent: DurableObjectNamespace;
}

/** All four capability planes return through the owner's one route decision, as the caller. */
export class SlateBinding extends WorkerEntrypoint<SlateBindingEnv, SlateBindingProps> {
  call(member: string, args: JsonValue[], chain: string[]): Promise<SlateCallResult> {
    const { workspace, id, name, caller } = this.ctx.props;
    return workspaceOwner(this.env, workspace).slateBindingCallAs(caller, id, name, { member, args, chain });
  }
}
