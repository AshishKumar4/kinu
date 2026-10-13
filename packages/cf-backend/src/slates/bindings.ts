import { WorkerEntrypoint } from 'cloudflare:workers';
import { workspaceOwner, type WorkspaceOwnerNamespace } from '../workspace-owner-rpc';
import { relayedAnswer, type JsonValue, type SlateSurfaceResult } from '@kinu.run/core';
import type { SlateCaller } from '@kinu.run/core/slates';

/** Only the host mints these props; a process receives the stub, not authority to mint one. `name` is `workspace`, the
 *  slate's surface, or the reserved `__storage` or `__host`. */
export interface SlateBindingProps {
  readonly workspace: string;
  readonly id: string;
  readonly name: string;
  readonly caller: SlateCaller;
}

interface SlateBindingEnv {
  OrchestratorAgent: WorkspaceOwnerNamespace<DurableObjectId>;
}

/** Every call a slate makes returns through the owner's one route decision, as the caller. */
export class SlateBinding extends WorkerEntrypoint<SlateBindingEnv, SlateBindingProps> {
  /** `authorize` asks only whether the call may run: the class runs a browser member itself once it may. */
  call(path: string[], args: JsonValue[], invocation: string | null, authorize?: boolean): Promise<SlateSurfaceResult> {
    const { workspace, id, name, caller } = this.ctx.props;

    return relayedAnswer(workspaceOwner(this.env, workspace).slateCallAs(caller, id, name, { path, args, invocation, ...(authorize === true && { authorize: true }) }));
  }
}
