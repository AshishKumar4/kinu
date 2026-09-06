import { WorkerEntrypoint } from 'cloudflare:workers';
import { workspaceOwner } from '../workspace-box-rpc';
import type { JsonValue, SlateCallResult } from '@kinu.run/core';

/** Only the host mints these props; a process receives the stub, not authority to mint one. */
export interface SlateBindingProps {
  readonly workspace: string;
  readonly id: string;
  readonly name: string;
}

interface SlateBindingEnv {
  OrchestratorAgent: DurableObjectNamespace;
}

/** All four capability planes return through the owner's one route decision. */
export class SlateBinding extends WorkerEntrypoint<SlateBindingEnv, SlateBindingProps> {
  call(member: string, args: JsonValue[], depth: number): Promise<SlateCallResult> {
    const { workspace, id, name } = this.ctx.props;
    return workspaceOwner(this.env, workspace).slateBindingCall(id, name, { member, args, depth });
  }
}
