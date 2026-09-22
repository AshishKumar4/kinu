import { WorkerEntrypoint } from 'cloudflare:workers';
import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { workspaceOwner, type WorkspaceOwnerNamespace } from '../workspace-owner-rpc';
import type { JsonValue, SlateCallResult, WorkMode } from '@kinu.run/core';

/** A registered actor name: every actor shares one root object, so the name, not a class, is the identity. */
export interface SlateCallerHop {
  readonly name: string;
}

/** The actor a slate acts for; stamped only by actor code, never by a browser, client, or the binding holder. */
export interface SlateCaller {
  readonly path: readonly SlateCallerHop[];
  readonly cred: VfsCred;
  readonly workMode: WorkMode;
  /** Share callers only: the id travels on the reference, never on the wire. */
  readonly share?: string;
}

/** Dispatches as the owner (S2); the share id keeps the process key distinct from the owner's own. */
export function shareCaller(share: string): SlateCaller {
  return { ...ROOT_SLATE_CALLER, share };
}

export const ROOT_SLATE_CALLER: SlateCaller = { path: [], cred: CRED_SESSION_USER, workMode: 'build' };

/** Every field changes the VFS view or the permissions of files it creates. */
export function slateCredentialKey(cred: VfsCred): string {
  return JSON.stringify([cred.uid, cred.gid, cred.groups, cred.umask]);
}

/** The share is in the key so a share's process never coalesces with the owner's private preview. */
export function slateCallerKey(caller: SlateCaller): string {
  return JSON.stringify([slateCredentialKey(caller.cred), caller.path, caller.workMode, caller.share ?? null]);
}

/** Only the host mints these props; a process receives the stub, not authority to mint one. */
export interface SlateBindingProps {
  readonly workspace: string;
  readonly id: string;
  readonly name: string;
  readonly caller: SlateCaller;
}

interface SlateBindingEnv {
  OrchestratorAgent: WorkspaceOwnerNamespace<DurableObjectId>;
}

/** All four capability planes return through the owner's one route decision, as the caller. */
export class SlateBinding extends WorkerEntrypoint<SlateBindingEnv, SlateBindingProps> {
  call(member: string, args: JsonValue[], invocation: string | null): Promise<SlateCallResult> {
    const { workspace, id, name, caller } = this.ctx.props;

    return workspaceOwner(this.env, workspace).slateBindingCallAs(caller, id, name, { member, args, invocation });
  }
}
