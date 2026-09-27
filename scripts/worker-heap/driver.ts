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
  runTaskFromMcp(text: string): Promise<void>;
  /** `worker-heap/product.ts`'s probe RPC. */
  hostHeads(tag: string, count: number): Promise<void>;
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

  /** One root turn through the product's MCP entry, as a caller outside the page runs one. */
  async turn(workspace: string, text: string): Promise<void> {
    await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).runTaskFromMcp(text);
  }

  async heads(workspace: string, tag: string, count: number): Promise<void> {
    await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).hostHeads(tag, count);
  }
}

/** What the model answers and whether it answers yet; module state, which the entrypoint and fetch share. */
const model = { answerBytes: 0, holding: false, parked: 0, calls: 0, wide: new Set<string>() };

/** The product's `AI` binding: each streamed turn answers `answerBytes` of text, and waits while `holding`. */
export class ScriptedAI extends WorkerEntrypoint {
  async run(_model: string, inputs: { readonly stream?: boolean; readonly messages?: readonly object[] }): Promise<Response> {
    model.calls += 1;

    if (inputs.stream !== true) return Response.json({ response: '{"upserts":[],"decay":[]}' });
    const request = JSON.stringify(inputs);

    // Each character above U+00FF, with the text before it: one of them stores the whole request two bytes each.
    for (const match of request.matchAll(/[\u{100}-\u{10ffff}]/gu)) model.wide.add(request.slice(Math.max(0, match.index - 48), match.index + 1));
    model.parked += 1;

    // A timer is I/O to the runtime; a bare pending promise would be cancelled as a hung request.
    while (model.holding) await scheduler.wait(20);
    model.parked -= 1;

    const text = 'word '.repeat(Math.ceil(model.answerBytes / 5)).slice(0, model.answerBytes);
    const frames = [];

    for (let at = 0; at < text.length; at += 4096) frames.push(`data: ${JSON.stringify({ response: text.slice(at, at + 4096) })}\n\n`);
    frames.push(`data: ${JSON.stringify({ response: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`, 'data: [DONE]\n\n');

    return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } });
  }
}

export default {
  async fetch(request: Request, env: DriverEnv & { readonly HEAP_DRIVER: DurableObjectNamespace<HeapDriver> }): Promise<Response> {
    const url = new URL(request.url);
    const workspace = url.searchParams.get('workspace') ?? 'heap';
    const driver = env.HEAP_DRIVER.get(env.HEAP_DRIVER.idFromName(workspace));

    if (url.pathname === '/model') {
      model.answerBytes = Number(url.searchParams.get('answerBytes') ?? model.answerBytes);
      model.holding = url.searchParams.get('holding') === '1';

      return Response.json({ parked: model.parked, calls: model.calls, wide: [...model.wide] });
    }

    if (url.pathname === '/turn') await driver.turn(workspace, url.searchParams.get('text') ?? 'hello');
    else if (url.pathname === '/heads') await driver.heads(workspace, url.searchParams.get('tag') ?? 'head', Number(url.searchParams.get('count')));
    else await driver.setUp(workspace);

    return new Response(null, { status: 204 });
  },
};
