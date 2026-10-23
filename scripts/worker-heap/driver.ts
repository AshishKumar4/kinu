/**
 * The worker beside the built product in `scripts/worker-heap.ts`: it claims and sets up one workspace through
 * the product's own RPC, as the account plane does, so the product isolate's heap is read after a real setup.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { SCRIPTED_MODEL_SPEC } from '../../packages/test-utils/src/scripted-model-spec';
import { readScriptedRequest, SCRIPTED_MODELS_BODY, scriptedBody as compatBody, type ScriptedAnswer } from '../scripted-protocol';
import { SLEEP_TIME_ANSWER } from '../sleep-time-script';

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
  setEvolutionConfig(config: { readonly advisorEnabled: boolean }): Promise<{ readonly advisorEnabled: boolean }>;
  /** `worker-heap/product.ts`'s probe RPC. */
  quiesce(): Promise<void>;
  /** `worker-heap/product.ts`'s probe RPC. */
  joinDetached(): Promise<void>;
  /** `worker-heap/product.ts`'s probe RPC. */
  plant(isolate: 'workspace' | 'main', marker: string, bytes: number): Promise<void>;
  /** `worker-heap/product.ts`'s probe RPC. */
  failedToolCalls(): Promise<number>;
  /** `worker-heap/product.ts`'s probe RPC. */
  mainIdle(): Promise<void>;
  /** `worker-heap/product.ts`'s probe RPC. */
  seedScreenshots(count: number, bytes: number): Promise<void>;
  /** `worker-heap/product.ts`'s probe RPC. */
  armAdvisorFault(fault: AdvisorFault | null): Promise<void>;
  /** `worker-heap/product.ts`'s probe RPC. */
  mainPlanted(): Promise<number>;
}

/** What `heap-plant-agent.ts` makes its advisor's model calls do once armed. */
type AdvisorFault = 'throw' | 'uncaught';

interface AccountRpc extends Rpc.DurableObjectBranded {
  ensureProfile(caller: { ownerToken: string }, email: string, name: string): Promise<void>;
  registerWorkspace(caller: { ownerToken: string }, name: string, displayName: string): Promise<void>;
  ensureWorkspaceCapability(workspace: string, capabilityHash: string): Promise<void>;
  setCredential(caller: { ownerToken: string }, key: string, credential: { kind: 'openai-compat'; baseURL: string; apiKey: string; contextWindow?: number }): Promise<void>;
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
  /** `compat`: the workspace runs on the OpenAI-compatible path, the one the hosted providers (OpenRouter, OpenCode Go) take;
   *  `window`, the context window its credential declares, which compaction folds against (none: no fold).
   *  Answers the workspace's object id, which names its agents' Worker Loader isolates. */
  async setUp(workspace: string, compat: boolean, window: number | null): Promise<string> {
    const caller = { ownerToken: this.env.OWNER_TOKEN };
    const users = this.env.UserDO.get(this.env.UserDO.idFromName(OWNER));
    const agent = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace));
    await users.ensureProfile(caller, 'owner@heap.local', 'Owner');
    await users.registerWorkspace(caller, workspace, workspace);
    const claim = await agent.claimOwner(OWNER);
    await users.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await agent.setSoul('# Heap\n\nAnswer.');

    if (compat) {
      await users.setCredential(caller, 'openai-compat.default', {
        kind: 'openai-compat', baseURL: `http://${this.env.COMPAT_HOST}`, apiKey: 'heap', ...(window !== null && { contextWindow: window }),
      });
    }

    await agent.setModel(compat ? SCRIPTED_MODEL_SPEC : 'workers-ai/@cf/zai-org/glm-5.3');
    // The model's change reaches main's isolate detached, and loads it: setup ends once it has.
    await agent.joinDetached();

    return agent.id.toString();
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

  async plant(workspace: string, isolate: 'workspace' | 'main', marker: string, bytes: number): Promise<void> {
    await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).plant(isolate, marker, bytes);
  }

  async mainIdle(workspace: string): Promise<void> {
    await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).mainIdle();
  }

  async failedToolCalls(workspace: string): Promise<number> {
    return await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).failedToolCalls();
  }

  async seedScreenshots(workspace: string, count: number, bytes: number): Promise<void> {
    await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).seedScreenshots(count, bytes);
  }

  /** The chat seed a pane reads as it opens, as the eval harness reads it while a turn runs: its size. */
  async seed(workspace: string): Promise<number> {
    const read = await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).fetch(`https://heap.invalid/agents/orchestrator-agent/${workspace}/get-messages`);

    return (await read.text()).length;
  }

  /** The owner's advisor switch on, as the settings card sets it. */
  async advisor(workspace: string): Promise<void> {
    await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).setEvolutionConfig({ advisorEnabled: true });
  }

  async quiesce(workspace: string): Promise<void> {
    await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).quiesce();
  }

  async armAdvisorFault(workspace: string, fault: AdvisorFault | null): Promise<void> {
    await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).armAdvisorFault(fault);
  }

  async mainPlanted(workspace: string): Promise<number> {
    return await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)).mainPlanted();
  }
}

/** Each advisor request's length, as it arrived. */
const ADVISOR_BYTES: number[] = [];

/** Each stepped turn request's length on the OpenAI-compatible path, as it arrived. */
const STEP_REQUEST_BYTES: number[] = [];

/** What the model answers and whether it answers yet; module state, which the entrypoint and fetch share. */
/** A compaction's summary call carries this (`buildCompactionSummaryPrompt`), on either path: the loop pass's compacting
 *  turn names its folds by it. */
const SUMMARY_PROMPT = 'Write the summary with exactly these sections';

const model = { answerBytes: 0, holding: false, parked: 0, calls: 0, wide: new Set<string>(), toolSteps: 0, stepBytes: 0, screenshots: 0, stepRead: false, summaries: 0, stepping: false, arrived: 0, released: 0, hires: 0, subagentsAnswered: 0, holdSubagent: false, subagentParked: false, nest: false, failingSteps: 0, failingAsked: 0, stepped: { binding: 0, compat: 0 }, compatSteps: false, advisorCalls: 0, advisorBytes: ADVISOR_BYTES, stepRequestBytes: STEP_REQUEST_BYTES };

/** The advisor's own model calls, which offer its `advise` tool: none is a step of the turn it reviews, so none takes a
 *  scripted step. */
function asksAdvisor(request: string): boolean {
  return /"name"\s*:\s*"advise"/u.test(request);
}

/** Each character above U+00FF in `request`, with the text before it: one of them stores the whole request two bytes each. */
function noteWide(request: string): void {
  for (const match of request.matchAll(/[\u{100}-\u{10ffff}]/gu)) model.wide.add(request.slice(Math.max(0, match.index - 48), match.index + 1));
}

/** The text of every user message a request carries. */
function userTexts(messages: readonly object[]): string[] {
  return messages.flatMap((message) => ('role' in message && message.role === 'user' && 'content' in message ? [JSON.stringify(message.content)] : []));
}

/** Holds a subagent's model call while `holdSubagent` is set. */
async function parkSubagent(): Promise<void> {
  if (!model.holdSubagent) return;
  model.subagentParked = true;

  while (model.holdSubagent) await scheduler.wait(20);
  model.subagentParked = false;
}

/** Steps each hired subagent works before it answers. */
const SUBAGENT_STEPS = 4;

const USAGE = `data: ${JSON.stringify({ response: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`;

type BindingInputs = { readonly stream?: boolean; readonly messages?: readonly object[]; readonly tools?: readonly object[] };

/**
 * What a call that is no turn's step answers, at once, in the form it asked for: a completion, and the memory lane's
 * structured call. A turn's step is known by the tools it offers, not by its stream: every Workers AI call streams
 * (`WORKERS_AI_STREAMS_GENERATE`). The gate's agents run the default roles, every step of which offers tools; a role
 * offered none (an account role with `allowedTools: []`) would be answered here, so the gate does not measure one. Answered a step's prose until 2026-10-20, the memory call failed off its schema,
 * and each failure's three 0.2 MB log lines stayed live in the DevTools console this gate attaches: the idle workspace
 * held 6.6 MB where it had held 3.9 MB (armada evo-42). Null for a turn's step.
 */
function laneAnswer(inputs: BindingInputs): string | null {
  // The advisor's review, answered at once with silence: the measured cost is its being there, not what it says.
  const asked = JSON.stringify(inputs);

  if (asked.includes(SUMMARY_PROMPT)) model.summaries += 1;

  if (asksAdvisor(asked)) {
    model.advisorCalls += 1;
    model.advisorBytes.push(asked.length);

    return `data: ${JSON.stringify({ response: '' })}\n\n${USAGE}data: [DONE]\n\n`;
  }

  if (inputs.tools !== undefined) return null;

  return inputs.stream === true
    ? `data: ${JSON.stringify({ response: SLEEP_TIME_ANSWER })}\n\n${USAGE}data: [DONE]\n\n`
    : JSON.stringify({ response: SLEEP_TIME_ANSWER });
}

/** A turn stepped on the compatible path owns the steps: another workspace's call on the binding is answered at once,
 *  counted, and takes none of them (it took half the advised pair's unadvised turn, 2026-10-23). */
function foreignCall(): string | null {
  if (!model.stepping || !model.compatSteps) return null;
  model.stepped.binding += 1;

  return `data: ${JSON.stringify({ response: SLEEP_TIME_ANSWER })}\n\n${USAGE}data: [DONE]\n\n`;
}

/** Stepping: a binding call waits until the gate has read the heap at it, and is its step's number (0 unstepped). The
 *  cursor is every workspace's: which path took each step is counted, so the gate can tell its turn's steps from another
 *  workspace's. */
async function bindingStep(): Promise<number> {
  model.parked += 1;
  const seq = model.stepping ? ++model.arrived : 0;

  if (seq > 0) model.stepped.binding += 1;

  // A timer is I/O to the runtime; a bare pending promise would be cancelled as a hung request.
  while (model.holding || model.released < seq) await scheduler.wait(seq > 0 ? 2 : 20);
  model.parked -= 1;

  return seq;
}

/** The product's `AI` binding: each streamed turn answers `answerBytes` of text, and waits while `holding`. */
async function scriptedBody(inputs: BindingInputs): Promise<string> {
  model.calls += 1;
  const lane = laneAnswer(inputs);

  if (lane !== null) return lane;

  noteWide(JSON.stringify(inputs));
  const foreign = foreignCall();

  if (foreign !== null) return foreign;
  const seq = await bindingStep();

  // Hiring: the root turn hires `hires` task subagents; each subagent answers one page and is done.

  if (model.hires > 0) {
    const users = userTexts(inputs.messages ?? []);
    const messages = inputs.messages ?? [];
    const root = users.some((text) => text.includes('HIRE-ROOT'));
    const asked = messages.findLastIndex((message) => 'content' in message && JSON.stringify(message.content).includes('HIRE-ROOT'));
    const hiring = root && !messages.slice(asked).some((message) => 'role' in message && message.role === 'tool');

    if (!root) {
      const steps = messages.filter((message) => 'role' in message && message.role === 'tool').length;

      const briefed = messages.some((message) => 'role' in message && (message.role === 'system' || message.role === 'user')
        && 'content' in message && JSON.stringify(message.content).includes('SUB-SUBAGENT'));

      // Nested: the subagent's own hire, held on its first call while the subagent and the root wait on it. First call
      // only: the subagent's own later steps carry the mission too, in the runtime context naming its hire.
      if (model.nest && briefed && steps === 0) {
        await parkSubagent();

        return `data: ${JSON.stringify({ response: 'done' })}\n\n${USAGE}data: [DONE]\n\n`;
      }

      if (model.nest && steps === SUBAGENT_STEPS) {
        const hire = { id: `sub-${String(model.calls)}`, name: 'agents', arguments: { op: 'hire', role: 'task', lifetime: 'task', message: 'SUB-SUBAGENT: answer done.' } };

        return `data: ${JSON.stringify({ response: '', tool_calls: [hire] })}\n\n${USAGE}data: [DONE]\n\n`;
      }

      // Held at its last working step, a subagent turn carries its whole transcript into a model call.
      if (!model.nest && steps === SUBAGENT_STEPS - 1) await parkSubagent();

      // A subagent works a page per step, with a cheap tool call, then answers in one word.
      if (steps < SUBAGENT_STEPS) {
        const page = 'word '.repeat(Math.ceil(model.answerBytes / 5)).slice(0, model.answerBytes);
        const call = { id: `work-${String(model.calls)}`, name: 'tasks', arguments: { op: 'list' } };

        return `data: ${JSON.stringify({ response: page, tool_calls: [call] })}\n\n${USAGE}data: [DONE]\n\n`;
      }

      model.subagentsAnswered += 1;

      return `data: ${JSON.stringify({ response: 'done' })}\n\n${USAGE}data: [DONE]\n\n`;
    }

    const calls = hiring
      ? Array.from({ length: model.hires }, (_, at) => ({ id: `hire-${String(model.calls)}-${String(at)}`, name: 'agents',
        arguments: { op: 'hire', role: 'task', lifetime: 'task', message: `Subagent ${String(at)}: write one page, then stop.` } }))
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

/** A tool step's call. A screenshot turn reads one of its seeded screenshots a step, as a desktop turn takes one.
 *  `stepRead`: the first step writes its page and every later one reads it back, a step's result as large as its page, as
 *  a program's or a log's. Otherwise each step writes its page. */
function stepCall(seq: number, page: string): NonNullable<ScriptedAnswer['toolCall']> {
  if (model.screenshots > 0) return { name: 'file', arguments: { op: 'read', path: `shots/step-${String(seq % model.screenshots)}.png` } };

  if (model.stepRead && seq > 1) return { name: 'file', arguments: { op: 'read', path: 'notes/step-1.md' } };

  return { name: 'file', arguments: { op: 'write', path: `notes/step-${String(seq)}.md`, content: page } };
}

/** The OpenAI-compatible endpoint: each step of the long turn writes a page through the file tool, as an agent writing
 *  files does, so every later request carries that page again in the call's arguments. */
async function compatAnswer(body: string): Promise<Response> {
  const read = readScriptedRequest(body);

  if ('refusal' in read) return new Response(read.refusal.body, { status: read.refusal.status, headers: { 'content-type': 'application/json' } });
  const asked = read.request;
  let answer: ScriptedAnswer = { text: 'Heap' };

  if (body.includes(SUMMARY_PROMPT)) model.summaries += 1;

  // The advisor's review, answered at once with silence: the measured cost is its being there, not what it says.
  if (asksAdvisor(body)) {
    model.advisorCalls += 1;
    model.advisorBytes.push(body.length);
    const out = compatBody({ text: '' }, asked);

    return new Response(out.body, { headers: { 'content-type': out.contentType } });
  }

  if (asked.streamed) {
    model.calls += 1;
    noteWide(body);
    model.parked += 1;
    const seq = model.stepping ? ++model.arrived : 0;

    if (seq > 0) {
      model.stepped.compat += 1;
      model.stepRequestBytes.push(body.length);
    }

    while (model.holding || model.released < seq) await scheduler.wait(seq > 0 ? 2 : 20);
    model.parked -= 1;
    const page = 'word '.repeat(Math.ceil(model.stepBytes / 5)).slice(0, model.stepBytes);

    const step = stepCall(seq, page);

    answer = model.toolSteps > 0 ? { toolCall: step } : { text: 'done' };

    if (model.toolSteps > 0) model.toolSteps -= 1;
    // Failing: each step reads a file no workspace has, so the workspace's tool call rejects back across the port.
    else if (model.failingSteps > 0) {
      answer = { toolCall: { name: 'file', arguments: { op: 'read', path: `missing/step-${String(model.failingSteps)}.md` } } };
      model.failingSteps -= 1;
      model.failingAsked += 1;
    }
  }

  const out = compatBody(answer, asked);

  return new Response(out.body, { headers: { 'content-type': out.contentType } });
}

const AIRequestSchema = v.object({
  inputs: v.looseObject({ stream: v.optional(v.boolean()), messages: v.optional(v.array(v.record(v.string(), v.unknown()))) }),
});

/** The gate's script for the model, as `/model`'s parameters set it; answered with what the model has seen. */
function scriptModel(asked: URLSearchParams): Response {
  model.answerBytes = Number(asked.get('answerBytes') ?? model.answerBytes);
  model.holding = asked.get('holding') === '1';

  if (asked.has('toolSteps')) {
    model.toolSteps = Number(asked.get('toolSteps'));
    model.stepBytes = Number(asked.get('stepBytes') ?? 0);
    model.screenshots = Number(asked.get('screenshots') ?? 0);
    model.stepRead = asked.get('stepRead') === '1';
    model.stepping = model.toolSteps > 0;
    // `stepPath=compat`: the steps are the compatible path's alone; another workspace's binding calls are answered and
    // counted, never stepped.
    model.compatSteps = asked.get('stepPath') === 'compat';
    model.arrived = 0;
    model.released = 0;
    model.stepped = { binding: 0, compat: 0 };
    model.stepRequestBytes.length = 0;
  }

  if (asked.has('released')) model.released = Number(asked.get('released'));

  // Released here, not when the held call next polls: the next phase's wait must not read this one's park.
  if (asked.has('holdSubagent')) {
    model.holdSubagent = asked.get('holdSubagent') === '1';
    model.subagentParked &&= model.holdSubagent;
  }

  if (asked.has('nest')) model.nest = asked.get('nest') === '1';

  if (asked.has('failingSteps')) {
    model.failingSteps = Number(asked.get('failingSteps'));

    if (model.failingSteps > 0) model.failingAsked = 0;
  }

  if (asked.has('hires')) {
    model.hires = Number(asked.get('hires'));
    model.subagentsAnswered = 0;
    model.stepping = false;
  }

  return Response.json({ parked: model.parked, calls: model.calls, wide: [...model.wide], arrived: model.arrived, subagentsAnswered: model.subagentsAnswered, subagentParked: model.subagentParked, failingSteps: model.failingSteps, stepped: model.stepped, advisorCalls: model.advisorCalls, advisorBytes: model.advisorBytes, stepRequestBytes: model.stepRequestBytes, summaries: model.summaries });
}

export default {
  async fetch(request: Request, env: DriverEnv & { readonly HEAP_DRIVER: DurableObjectNamespace<HeapDriver> }): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === env.COMPAT_HOST) {
      return url.pathname === '/models' ? new Response(SCRIPTED_MODELS_BODY, { headers: { 'content-type': 'application/json' } }) : compatAnswer(await request.text());
    }

    if (url.pathname === '/ai') return scriptedAnswer(v.parse(AIRequestSchema, await request.json()).inputs);
    const workspace = url.searchParams.get('workspace') ?? 'heap';
    const driver = env.HEAP_DRIVER.get(env.HEAP_DRIVER.idFromName(workspace));

    if (url.pathname === '/model') return scriptModel(url.searchParams);

    if (url.pathname === '/runners') return Response.json(await driver.runners(workspace));

    if (url.pathname === '/failed-tool-calls') return Response.json(await driver.failedToolCalls(workspace));

    if (url.pathname === '/main-planted') return Response.json(await driver.mainPlanted(workspace));

    // Polled as the holds above are: this stateless entry's requests cannot settle one another's promises.
    if (url.pathname === '/failing-started') while (model.failingAsked === 0) await scheduler.wait(20);
    else if (url.pathname === '/main-idle') await driver.mainIdle(workspace);
    else if (url.pathname === '/turn') await driver.turn(workspace, url.searchParams.get('text') ?? 'hello');
    else if (url.pathname === '/heads') await driver.heads(workspace, url.searchParams.get('tag') ?? 'head', Number(url.searchParams.get('count')));
    else if (url.pathname === '/quiesce') await driver.quiesce(workspace);
    else if (url.pathname === '/advisor') await driver.advisor(workspace);
    else if (url.pathname === '/advisor-fault') await driver.armAdvisorFault(workspace, v.parse(v.nullable(v.picklist(['throw', 'uncaught'])), url.searchParams.get('fault')));
    else if (url.pathname === '/seed-screenshots') await driver.seedScreenshots(workspace, Number(url.searchParams.get('count')), Number(url.searchParams.get('bytes')));
    else if (url.pathname === '/seed') return Response.json(await driver.seed(workspace));
    else if (url.pathname === '/plant') await driver.plant(workspace, v.parse(v.picklist(['workspace', 'main']), url.searchParams.get('isolate')), v.parse(v.string(), url.searchParams.get('marker')), Number(url.searchParams.get('bytes')));
    else return new Response(await driver.setUp(workspace, url.searchParams.get('compat') === '1', url.searchParams.has('window') ? Number(url.searchParams.get('window')) : null));

    return new Response(null, { status: 204 });
  },
};
