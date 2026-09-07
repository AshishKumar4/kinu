import { WorkerEntrypoint } from 'cloudflare:workers';
import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { workspaceOwner } from '../workspace-box-rpc';
import type { JsonValue, SlateCallResult } from '@kinu.run/core';

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
}

/** The workspace root acting as itself: the owner-facing surfaces mint this locally. */
export const ROOT_SLATE_CALLER: SlateCaller = { path: [], cred: CRED_SESSION_USER };

/** Distinct actors never share a process or a binding, so this keys both — by
 *  the WHOLE credential (uid, gid, supplementary groups, umask) and the path. */
export function slateCallerKey(caller: SlateCaller): string {
  const { uid, gid, groups, umask } = caller.cred;
  const path = caller.path.map((hop) => `${hop.className}/${hop.name}`).join('>');
  return `${uid}:${gid}:${[...groups].sort((a, b) => a - b).join(',')}:${umask}|${path}`;
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
  call(member: string, args: JsonValue[], depth: number): Promise<SlateCallResult> {
    const { workspace, id, name, caller } = this.ctx.props;
    return workspaceOwner(this.env, workspace).slateBindingCallAs(caller, id, name, { member, args, depth });
  }
}
