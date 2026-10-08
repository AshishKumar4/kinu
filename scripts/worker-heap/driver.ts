/**
 * The worker beside the built product in `scripts/worker-heap.ts`: it claims and sets up one workspace through
 * the product's own RPC, as the account plane does, so the product isolate's heap is read after a real setup.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { SCRIPTED_MODEL_SPEC } from '../../packages/test-utils/src/scripted-model-spec';
import { readScriptedRequest, SCRIPTED_MODELS_BODY, scriptedBody as compatBody, type ScriptedAnswer } from '../scripted-protocol';

/** The product RPC setup calls, as the account plane calls it; the classes live in the built bundle. */
interface WorkspaceRpc extends Rpc.DurableObjectBranded {
  claimOwner(owner: string): Promise<{ capabilityHash: string }>;
  setSoul(markdown: string): Promise<void>;
  setModel(model: string): Promise<void>;
  runTaskFromMcp(text: string): Promise<void>;
  /** `worker-heap/product.ts`'s probe RPC. */
  hostHeads(tag: string, count: number): Promise<void>;
  /** `worker-heap/product.ts`'s probe RPC. */
  delegatedRunners(): Promise<number>;
}

interface AccountRpc extends Rpc.DurableObjectBranded {
  ensureProfile(caller: { ownerToken: string }, email: string, name: string): Promise<void>;
  registerWorkspace(caller: { ownerToken: string }, name: string, displayName: string): Promise<void>;
  ensureWorkspaceCapability(workspace: string, capabilityHash: string): Promise<void>;
  setCredential(caller: { ownerToken: string }, key: string, credential: { kind: 'openai-compat'; baseURL: string; apiKey: string }): Promise<void>;
}

interface DriverEnv {
  /** `ownerCaller`'s token for the product's key, computed by the gate. */
  readonly OWNER_TOKEN: string;
  /** Where the product reaches its OpenAI-compatible endpoint: the gate routes this host's requests here. */
  readonly COMPAT_HOST: string;
  readonly OrchestratorAgent: DurableObjectNamespace<WorkspaceRpc>;
  readonly UserDO: DurableObjectNamespace<AccountRpc>;
}

const OWNER = 'fedcba9876543210fedcba9876543211';

export class HeapDriver extends DurableObject<DriverEnv> {
  /** `compat`: the workspace runs on the OpenAI-compatible path, the one the hosted providers (OpenRouter, OpenCode Go) take. */
  async setUp(workspace: string, compat: boolean): Promise<void> {
    const caller = { ownerToken: this.env.OWNER_TOKEN };
    const users = this.env.UserDO.get(this.env.UserDO.idFromName(OWNER));
    const agent = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace));
    await users.ensureProfile(caller, 'owner@heap.local', 'Owner');
    await users.registerWorkspace(caller, workspace, workspace);
    const claim = await agent.claimOwner(OWNER);
    await users.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await agent.setSoul('# Heap\n\nAnswer.');

    if (compat) await users.setCredential(caller, 'openai-compat.default', { kind: 'openai-compat', baseURL: `http://${this.env.COMPAT_HOST}`, apiKey: 'heap' });
    await agent.setModel(compat ? SCRIPTED_MODEL_SPEC : 'workers-ai/@cf/zai-org/glm-5.3');
  }

  /** One root turn through the product's MCP entry, as a caller outside the page runs one. */
  async turn(workspace: string, text: string): Promise<void> {
    await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).runTaskFromMcp(text);
  }

  async runners(workspace: string): Promise<number> {
    return this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).delegatedRunners();
  }

  async heads(workspace: string, tag: string, count: number): Promise<void> {
    await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).hostHeads(tag, count);
  }
}

/** What the model answers and whether it answers yet; module state, which the entrypoint and fetch share. */
const model = { answerBytes: 0, holding: false, parked: 0, calls: 0, wide: new Set<string>(), toolSteps: 0, stepBytes: 0, stepping: false, arrived: 0, released: 0, hires: 0, helpersAnswered: 0, holdHelper: false, helperParked: false, nest: false };

/** Each character above U+00FF in `request`, with the text before it: one of them stores the whole request two bytes each. */
function noteWide(request: string): void {
  for (const match of request.matchAll(/[\u{100}-\u{10ffff}]/gu)) model.wide.add(request.slice(Math.max(0, match.index - 48), match.index + 1));
}

/** The text of every user message a request carries. */
function userTexts(messages: readonly object[]): string[] {
  return messages.flatMap((message) => ('role' in message && message.role === 'user' && 'content' in message ? [JSON.stringify(message.content)] : []));
}

/** Holds a helper's model call while `holdHelper` is set. */
async function parkHelper(): Promise<void> {
  if (!model.holdHelper) return;
  model.helperParked = true;

  while (model.holdHelper) await scheduler.wait(20);
  model.helperParked = false;
}

/** Steps each hired helper works before it answers. */
const HELPER_STEPS = 4;

const USAGE = `data: ${JSON.stringify({ response: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`;

/** The product's `AI` binding: each streamed turn answers `answerBytes` of text, and waits while `holding`. */
async function scriptedBody(inputs: { readonly stream?: boolean; readonly messages?: readonly object[] }): Promise<string> {
  model.calls += 1;

  if (inputs.stream !== true) return JSON.stringify({ response: '{"upserts":[],"decay":[]}' });

  noteWide(JSON.stringify(inputs));
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

      const briefed = messages.some((message) => 'role' in message && (message.role === 'system' || message.role === 'user')
        && 'content' in message && JSON.stringify(message.content).includes('SUB-HELPER'));

      // Nested: the helper's own hire, held on its first call while the helper and the root wait on it. First call
      // only: the helper's own later steps carry the mission too, in the runtime context naming its hire.
      if (model.nest && briefed && steps === 0) {
        await parkHelper();

        return `data: ${JSON.stringify({ response: 'done' })}\n\n${USAGE}data: [DONE]\n\n`;
      }

      if (model.nest && steps === HELPER_STEPS) {
        const hire = { id: `sub-${String(model.calls)}`, name: 'agents', arguments: { op: 'hire', role: 'task', lifetime: 'task', mission: 'SUB-HELPER: answer done.' } };

        return `data: ${JSON.stringify({ response: '', tool_calls: [hire] })}\n\n${USAGE}data: [DONE]\n\n`;
      }

      // Held at its last working step, a helper turn carries its whole transcript into a model call.
      if (!model.nest && steps === HELPER_STEPS - 1) await parkHelper();

      // A helper works a page per step, with a cheap tool call, then answers in one word.
      if (steps < HELPER_STEPS) {
        const page = 'word '.repeat(Math.ceil(model.answerBytes / 5)).slice(0, model.answerBytes);
        const call = { id: `work-${String(model.calls)}`, name: 'tasks', arguments: { op: 'list' } };

        return `data: ${JSON.stringify({ response: page, tool_calls: [call] })}\n\n${USAGE}data: [DONE]\n\n`;
      }

      model.helpersAnswered += 1;

      return `data: ${JSON.stringify({ response: 'done' })}\n\n${USAGE}data: [DONE]\n\n`;
    }

    const calls = hiring
      ? Array.from({ length: model.hires }, (_, at) => ({ id: `hire-${String(model.calls)}-${String(at)}`, name: 'agents',
        arguments: { op: 'hire', role: 'task', lifetime: 'task', mission: `Helper ${String(at)}: write one page, then stop.` } }))
      : [];

    return `data: ${JSON.stringify(calls.length > 0 ? { response: '', tool_calls: calls } : { response: 'done' })}\n\n${USAGE}data: [DONE]\n\n`;
  }

  if (model.toolSteps > 0) {
    model.toolSteps -= 1;
    const call = { id: `step-${String(seq)}`, name: 'file', arguments: JSON.stringify({ op: 'stat', path: '.' }) };

    return `data: ${JSON.stringify({ response: '', tool_calls: [call] })}\n\ndata: ${JSON.stringify({ response: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
  }

  const text = 'word '.repeat(Math.ceil(model.answerBytes / 5)).slice(0, model.answerBytes);
  const frames = [];

  for (let at = 0; at < text.length; at += 4096) frames.push(`data: ${JSON.stringify({ response: text.slice(at, at + 4096) })}\n\n`);
  frames.push(`data: ${JSON.stringify({ response: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`, 'data: [DONE]\n\n');

  return frames.join('');
}

async function scriptedAnswer(inputs: Parameters<typeof scriptedBody>[0]): Promise<Response> {
  if (inputs.stream !== true) return new Response(await scriptedBody(inputs), { headers: { 'content-type': 'application/json' } });

  const encoder = new TextEncoder();

  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(': stream opened\n\n'));
      controller.enqueue(encoder.encode(await scriptedBody(inputs)));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

/** The OpenAI-compatible endpoint: each step of the long turn writes a page through the file tool, as an agent writing
 *  files does, so every later request carries that page again in the call's arguments. */
async function compatAnswer(body: string): Promise<Response> {
  const read = readScriptedRequest(body);

  if ('refusal' in read) return new Response(read.refusal.body, { status: read.refusal.status, headers: { 'content-type': 'application/json' } });
  const asked = read.request;
  let answer: ScriptedAnswer = { text: 'Heap' };

  if (asked.streamed) {
    model.calls += 1;
    noteWide(body);
    model.parked += 1;
    const seq = model.stepping ? ++model.arrived : 0;

    while (model.holding || model.released < seq) await scheduler.wait(seq > 0 ? 2 : 20);
    model.parked -= 1;
    const page = 'word '.repeat(Math.ceil(model.stepBytes / 5)).slice(0, model.stepBytes);

    answer = model.toolSteps > 0
      ? { toolCall: { name: 'file', arguments: { op: 'write', path: `notes/step-${String(seq)}.md`, content: page } } }
      : { text: 'done' };

    if (model.toolSteps > 0) model.toolSteps -= 1;
  }

  const out = compatBody(answer, asked);

  return new Response(out.body, { headers: { 'content-type': out.contentType } });
}

const AIRequestSchema = v.object({
  inputs: v.looseObject({ stream: v.optional(v.boolean()), messages: v.optional(v.array(v.record(v.string(), v.unknown()))) }),
});

export default {
  async fetch(request: Request, env: DriverEnv & { readonly HEAP_DRIVER: DurableObjectNamespace<HeapDriver> }): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === env.COMPAT_HOST) {
      return url.pathname === '/models' ? new Response(SCRIPTED_MODELS_BODY, { headers: { 'content-type': 'application/json' } }) : compatAnswer(await request.text());
    }

    if (url.pathname === '/ai') return scriptedAnswer(v.parse(AIRequestSchema, await request.json()).inputs);
    const workspace = url.searchParams.get('workspace') ?? 'heap';
    const driver = env.HEAP_DRIVER.get(env.HEAP_DRIVER.idFromName(workspace));

    if (url.pathname === '/model') {
      model.answerBytes = Number(url.searchParams.get('answerBytes') ?? model.answerBytes);
      model.holding = url.searchParams.get('holding') === '1';

      if (url.searchParams.has('toolSteps')) {
        model.toolSteps = Number(url.searchParams.get('toolSteps'));
        model.stepBytes = Number(url.searchParams.get('stepBytes') ?? 0);
        model.stepping = model.toolSteps > 0;
        model.arrived = 0;
        model.released = 0;
      }

      if (url.searchParams.has('released')) model.released = Number(url.searchParams.get('released'));

      // Released here, not when the held call next polls: the next phase's wait must not read this one's park.
      if (url.searchParams.has('holdHelper')) {
        model.holdHelper = url.searchParams.get('holdHelper') === '1';
        model.helperParked &&= model.holdHelper;
      }

      if (url.searchParams.has('nest')) model.nest = url.searchParams.get('nest') === '1';

      if (url.searchParams.has('hires')) {
        model.hires = Number(url.searchParams.get('hires'));
        model.helpersAnswered = 0;
        model.stepping = false;
      }

      return Response.json({ parked: model.parked, calls: model.calls, wide: [...model.wide], arrived: model.arrived, helpersAnswered: model.helpersAnswered, helperParked: model.helperParked });
    }

    if (url.pathname === '/runners') return Response.json(await driver.runners(workspace));

    if (url.pathname === '/turn') await driver.turn(workspace, url.searchParams.get('text') ?? 'hello');
    else if (url.pathname === '/heads') await driver.heads(workspace, url.searchParams.get('tag') ?? 'head', Number(url.searchParams.get('count')));
    else await driver.setUp(workspace, url.searchParams.get('compat') === '1');

    return new Response(null, { status: 204 });
  },
};
