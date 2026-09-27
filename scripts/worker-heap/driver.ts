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
const model = { answerBytes: 0, holding: false, parked: 0, calls: 0, wide: new Set<string>(), toolSteps: 0, stepping: false, arrived: 0, released: 0, hires: 0, helpersAnswered: 0, holdHelper: false, helperParked: false };

/** The text of every user message a request carries. */
function userTexts(messages: readonly object[]): string[] {
  return messages.flatMap((message) => ('role' in message && message.role === 'user' && 'content' in message ? [JSON.stringify(message.content)] : []));
}

/** Steps each hired helper works before it answers. */
const HELPER_STEPS = 4;

const USAGE = `data: ${JSON.stringify({ response: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`;

/** The product's `AI` binding: each streamed turn answers `answerBytes` of text, and waits while `holding`. */
export class ScriptedAI extends WorkerEntrypoint {
  async run(_model: string, inputs: { readonly stream?: boolean; readonly messages?: readonly object[] }): Promise<Response> {
    model.calls += 1;

    if (inputs.stream !== true) return Response.json({ response: '{"upserts":[],"decay":[]}' });
    const request = JSON.stringify(inputs);

    // Each character above U+00FF, with the text before it: one of them stores the whole request two bytes each.
    for (const match of request.matchAll(/[\u{100}-\u{10ffff}]/gu)) model.wide.add(request.slice(Math.max(0, match.index - 48), match.index + 1));
    model.parked += 1;
    // Stepping: each call waits until the gate has read the heap at it.
    const seq = model.stepping ? ++model.arrived : 0;

    // A timer is I/O to the runtime; a bare pending promise would be cancelled as a hung request.
    while (model.holding || model.released < seq) await scheduler.wait(seq > 0 ? 2 : 20);
    model.parked -= 1;

    // Hiring: the root turn hires `hires` task helpers; each helper answers one page and is done.

    if (model.hires > 0) {
      const users = userTexts(inputs.messages ?? []);
      const messages = inputs.messages ?? [];
      const root = users.some((text) => text.includes('HIRE-ROOT'));
      const asked = messages.findLastIndex((message) => 'content' in message && JSON.stringify(message.content).includes('HIRE-ROOT'));
      const hiring = root && !messages.slice(asked).some((message) => 'role' in message && message.role === 'tool');

      if (!root) {
        const steps = messages.filter((message) => 'role' in message && message.role === 'tool').length;

        // Held at its last working step, a helper turn carries its whole transcript into a model call.
        if (model.holdHelper && steps === HELPER_STEPS - 1) {
          model.helperParked = true;

          while (model.holdHelper) await scheduler.wait(20);
          model.helperParked = false;
        }

        // A helper works a page per step, with a cheap tool call, then answers in one word.
        if (steps < HELPER_STEPS) {
          const page = 'word '.repeat(Math.ceil(model.answerBytes / 5)).slice(0, model.answerBytes);
          const call = { id: `work-${String(model.calls)}`, name: 'tasks', arguments: { action: 'list' } };

          return new Response(`data: ${JSON.stringify({ response: page, tool_calls: [call] })}\n\n${USAGE}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        }

        model.helpersAnswered += 1;

        return new Response(`data: ${JSON.stringify({ response: 'done' })}\n\n${USAGE}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      }

      const calls = hiring
        ? Array.from({ length: model.hires }, (_, at) => ({ id: `hire-${String(model.calls)}-${String(at)}`, name: 'agents',
          arguments: { action: 'hire', role: 'task', lifetime: 'task', mission: `Helper ${String(at)}: write one page, then stop.` } }))
        : [];

      return new Response(`data: ${JSON.stringify(calls.length > 0 ? { response: '', tool_calls: calls } : { response: 'done' })}\n\n${USAGE}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }

    if (model.toolSteps > 0) {
      model.toolSteps -= 1;
      const call = { id: `step-${String(seq)}`, name: 'file', arguments: JSON.stringify({ action: 'stat', path: '.' }) };

      return new Response(`data: ${JSON.stringify({ response: '', tool_calls: [call] })}\n\ndata: ${JSON.stringify({ response: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }

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

      if (url.searchParams.has('toolSteps')) {
        model.toolSteps = Number(url.searchParams.get('toolSteps'));
        model.stepping = model.toolSteps > 0;
        model.arrived = 0;
        model.released = 0;
      }

      if (url.searchParams.has('released')) model.released = Number(url.searchParams.get('released'));

      if (url.searchParams.has('holdHelper')) model.holdHelper = url.searchParams.get('holdHelper') === '1';

      if (url.searchParams.has('hires')) {
        model.hires = Number(url.searchParams.get('hires'));
        model.helpersAnswered = 0;
        model.stepping = false;
      }

      return Response.json({ parked: model.parked, calls: model.calls, wide: [...model.wide], arrived: model.arrived, helpersAnswered: model.helpersAnswered, helperParked: model.helperParked });
    }

    if (url.pathname === '/turn') await driver.turn(workspace, url.searchParams.get('text') ?? 'hello');
    else if (url.pathname === '/heads') await driver.heads(workspace, url.searchParams.get('tag') ?? 'head', Number(url.searchParams.get('count')));
    else await driver.setUp(workspace);

    return new Response(null, { status: 204 });
  },
};
