import { WorkerEntrypoint } from 'cloudflare:workers';
import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { workspaceOwner } from '../workspace-owner-rpc';
import type { JsonValue, SlateCallResult, WorkMode } from '@kinu.run/core';

/** One hop of an actor's root-relative path, as the workspace directory records
 *  it: a registered actor NAME under the workspace root. A class name is not an
 *  identity — every actor is hosted by the one root object, so what
 *  distinguishes two callers is which actor they are, which is exactly the name
 *  the directory holds. */
export interface SlateCallerHop {
  readonly name: string;
}

/**
 * The actor a slate acts FOR: its actor path under the workspace root (empty
 * for the main actor itself) and the credential its own file plane runs as. Both
 * are stamped by actor code on the Durable Object stub transport — never by a
 * browser, a CLI client, or the process that holds a binding.
 */
export interface SlateCaller {
  readonly path: readonly SlateCallerHop[];
  readonly cred: VfsCred;
  readonly workMode: WorkMode;
  /** The live share a viewer's process runs under — present only on the share
   *  caller, so the share id travels on the reference and never on the wire. */
  readonly share?: string;
}

/** The caller a live share's process is booted under: the workspace's own root
 *  — the calls dispatch as the owner, S2 — carrying the share id so the
 *  process key and every binding call stay distinct from the owner's own. */
export function shareCaller(share: string): SlateCaller {
  return { ...ROOT_SLATE_CALLER, share };
}

/** The workspace root acting as itself: the owner-facing surfaces mint this locally. */
export const ROOT_SLATE_CALLER: SlateCaller = { path: [], cred: CRED_SESSION_USER, workMode: 'build' };

/** Every field changes the VFS view or the permissions of files it creates. */
export function slateCredentialKey(cred: VfsCred): string {
  return JSON.stringify([cred.uid, cred.gid, cred.groups, cred.umask]);
}

/** Structured path encoding keeps different actor names from sharing a key;
 *  the share is in the key so a share's process and the owner's own preview
 *  never coalesce — the owner's preview stays private. */
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
  OrchestratorAgent: DurableObjectNamespace;
}

/** All four capability planes return through the owner's one route decision, as the caller. */
export class SlateBinding extends WorkerEntrypoint<SlateBindingEnv, SlateBindingProps> {
  call(member: string, args: JsonValue[], invocation: string | null): Promise<SlateCallResult> {
    const { workspace, id, name, caller } = this.ctx.props;

    return workspaceOwner(this.env, workspace).slateBindingCallAs(caller, id, name, { member, args, invocation });
  }
}
