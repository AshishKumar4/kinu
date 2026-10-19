import { WorkerEntrypoint } from 'cloudflare:workers';
import { relayedAnswer, type JsonValue, type SlateSurfaceResult } from '@kinu.run/core';
import { workspaceOwner, type WorkspaceOwnerNamespace } from '../workspace-owner-rpc';
import { withOwnedStreams } from './bindings';

/**
 * Only the host mints these props, one set per personal part run (docs/SLATE-SHARING-NIMBUS.md §3): the confined
 * process holds the stub, never the authority to mint one, and nothing in it names whose run it is.
 */
export interface PartBindingProps {
  readonly workspace: string;
  readonly slate: string;
  /** The run, as the slate's host knows it: its viewer, revision and whether it is still running. */
  readonly run: string;
  /** `workspace`, or the reserved `__storage` or `__host`. */
  readonly name: string;
}

interface PartBindingEnv {
  OrchestratorAgent: WorkspaceOwnerNamespace<DurableObjectId>;
}

/** Every call a personal part's run makes goes to its slate's host, which answers it with the run's viewer's own grants or refuses. */
export class PartBinding extends WorkerEntrypoint<PartBindingEnv, PartBindingProps> {
  call(path: string[], args: JsonValue[]): Promise<SlateSurfaceResult> {
    const { workspace, slate, run, name } = this.ctx.props;

    return relayedAnswer(workspaceOwner(this.env, workspace).slatePartCall(slate, run, name, { path, args })).then(withOwnedStreams);
  }
}
