/**
 * The worker beside the built product in `scripts/worker-heap.ts`: it claims and sets up one workspace through
 * the product's own RPC, as the account plane does, so the product isolate's heap is read after a real setup.
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

/** The product RPC setup calls, as the account plane calls it; the classes live in the built bundle. */
interface WorkspaceRpc extends Rpc.DurableObjectBranded {
  claimOwner(owner: string): Promise<{ capabilityHash: string }>;
  setSoul(markdown: string): Promise<void>;
  setModel(model: string): Promise<void>;
}

interface AccountRpc extends Rpc.DurableObjectBranded {
  ensureProfile(caller: { ownerToken: string }, email: string, name: string): Promise<void>;
  registerWorkspace(caller: { ownerToken: string }, name: string, displayName: string): Promise<void>;
  ensureWorkspaceCapability(workspace: string, capabilityHash: string): Promise<void>;
}

interface DriverEnv {
  /** `ownerCaller`'s token for the product's key, computed by the gate. */
  readonly OWNER_TOKEN: string;
  readonly OrchestratorAgent: DurableObjectNamespace<WorkspaceRpc>;
  readonly UserDO: DurableObjectNamespace<AccountRpc>;
}

const OWNER = 'fedcba9876543210fedcba9876543211';

export class HeapDriver extends DurableObject<DriverEnv> {
  async setUp(workspace: string): Promise<void> {
    const caller = { ownerToken: this.env.OWNER_TOKEN };
    const users = this.env.UserDO.get(this.env.UserDO.idFromName(OWNER));
    const agent = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace));
    await users.ensureProfile(caller, 'owner@heap.local', 'Owner');
    await users.registerWorkspace(caller, workspace, workspace);
    const claim = await agent.claimOwner(OWNER);
    await users.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await agent.setSoul('# Heap\n\nAnswer.');
    await agent.setModel('workers-ai/@cf/zai-org/glm-5.3');
  }
}

/** The product's `AI` binding: setup makes no model call, so every call is a failure worth seeing. */
export class RefusingAI extends WorkerEntrypoint {
  run(model: string): never {
    throw new Error(`worker-heap: setup called the model ${model}`);
  }
}

export default {
  async fetch(request: Request, env: DriverEnv & { readonly HEAP_DRIVER: DurableObjectNamespace<HeapDriver> }): Promise<Response> {
    const workspace = new URL(request.url).searchParams.get('workspace') ?? 'heap';
    await env.HEAP_DRIVER.get(env.HEAP_DRIVER.idFromName(workspace)).setUp(workspace);

    return new Response(null, { status: 204 });
  },
};
