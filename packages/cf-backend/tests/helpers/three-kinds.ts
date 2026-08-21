/**
 * THE THREE AGENT KINDS, BEHIND ONE FIXTURE.
 *
 * The requirement is that an orchestrator, a subordinate and a swarm node are the
 * same kind of thing with the same capabilities. That is a claim about behaviour,
 * so the only mechanical proof of it is one set of assertions that passes for all
 * three — which needs one fixture shape the three kinds can each satisfy. This
 * module is that shape and nothing else; the assertions live in
 * `unit-three-kinds-one-contract.test.ts`.
 *
 * ## Where the observation is taken, and why it has to be there
 *
 * There is no single function that runs a turn for all three. An orchestrator and
 * a subordinate are ONE class — `SubordinateAgent extends ActorAgent` — whose turn
 * body is Think's `streamText` loop reached through hooks (`beforeTurn`,
 * `beforeStep`, `afterToolCall`, `onStepFinish`, `onChatResponse`). A swarm node's
 * turn body is core's own `runHeadInference`, reached through `runNodeAgent`. So the
 * narrowest thing all three genuinely share is THE PROVIDER REQUEST: each assembles
 * a system prompt, a message array, a tool surface and a set of provider options,
 * and hands them to a `LanguageModel`.
 *
 * Every fixture therefore reports a {@link TurnRequest} produced by production
 * code. For a node the request is CAPTURED OFF THE WIRE — the node runs on a real
 * Workers AI model whose `fetch` is injected, so the header and the request body are
 * measured rather than derived. For the two actor kinds it is what `beforeTurn` and
 * then `beforeStep` produced, which Think uses verbatim (`finalMessages =
 * config.messages ?? messages`), so it is the request and not a rehearsal of one.
 *
 * That asymmetry is not a convenience. It IS the finding under measurement: the
 * actor kinds cannot be driven to a provider request outside workerd because their
 * loop belongs to Think, while a node's loop belongs to core. A fixture that hid the
 * asymmetry behind a shared stub would prove the three kinds agree about a stub.
 *
 * ## Declared differences
 *
 * A kind that legitimately differs declares it as a `Difference` with a reason and a
 * verdict. The suite reads the declarations and asserts against them, so an
 * undeclared divergence fails and a declared one is documented where a reader looks.
 * There are no skips: a capability a kind lacks is asserted as lacking.
 */

import type {
  LanguageModelV3CallOptions, LanguageModelV3Content, LanguageModelV3Prompt,
  LanguageModelV3FinishReason, LanguageModelV3StreamPart,
} from '@ai-sdk/provider';

import { jsonSchema, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import type {
  ChatResponseResult, PrepareStepContext, StepConfig, ToolCallResultContext,
  TurnConfig, TurnContext,
} from '@cloudflare/think';
import * as v from 'valibot';
import {
  AgentOrchestrator,
  BackgroundJobRunner,
  BackgroundJobStore,
  HeadJournal,
  asFetchFunction,
  buildBuiltinTools,
  initHeadsTables,
  isBackgroundHandle,
  keepBuiltins,
  runNodeAgent,
  runNodeLoop,
  NODE_BUILTIN_TOOLS,
  type HeadRunHeadView,
  type NodeAgentDeps,
  type NodeAgentInput,
  type NodeRun,
  type Usage,
} from '@kinu.run/core';
import { createRecordingLogger, renderCauseChain } from '@kinu.run/core/obs';
import { createTestRuntime } from '@kinu.run/test-utils';
import type { Database } from 'bun:sqlite';
import { createAgentProviderRegistry } from '../../src/providers/agent-registry';
import {
  orchestratorHarness, subordinateHarness, type ActorHarness,
} from './actor-harness';
import { userCredentialSource } from './user-credentials';

/** The three kinds, named the way the conformance manifest names its roots. */
export type AgentKind = 'cf-orchestrator' | 'cf-subordinate' | 'swarm-node';

/**
 * A capability this kind does not have, or has differently, and why.
 *
 * `verdict` is the whole point of declaring rather than skipping: `asymmetry` says
 * the difference belongs to this kind by design and names the design; `defect` says
 * the suite is REPORTING a gap, and the assertion under it observes the gap rather
 * than tolerating it.
 */
export interface Difference {
  readonly capability: string;
  readonly verdict: 'asymmetry' | 'defect';
  readonly reason: string;
}

/**
 * One message of a request, at the resolution these assertions read.
 *
 * A named projection rather than either source's own message type, because the two
 * sources have two: an actor's request is `ModelMessage[]`, and a node's is the
 * provider prompt the SDK converted it into. Projecting both into this loses nothing
 * an assertion here reads and removes the alternative, which is asserting over one
 * shape asserted to be the other.
 */
export interface RequestMessage {
  readonly role: string;
  /** Provider options attached to THIS message — the form a marker-family cache
   *  breakpoint takes. Absent means none were placed on it. The SDK's own message
   *  type owns the shape; both sources produce something assignable to it. */
  readonly providerOptions: ModelMessage['providerOptions'];
  /** Every part's discriminator, in order: `text`, `tool-call`, `tool-result`, … */
  readonly partTypes: readonly string[];
  /** The message's text, tool inputs and tool outputs, concatenated — what a
   *  content assertion reads without caring which part carried it. */
  readonly text: string;
}

/**
 * How a request's system prompt rode.
 *
 * `text` is a bare string, which is all a family with no system breakpoint gets.
 * `cacheable-message` is a typed system MESSAGE, which is what a marker-family cache
 * plan produces and the only form in which a system breakpoint exists. The
 * distinction IS the cache control, so it is a domain value here rather than a
 * representation the reader has to re-derive.
 */
export type SystemCarriage = 'text' | 'cacheable-message';

/**
 * The provider request one turn of this kind assembled.
 *
 * The three cache-bearing fields — `systemCarriage`, `providerOptions`, and each
 * message's own options — are the two prompt-cache mechanisms as they appear on a
 * request. All are observed, because "this kind places no cache control" is exactly
 * the claim a reading of the wiring gets wrong.
 */
export interface TurnRequest {
  readonly system: string;
  readonly systemCarriage: SystemCarriage;
  readonly messages: readonly RequestMessage[];
  readonly toolNames: readonly string[];
  /** Request-level provider options — where the OpenAI-compatible family's cache
   *  route rides, and where an actor's reasoning-effort options ride too. */
  readonly providerOptions: RequestProviderOptions;
}

/**
 * The request-level provider options a turn set, as a reader of the request sees
 * them.
 *
 * A projection rather than the map itself, because the two sources declare two
 * different maps (Think's `Record<string, unknown>` and the SDK's
 * `Record<string, JSONObject>`) and neither is the fact under test. An empty
 * `namespaces` is the measurable form of "the assembler set none at all".
 */
export interface RequestProviderOptions {
  readonly namespaces: readonly string[];
  /** The payload rendered, so a cache-control probe reads one string whichever
   *  provider family placed it. `''` when nothing was set. */
  readonly rendered: string;
}

/** Whatever provider-options map an assembler produced, projected.
 *
 * The parameter names both owners rather than a dictionary: Think's `TurnConfig`
 * declares `Record<string, unknown>` and the SDK's call options declare
 * `Record<string, JSONObject>`, and neither of those shapes is the fact under test. */
export function readRequestProviderOptions(
  options: TurnConfig['providerOptions'] | LanguageModelV3CallOptions['providerOptions'],
): RequestProviderOptions {
  if (options === undefined) return { namespaces: [], rendered: '' };
  return { namespaces: Object.keys(options), rendered: JSON.stringify(options) };
}

/** Every provider-native cache control present on a request, by where it rode.
 *  Empty is the measurable form of "this kind placed none". */
export function cacheControlsOn(request: TurnRequest): readonly string[] {
  const found: string[] = [];
  if (request.systemCarriage === 'cacheable-message') found.push('system-message');
  if (namesACacheControl(request.providerOptions.rendered)) found.push('request-level');
  for (const [index, message] of request.messages.entries()) {
    const rendered = message.providerOptions === undefined ? '' : JSON.stringify(message.providerOptions);
    if (namesACacheControl(rendered)) found.push(`message-${String(index)}`);
  }
  return found;
}

/** The provider-native cache keys, across the families that have one: Anthropic's
 *  per-block marker and the OpenAI-compatible request-level route. */
function namesACacheControl(rendered: string): boolean {
  return /cacheControl|cache_control|prompt_cache_key|promptCacheKey/.test(rendered);
}

/** What a finished turn left behind, as a reader of the durable store sees it. */
export interface TurnOutcome {
  /** Null until the turn reached a terminal state. `errorMessage` is the text a
   *  human is given for a failure — the thing a dropped cause chain shortens. */
  readonly terminal: { readonly status: string; readonly errorMessage: string | null } | null;
  readonly usage: Usage;
  readonly stepCount: number;
}

// ── The scripted provider ─────────────────────────────────────────────────────

/** What the scripted provider answers with, per call. */
export interface ScriptedTurn {
  /** One entry per provider call, in order. The last entry repeats when the loop
   *  asks again, so a script cannot silently run out and be read as a stop. */
  readonly steps: readonly ScriptedStep[];
  /** Thrown from the provider on the call at this index — the failure path. */
  readonly throwAt?: { readonly call: number; readonly error: Error };
  readonly mission?: MissionRecorder;
  readonly signal?: AbortSignal;
}

export interface ScriptedStep {
  readonly text?: string;
  readonly toolCall?: { readonly name: string; readonly input: unknown };
  /** Absent means THE PROVIDER SAID NOTHING about this step's usage, which is a
   *  different fact from a reported zero and the one `usageReported` turns on. */
  readonly usage?: { readonly input: number; readonly output: number };
}

/** A scripted provider plus the requests it received. */
export interface ScriptedProvider {
  readonly model: LanguageModel;
  readonly calls: readonly TurnRequest[];
}

/**
 * A provider that answers a script and RECORDS what it was asked.
 *
 * Both `doGenerate` and `doStream` are synthesised from the same script. That is not
 * belt-and-braces: `runHeadInference` calls `generateText` today and is being moved
 * onto `runChat`'s `streamText`, and a fake implementing one arm answers "Not
 * implemented" on the other. One script, two arms, so this fixture measures the loop
 * rather than the fake's coverage.
 */
export function scriptedProvider(script: ScriptedTurn): ScriptedProvider {
  const calls: TurnRequest[] = [];
  let call = 0;

  const answer = (options: LanguageModelV3CallOptions) => {
    calls.push(readCallOptions(options));
    const index = call++;
    if (script.throwAt && script.throwAt.call === index) throw script.throwAt.error;
    const step = script.steps[Math.min(index, script.steps.length - 1)];
    const content: LanguageModelV3Content[] = [];
    if (step?.text) content.push({ type: 'text', text: step.text });
    if (step?.toolCall) {
      content.push({
        type: 'tool-call',
        toolCallId: `call-${String(index)}`,
        toolName: step.toolCall.name,
        input: JSON.stringify(step.toolCall.input),
      });
    }
    const metered = step?.usage;
    const finish: LanguageModelV3FinishReason = {
      unified: step?.toolCall ? 'tool-calls' : 'stop',
      raw: undefined,
    };
    return {
      content,
      finishReason: finish,
      usage: {
        inputTokens: {
          total: metered?.input, noCache: metered?.input,
          cacheRead: undefined, cacheWrite: undefined,
        },
        outputTokens: { total: metered?.output, text: metered?.output, reasoning: undefined },
      },
      warnings: [],
    };
  };

  const model = new MockLanguageModelV3({
    provider: 'three-kinds-fake',
    modelId: 'three-kinds-fake-model',
    doGenerate: async (options) => answer(options),
    doStream: async (options) => {
      const settled = answer(options);
      const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      for (const part of settled.content) {
        if (part.type === 'text') {
          parts.push({ type: 'text-start', id: 't0' });
          parts.push({ type: 'text-delta', id: 't0', delta: part.text });
          parts.push({ type: 'text-end', id: 't0' });
        } else if (part.type === 'tool-call') {
          parts.push(part);
        }
      }
      parts.push({ type: 'finish', finishReason: settled.finishReason, usage: settled.usage });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
  return { model, calls };
}

/** The request, as the provider received it. */
function readCallOptions(options: LanguageModelV3CallOptions): TurnRequest {
  const system = options.prompt.find((message) => message.role === 'system');
  return {
    system: system ? promptMessage(system).text : '',
    // At this layer a marker plan's cache-eligible system has already become a
    // system prompt MESSAGE carrying `cacheControl`, which is the only form the wire
    // has for it — so options on the system message are the system breakpoint.
    systemCarriage: system?.providerOptions === undefined ? 'text' : 'cacheable-message',
    messages: options.prompt.map(promptMessage),
    toolNames: (options.tools ?? []).map((entry) => entry.name),
    providerOptions: readRequestProviderOptions(options.providerOptions),
  };
}

function promptMessage(message: LanguageModelV3Prompt[number]): RequestMessage {
  const parts = readContentParts(message.content);
  return {
    role: message.role,
    providerOptions: message.providerOptions,
    partTypes: parts.map((part) => part.type),
    // The text a message carried, whatever kind of part carried it. Tool inputs and
    // outputs are included: an assertion about a tool result reaching the transcript
    // is an assertion about exactly that content.
    text: parts.length > 0
      ? parts.map(renderPart).join('\n')
      : v.parse(v.string(), message.content),
  };
}

/** A message's parts, or `[]` for the string form a system prompt takes. Parsed
 *  rather than narrowed, so the branch is on a domain value — a part list — and not
 *  on which of two representations the SDK chose. */
function readContentParts(
  content: LanguageModelV3Prompt[number]['content'],
): readonly ContentPart[] {
  const parsed = v.safeParse(v.array(ContentPartSchema), content);
  return parsed.success ? parsed.output : [];
}

const ContentPartSchema = v.looseObject({
  type: v.string(),
  text: v.optional(v.string()),
  input: v.optional(v.unknown()),
  output: v.optional(v.unknown()),
});
type ContentPart = v.InferOutput<typeof ContentPartSchema>;

function renderPart(part: ContentPart): string {
  if (part.type === 'text') return part.text ?? '';
  if (part.type === 'tool-call') return JSON.stringify(part.input);
  if (part.type === 'tool-result') return JSON.stringify(part.output);
  return '';
}

// ── The mission ledger, recording rather than enforcing ───────────────────────

/** A mission ledger that records instead of refusing, so an assertion reads what
 *  the turn CHARGED rather than whether it was stopped. */
export interface MissionRecorder {
  readonly debits: Array<{ readonly amount: number; readonly calls: number }>;
  readonly guards: string[];
}

export function missionRecorder(): MissionRecorder {
  return { debits: [], guards: [] };
}

/** The `MissionScope` shape core expects, over a recorder. `labels` is a real
 *  non-empty label set: `localMissionScope` refuses to build a scope from an empty
 *  one, so an unlabelled scope is a shape the production path never produces. */
export function missionScope(recorder: MissionRecorder): NonNullable<NodeAgentDeps['mission']> {
  return {
    labels: ['three-kinds'],
    port: {
      guard: async (seam) => { recorder.guards.push(seam); return null; },
      debit: async (tokens, opts) => {
        recorder.debits.push({ amount: tokens, calls: opts.calls ?? 0 });
      },
    },
  };
}

// ── The node fixture ──────────────────────────────────────────────────────────

export interface NodeFixtureOptions {
  /** A model built elsewhere — used where the measurement is about the MODEL
   *  (affinity, request body) rather than about the loop. */
  readonly model?: LanguageModel;
  readonly depth?: number;
  readonly arbitrate?: NodeAgentInput['arbitrate'];
  readonly nodeId?: string;
  readonly parentId?: string | null;
  readonly inherited?: NodeAgentInput['inherited'];
  readonly context?: NodeAgentInput['context'];
  readonly messages?: readonly ModelMessage[];
  readonly host?: NodeAgentDeps['host'];
  /** A ready-made `execute_tools` entry, through the same dep the CF backend uses
   *  (`BuiltinToolDeps.preBuiltExecuteTool`). Supplied where an assertion needs a
   *  tool whose output it knows, rather than whatever a shell-less runtime returns. */
  readonly executeTool?: NodeAgentDeps['executeTool'];
  /** Detach policy override, so an arm about backgrounding finishes in under a second
   *  instead of waiting out the shipped 30 s threshold. The RELATIONSHIP is what is
   *  measured; the magnitude is a fixture. */
  readonly backgroundPolicy?: NodeAgentDeps['backgroundPolicy'];
}

/** One swarm node's engine-authored input. */
export function nodeInput(opts?: NodeFixtureOptions): NodeAgentInput {
  return {
    nodeId: opts?.nodeId ?? 'node-1',
    rootId: 'root-1',
    parentId: opts?.parentId ?? null,
    depth: opts?.depth ?? 1,
    task: 'Name the cheapest change to the reference implementation.',
    rationale: 'the direct angle',
    base: 'Objective: make it cheaper. Your angle: the direct one.',
    messages: opts?.messages ?? [{ role: 'user', content: 'Answer the task.' }],
    inherited: opts?.inherited ?? [],
    context: opts?.context ?? 'fresh',
    mode: 'build',
    settle: 'best',
    arbitrate: opts?.arbitrate ?? null,
  };
}

export interface NodeSeams {
  readonly deps: NodeAgentDeps;
  readonly journal: HeadJournal;
}

export interface NodeDepsOptions extends NodeFixtureOptions {
  readonly mission?: MissionRecorder;
  readonly signal?: AbortSignal;
}

export function nodeDeps(model: LanguageModel, opts?: NodeDepsOptions): NodeSeams {
  const { rt } = createTestRuntime();
  // The PRODUCTION head DDL, not a hand-picked subset: `runNodeAgent` opens a row
  // before it dispatches and closes one whatever happens, so a fixture missing a
  // column measures a store no swarm ever has.
  initHeadsTables(rt.storage.execRaw, rt.storage.sql);
  const journal = new HeadJournal(rt.storage.sql);
  const deps: NodeAgentDeps = {
    rt, model, journal,
    logger: createRecordingLogger(),
  };
  if (opts?.mission) deps.mission = missionScope(opts.mission);
  if (opts?.signal) deps.signal = opts.signal;
  if (opts?.host) deps.host = opts.host;
  if (opts?.executeTool !== undefined) deps.executeTool = opts.executeTool;
  if (opts?.backgroundPolicy !== undefined) deps.backgroundPolicy = opts.backgroundPolicy;
  return { deps, journal };
}

export interface NodeDrive {
  readonly requests: readonly TurnRequest[];
  readonly outcome: TurnOutcome;
  readonly run: NodeRun | null;
  /** The error `runNodeAgent` threw, when it threw. A TRANSPORT failure is the only
   *  thing that gets out of it; a LOOP failure becomes an errored report. */
  readonly thrown: unknown;
  readonly view: HeadRunHeadView | null;
  readonly journal: HeadJournal;
}

/**
 * A host that is a TRANSPORT and nothing else: it rebuilds the live seams the way a
 * facet does across an RPC and calls the real `runNodeLoop`.
 *
 * `arbitrate` is deliberately non-null whatever the search decided, because that is
 * the fact the build-time exclusion exists for: a facet's arbiter is an RPC stub and
 * is therefore always present, so presence alone cannot answer whether the proposal
 * tool should be offered. Only `spec.canPropose` can.
 */
export function forwardingHost(model: LanguageModel): NonNullable<NodeAgentDeps['host']> {
  return async (spec) => runNodeLoop(spec, {
    rt: createTestRuntime().rt,
    model,
    logger: createRecordingLogger(),
    arbitrate: async (proposal) => ({
      kind: 'granted', width: 2, nodeIds: ['child-a', 'child-b'], proposal,
    }),
  });
}

/** Drive one node turn end to end through its production entry point. */
export async function driveNode(script: ScriptedTurn, opts?: NodeFixtureOptions): Promise<NodeDrive> {
  const scripted = scriptedProvider(script);
  const model = opts?.model ?? scripted.model;
  // A caller measuring the MODEL supplies its own, and then the script's recording
  // arm is not the one in play — the wire capture is. Reported as empty rather than
  // as the scripted provider's untouched array, which would read as "no requests".
  const requests = opts?.model ? [] : scripted.calls;

  const depsOpts: NodeDepsOptions = { ...opts };
  const withSeams: NodeDepsOptions = script.mission
    ? { ...depsOpts, mission: script.mission }
    : depsOpts;
  const seamsOpts: NodeDepsOptions = script.signal
    ? { ...withSeams, signal: script.signal }
    : withSeams;
  const { deps, journal } = nodeDeps(model, seamsOpts);
  const input = nodeInput(opts);

  let run: NodeRun | null = null;
  let thrown: unknown;
  try {
    run = await runNodeAgent(input, deps);
  } catch (err) {
    // Held, not swallowed: `runNodeAgent` throws only for a TRANSPORT failure and
    // which of the two paths a failure took is exactly what the terminal-record
    // assertion is about. Rethrowing here would discard the journal row the throw is
    // documented to leave behind.
    thrown = err;
  }
  const view = journal.readHeadView(input.nodeId);
  return {
    requests,
    outcome: {
      terminal: view && view.status !== 'running'
        ? { status: view.status, errorMessage: view.errorMessage }
        : null,
      usage: run?.usage ?? {},
      stepCount: journal.readSteps(input.nodeId).length,
    },
    run, thrown, view, journal,
  };
}

// ── The real Workers AI model, with its fetch injected ────────────────────────

const ACCOUNT_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1';
const CAPTURE_MODEL_SPEC = 'workers-ai/@cf/moonshotai/kimi-k2.6';

/** One chat-completion request as it left the isolate. */
export interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: ChatCompletionBody;
}

/** The chat-completion payload, at the resolution the cache assertions read. */
const ChatCompletionBodySchema = v.object({
  messages: v.optional(v.array(v.looseObject({ role: v.optional(v.string()) }))),
  prompt_cache_key: v.optional(v.string()),
  promptCacheKey: v.optional(v.string()),
});
export type ChatCompletionBody = v.InferOutput<typeof ChatCompletionBodySchema>;

export interface CapturingModel {
  readonly model: LanguageModel;
  readonly captured: readonly CapturedRequest[];
}

/**
 * A REAL Workers AI `LanguageModel` whose only fake is `fetch`.
 *
 * This is the measurement seam for affinity, and it is the production path down to
 * the socket: `createAgentProviderRegistry` → `createWorkersAIProvider({
 * sessionAffinity })` → `createCloudflareAIFetch({ requestHeaders })` →
 * `createOpenAICompatible({ fetch })`. So the header and the request body are
 * OBSERVED, never derived from reading the wiring — which is the whole difference
 * between this and an inference.
 */
export function capturingWorkersAIModel(sessionAffinity?: string): CapturingModel {
  const captured: CapturedRequest[] = [];
  const registryOptions: Parameters<typeof createAgentProviderRegistry>[0] = {
    env: {},
    userDO: userCredentialSource({
      getAuthHeaders: async (key: string) =>
        key === 'cloudflare.oauth' ? { authorization: 'Bearer cf-user-token' } : null,
      listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
      getCredentialBaseURL: async (key: string) =>
        key === 'cloudflare.oauth' ? ACCOUNT_BASE_URL : null,
    }),
    fetch: asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: new Request(input).url,
        headers: new Headers(init?.headers),
        body: readChatCompletionBody(init?.body),
      });
      // Read off the RAW body, not the parsed one: `readChatCompletionBody` keeps only
      // the messages, so a parsed `stream` is always absent and every request would be
      // answered as a one-shot completion.
      return chatCompletionResponse(requestsStream(init?.body));
    }),
  };
  // Assigned rather than spread conditionally: absent means "this model is not
  // pinned", which is a distinct measured case, and a key holding `undefined` is not
  // the same fact as a key nobody set.
  if (sessionAffinity !== undefined) registryOptions.workersAI = { sessionAffinity };
  return { model: createAgentProviderRegistry(registryOptions).resolveModel(CAPTURE_MODEL_SPEC), captured };
}

/** Whether this request asked for a stream. `runChat` always does; a one-shot
 *  completion (a judge call, a title) does not. Parsed at the boundary and read as a
 *  domain value: the same `v.parse(v.string())` `readChatCompletionBody` uses, so a
 *  body the SDK stopped serialising as JSON fails loudly in one place rather than
 *  quietly reading as "not streaming" here. */
function requestsStream(body: RequestInit['body']): boolean {
  const parsed: unknown = JSON.parse(v.parse(v.string(), body));
  return v.safeParse(v.looseObject({ stream: v.literal(true) }), parsed).success;
}

/** The request body, parsed. A body that is not a JSON string would mean the SDK
 *  changed how it serialises a chat completion — a fact worth failing on rather than
 *  papering over with an empty object. */
function readChatCompletionBody(body: RequestInit['body']): ChatCompletionBody {
  const text = v.parse(v.string(), body);
  return v.parse(ChatCompletionBodySchema, JSON.parse(text));
}

/**
 * The canned answer, in whichever shape the request asked for.
 *
 * A streaming arm is not a convenience: every agent turn in this tree is issued by
 * `runChat`, which sets `stream: true`, so a helper that only answers a one-shot
 * completion measures a request no agent makes and reads back as an errored run. The
 * capture this helper exists for — the affinity header and the request body — is
 * identical either way, which is why one function serves both.
 */
function chatCompletionResponse(streaming: boolean): Response {
  if (streaming) return chatCompletionStream();
  return new Response(JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: '@cf/moonshotai/kimi-k2.6',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'Sort once instead of comparing every pair.' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }), { headers: { 'content-type': 'application/json' } });
}

/** The same answer as server-sent events, in the frame shape this account's
 *  OpenAI-compatible endpoint really sends (see unit-stream-usage-repair.test.ts,
 *  whose frames are captured from the wire): a content delta with an explicit null
 *  finish_reason, then a usage frame carrying the stop, then the sentinel. */
function chatCompletionStream(): Response {
  const head = '"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,'
    + '"model":"@cf/moonshotai/kimi-k2.6"';
  const delta = `data: {${head},"choices":[{"index":0,"delta":{"role":"assistant",`
    + '"content":"Sort once instead of comparing every pair."},"finish_reason":null}]}';
  const finish = `data: {${head},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],`
    + '"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}';
  return new Response(`${delta}\n\n${finish}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

// ── The two actor fixtures ────────────────────────────────────────────────────

/** What core's `setModel` answers: whether it took, and the normalised spec. */
export interface ModelSetResult {
  readonly ok: boolean;
  readonly spec: string;
}

/**
 * The slice of the real actor surface a turn observation needs, in Think's own
 * types — so a Think release that changes a hook signature fails here rather than
 * being absorbed by a hand-written approximation of it.
 */
export interface ActorTurnSurface {
  beforeTurn(ctx: TurnContext): Promise<TurnConfig | void>;
  beforeStep(ctx: PrepareStepContext): StepConfig | void;
  afterToolCall(ctx: ToolCallResultContext): Promise<void>;
  onChatResponse(result: ChatResponseResult): void | Promise<void>;
  observeRawTools(): ToolSet;
  /** The production model setter. The fixture wants its side effect — the actor now
   *  resolving that family — but the answer is declared so a Think/core signature
   *  change fails here rather than being absorbed. */
  setModel(spec: string): Promise<ModelSetResult>;
}

/**
 * The step config's two message-bearing fields.
 *
 * Think declares `beforeStep`'s return as `Omit<PrepareStepResult, 'model'>`, and
 * `PrepareStepResult` is a union that includes `undefined`, so the fields the hook
 * really carries are not readable off the declared type. Parsed instead of asserted:
 * the shape is checked once, here, and every reader below gets a domain value.
 */
const StepOutputSchema = v.object({
  system: v.optional(v.union([v.string(), v.looseObject({ content: v.unknown() })])),
  messages: v.optional(v.array(v.custom<ModelMessage>(() => true))),
});

/**
 * The request an actor kind's turn ISSUES — both hooks, in Think's order.
 *
 * `beforeTurn` alone is not the request. `TurnConfig.system` is string-typed, so a
 * marker-family cache plan cannot place its cache-eligible system there, and the
 * actor's own comment says the tail markers are rolled per step instead. Reading
 * only the turn hook therefore measures an actor with no cache controls at all and
 * would fabricate a three-kind agreement that does not exist. So the observation is
 * `beforeTurn` → `beforeStep`, which is what every request of the agentic loop is.
 */
export async function assembleActorTurn(
  agent: ActorTurnSurface,
  history: readonly ModelMessage[],
): Promise<TurnRequest> {
  const tools = agent.observeRawTools();
  const turn = await agent.beforeTurn({
    system: 'base', messages: [...history], tools,
    model: 'harness-model', continuation: false, body: {},
  });
  const turnMessages = turn?.messages ?? [...history];
  // The step context is CONSTRUCTED here with both fields `beforeStep` reads: it
  // forwards `stepNumber` and `messages` to `composePrepareStep` and touches no other
  // member of its context (actor-agent.ts `beforeStep`). Think supplies the remainder
  // for the SDK's own bookkeeping, which nothing here observes.
  // SAFETY: constructed literal carrying every member the callee reads.
  const stepContext = { stepNumber: 0, messages: [...turnMessages] } as PrepareStepContext;
  const step = v.parse(StepOutputSchema, agent.beforeStep(stepContext) ?? {});
  const carried = readSystemCarriage(step.system ?? turn?.system ?? '');
  return {
    system: carried.text,
    systemCarriage: carried.carriage,
    messages: (step.messages ?? turnMessages).map(modelMessage),
    toolNames: Object.keys(turn?.tools ?? tools),
    providerOptions: readRequestProviderOptions(turn?.providerOptions),
  };
}

/** How the system prompt rode, and its text. One decision, taken once, so no reader
 *  below has to re-derive it from the representation. */
export interface SystemPromptCarriage {
  readonly carriage: SystemCarriage;
  readonly text: string;
}

function readSystemCarriage(
  system: NonNullable<v.InferOutput<typeof StepOutputSchema>['system']>,
): SystemPromptCarriage {
  const asText = v.safeParse(v.string(), system);
  if (asText.success) return { carriage: 'text', text: asText.output };
  const asMessage = v.parse(v.looseObject({ content: v.unknown() }), system);
  const content = v.safeParse(v.string(), asMessage.content);
  return {
    carriage: 'cacheable-message',
    text: content.success ? content.output : JSON.stringify(asMessage.content),
  };
}

function modelMessage(message: ModelMessage): RequestMessage {
  const parts = v.safeParse(v.array(v.looseObject({ type: v.string() })), message.content);
  const text = v.safeParse(v.string(), message.content);
  return {
    role: message.role,
    providerOptions: message.providerOptions,
    partTypes: parts.success ? parts.output.map((part) => part.type) : [],
    text: text.success ? text.output : JSON.stringify(message.content),
  };
}

/**
 * A ready-made `execute_tools` entry that answers with `output`.
 *
 * Not a stub standing in for the tool surface: `preBuiltExecuteTool` is the dep the
 * CF backend itself supplies, because its codemode tool needs a construction shape
 * the core factory does not express. So a fixture handing one in is doing exactly
 * what a backend does, and the loop below it is unchanged.
 */
export function fixedExecuteTool(output: string): ToolSet[string] {
  return tool({
    description: 'Run a shell command in the workspace.',
    inputSchema: jsonSchema<{ command: string }>({
      type: 'object', required: ['command'], properties: { command: { type: 'string' } },
    }),
    execute: async () => output,
  });
}

// ── One fixture per kind ──────────────────────────────────────────────────────

/**
 * ONE AGENT KIND, DRIVABLE.
 *
 * Every member is exercised through the entry point that kind's own production code
 * owns for that capability — never through a re-implementation of its loop. So the
 * three fixtures differ in WHERE they reach production, and in nothing else; the
 * assertions above them are one set.
 */
export interface KindFixture {
  readonly kind: AgentKind;
  readonly differences: readonly Difference[];
  /** The request this kind's turn issues, over `history`. */
  request(history: readonly ModelMessage[]): Promise<TurnRequest>;
  /** The request this kind issues on the step AFTER a tool call settled — where a
   *  tool result has to appear, or the model never learns what its call returned. */
  requestAfterToolResult(result: ToolResultFixture): Promise<SettledToolObservation>;
  /** The tool names this kind's real composition put in front of the model. */
  toolSurface(): readonly string[];
  /**
   * Point this kind at a model family, and answer how it got there.
   *
   * `resolves-its-own` is an actor: it holds a stored spec and a registry, so a
   * family is a setting. `is-handed-one` is a node: the search resolves the model and
   * hands the object down, so a node cannot choose a family at all. A real difference,
   * reported rather than smoothed over, because it is why a per-family measurement
   * has to be taken differently for the two.
   */
  useModel(spec: string): Promise<'resolves-its-own' | 'is-handed-one'>;
  /** Whether this kind's composition wires a background job runner. */
  /** Whether this kind's composition really backgrounds a slow call. ASYNC because
   *  one kind can only be asked by DRIVING it: a node's runner is private to its loop,
   *  and a hardcoded verdict is a declaration that cannot go stale — which is exactly
   *  how this probe kept reading 'absent' after the gap closed. */
  background(): Promise<'wired' | 'absent'>;
  /**
   * What this kind's DURABLE transcript records for one settled tool call — the row a
   * human auditing the finished run reads, as distinct from what the model saw.
   */
  transcriptOfToolCall(result: ToolResultFixture): Promise<string>;
  /** The terminal record this kind writes for a turn that failed with `error`. */
  terminalOnFailure(error: Error): Promise<TerminalRecord>;
  /** The terminal record this kind writes for a turn its owner aborted. */
  terminalOnAbort(): Promise<TerminalRecord>;
  /** The kind's real production tool entry by name — the object a model call
   *  dispatches into, from the same surface `toolSurface()` names. */
  tool(name: string): ToolSet[string];
  /** The terminal record this kind writes for a turn that ran to completion. */
  terminalOnCompletion(): Promise<TerminalRecord>;
  /**
   * The kind's turn-loop seam: the orchestrator whose `turnExtension` carries
   * mechanical steering and the mid-turn signal drain, registered into the loop
   * by both backends. Null where the kind's loop has no such seam — a node's
   * loop is the search's, which is the declared C11 divergence.
   */
  turnLoopSeam(): AgentOrchestrator | null;
  /**
   * The kind's own background runner over its own durable job store, reachable
   * outside a turn. Null where the runner is private to the loop — a node's is
   * built inside `runNodeLoop`, whose wake path the end-to-end `background()`
   * drive observes instead.
   */
  backgroundSeam(): { runner: BackgroundJobRunner; store: BackgroundJobStore } | null;
  /**
   * Settle a job in the kind's own store, fire the kind's own runner wake with
   * a turn live, and return the readable text of the step the splice produced —
   * the observable half of the actor's wake seam. Null where the kind has no
   * out-of-loop runner; a node's wake is observed end to end by `background()`.
   */
  wakeIntoLiveTurn(jobId: string): Promise<string | null>;
}

/** The readable text of a step's messages, whatever shape each content took —
 *  what assertions read when they ask what the model was told. Parsed at this
 *  boundary the same way the steering object reads an ask
 *  (orchestrator/turn-steering.ts), so one content shape has one reader. */
export function textOfMessages(messages: readonly ModelMessage[] | undefined): string {
  return (messages ?? []).map((message) => {
    const flat = v.safeParse(v.string(), message.content);
    if (flat.success) return flat.output;
    const parts = v.safeParse(
      v.array(v.looseObject({ text: v.optional(v.string()) })),
      message.content,
    );
    return parts.success ? parts.output.map((part) => part.text ?? '').join('') : '';
  }).join('\n');
}

/** A tool call that already settled, as the next request must carry it. */
export interface ToolResultFixture {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: string;
}

/**
 * The request that followed a settled tool call, and the output that call really
 * produced.
 *
 * `producedOutput` is reported rather than assumed because the two kinds obtain it
 * differently and honestly: an actor's next-step request is assembled over a history
 * this fixture INJECTED the result into, so the output is the injected one; a node
 * really executes the tool and its own transcript records whatever came back — which
 * for a tool with no shell behind it is a failure text, and a failure text reaching
 * the model is the same capability as a success text reaching it. Asserting the
 * injected string for both would have made the node case measure the fixture.
 */
export interface SettledToolObservation {
  readonly request: TurnRequest;
  readonly producedOutput: string;
}

/** A terminal record, as a reader of whichever store this kind writes sees it. */
export interface TerminalRecord {
  readonly status: string;
  readonly errorMessage: string | null;
  /** Whether the kind's terminal-record entry point can receive an `Error` at all.
   *  A `string` boundary has already discarded the cause chain before our writer
   *  runs, so the two answers are different findings. */
  readonly acceptsError: boolean;
}

/** History carrying an already-settled tool call, in the SDK's own shape. */
export function historyWithToolResult(result: ToolResultFixture): readonly ModelMessage[] {
  return [
    { role: 'user', content: 'Name the cheapest change.' },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call', toolCallId: result.toolCallId, toolName: result.toolName,
        input: { command: 'wc -l reference.ts' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result', toolCallId: result.toolCallId, toolName: result.toolName,
        output: { type: 'text', value: result.output },
      }],
    },
  ];
}

/** The two actor kinds, whose only difference is which class the harness built. */
function actorFixture(
  kind: 'cf-orchestrator' | 'cf-subordinate',
  harness: ActorHarness<ActorTurnSurface>,
  differences: readonly Difference[],
): KindFixture {
  const { agent, db } = harness;
  return {
    kind, differences,
    request: (history) => assembleActorTurn(agent, history),
    requestAfterToolResult: async (result) => ({
      request: await assembleActorTurn(agent, historyWithToolResult(result)),
      producedOutput: result.output,
    }),
    toolSurface: () => Object.keys(agent.observeRawTools()),
    useModel: async (spec) => { await agent.setModel(spec); return 'resolves-its-own'; },
    transcriptOfToolCall: async (result) => {
      await openActorTurn(agent);
      // Think's own hook, with Think's own success shape. The accumulator behind it
      // is `TurnAccumulator.recordToolCall`, shared with the CLI, and its durable
      // row is the `tool_call_end` event read below.
      await agent.afterToolCall({
        type: 'tool-call',
        toolName: result.toolName, toolCallId: result.toolCallId,
        input: { command: 'wc -l reference.ts' },
        toolOutput: { type: 'tool-result', output: result.output },
        output: result.output, success: true,
        stepNumber: 0, messages: [], toolExecutionMs: 12, durationMs: 12,
      });
      return readToolCallEnd(db);
    },
    // Observed on the real instance rather than declared: the runner is a lazy
    // getter, so reading it is the same act production performs.
    background: async () => hasJobRunner(agent) ? 'wired' : 'absent',
    terminalOnFailure: async (error) => {
      await openActorTurn(agent);
      // Think's own field. `ChatResponseResult.error` is declared `string`, so the
      // best a caller could possibly hand this writer is the rendered chain — which
      // is what is handed here, so the measurement is of OUR writer and not of a
      // caller that under-supplies it.
      await agent.onChatResponse({
        status: 'error', error: renderCauseChain(error),
        requestId: 'req-fail', continuation: false,
        message: { id: 'assistant-fail', role: 'assistant', parts: [] },
      });
      return readRunEnd(db, false);
    },
    terminalOnAbort: async () => {
      await openActorTurn(agent);
      await agent.onChatResponse({
        status: 'aborted',
        requestId: 'req-abort', continuation: false,
        message: { id: 'assistant-abort', role: 'assistant', parts: [] },
      });
      return readRunEnd(db, false);
    },
    tool: (name) => {
      const entry = agent.observeRawTools()[name];
      if (!entry) throw new Error(`${kind}'s real surface holds no '${name}' tool`);
      return entry;
    },
    terminalOnCompletion: async () => {
      await openActorTurn(agent);
      // The success arm of the same settle spine the failure and abort arms
      // above ride: `run_end.reason` is `result.status`, so a completed turn
      // is recorded with the loop's own completed word.
      await agent.onChatResponse({
        status: 'completed',
        requestId: 'req-complete', continuation: false,
        message: { id: 'assistant-complete', role: 'assistant', parts: [] },
      });
      return readRunEnd(db, false);
    },
    turnLoopSeam: () => actorLoopSeam(agent),
    backgroundSeam: () => actorBackgroundSeam(agent),
    wakeIntoLiveTurn: async (jobId) => {
      const background = actorBackgroundSeam(agent);
      const orch = actorLoopSeam(agent);
      if (!background || !orch) return null;
      // The kind's OWN durable store, settled the way an executor settles it.
      background.store.create({ id: jobId, kind: 'execute_tools', workMode: 'build', now: Date.now() });
      background.store.settle(jobId, background.store.epochOf(jobId) ?? 0, 'exit 0', Date.now());
      // A wake splices only into a LIVE turn; with no turn in flight the actor's
      // delivery becomes a durable queued turn instead (the other half of the
      // same seam, reached through Think's saveMessages and not drivable outside
      // workerd). Hold the in-flight state a live turn has — read through a
      // validated probe, exactly like every other protected seam here — so the
      // delivery takes the splice half this harness can observe.
      const live = v.safeParse(v.looseObject({ _inFlight: v.boolean() }), agent);
      if (!live.success) throw new Error('the actor exposes no in-flight flag');
      // The parse CLONES, so its output only proves the field exists and is a
      // flag; the write goes to the instance itself, which is what the host
      // closure reads.
      Reflect.set(agent, '_inFlight', true);
      try {
        await background.runner.wake(jobId);
        const spliced = orch.turnExtension.prepareStep?.({
          stepNumber: 1, messages: [{ role: 'user', content: 'waiting on that job' }],
        });
        return textOfMessages(spliced);
      } finally {
        Reflect.set(agent, '_inFlight', false);
      }
    },
  };
}

/** Open a run the way a turn does — `beforeTurn` mints the run id every later
 *  record is written under, so a settle with no turn in front of it writes nothing. */
async function openActorTurn(agent: ActorTurnSurface): Promise<void> {
  await agent.beforeTurn({
    system: 'base', messages: [{ role: 'user', content: 'do the thing' }],
    tools: agent.observeRawTools(), model: 'harness-model', continuation: false, body: {},
  });
}

/**
 * The actor's REAL turn-loop seam, reached through the protected getter the
 * loop itself reads — the same act production performs on its first turn. Null
 * would mean an actor whose loop has no orchestrator: the C11 steering wiring
 * gone missing, not a fixture state.
 */
function actorLoopSeam(agent: ActorTurnSurface): AgentOrchestrator | null {
  const probe = v.safeParse(v.looseObject({ orch: v.instance(AgentOrchestrator) }), agent);
  return probe.success ? probe.output.orch : null;
}

/** The actor's own background runner over its own durable job store, through
 *  the same protected getters the tool wrapper and the cancel RPC read. */
function actorBackgroundSeam(
  agent: ActorTurnSurface,
): { runner: BackgroundJobRunner; store: BackgroundJobStore } | null {
  const probe = v.safeParse(
    v.looseObject({
      jobRunner: v.instance(BackgroundJobRunner),
      jobs: v.instance(BackgroundJobStore),
    }),
    agent,
  );
  return probe.success ? { runner: probe.output.jobRunner, store: probe.output.jobs } : null;
}
/** Whether this actor really constructed a background job runner. Reached through
 *  the protected getter the tool wrapper reads, which is the only honest question:
 *  a runner nothing can reach is a runner that does not exist. */
function hasJobRunner(agent: ActorTurnSurface): boolean {
  const probe = v.safeParse(v.looseObject({ jobRunner: v.unknown() }), agent);
  return probe.success && probe.output.jobRunner !== undefined;
}

const RunEventRowSchema = v.object({ type: v.string(), payload: v.string() });
const RunEndPayloadSchema = v.looseObject({
  reason: v.optional(v.string()),
  error: v.optional(v.string()),
});

/** The `run_end` event the settle spine wrote — the actor kinds' terminal record. */
function readRunEnd(db: Database, acceptsError: boolean): TerminalRecord {
  const rows = v.parse(
    v.array(RunEventRowSchema),
    db.prepare('SELECT type, payload FROM run_events WHERE type = ? ORDER BY event_index DESC')
      .all('run_end'),
  );
  const latest = rows[0];
  if (!latest) return { status: 'no-record', errorMessage: null, acceptsError };
  const payload = v.parse(RunEndPayloadSchema, JSON.parse(latest.payload));
  return {
    status: payload.reason ?? 'no-reason',
    errorMessage: payload.error ?? null,
    acceptsError,
  };
}

const ToolCallEndPayloadSchema = v.looseObject({
  name: v.string(),
  result: v.optional(v.unknown()),
  error: v.optional(v.string()),
});

/** What the `tool_call_end` event recorded for the newest settled call. */
function readToolCallEnd(db: Database): string {
  const rows = v.parse(
    v.array(RunEventRowSchema),
    db.prepare('SELECT type, payload FROM run_events WHERE type = ? ORDER BY event_index DESC')
      .all('tool_call_end'),
  );
  const latest = rows[0];
  if (!latest) return '';
  const payload = v.parse(ToolCallEndPayloadSchema, JSON.parse(latest.payload));
  return JSON.stringify(payload.result ?? payload.error ?? null);
}

/**
 * An `execute_tools` entry whose work outlives the detach threshold and then settles
 * on its own.
 *
 * Self-settling rather than released by the test, because the observation is of the
 * WHOLE run: the call has to cross the threshold (so it detaches) and then finish (so
 * the wake has something to deliver). 120 ms against a 40 ms threshold is three times
 * the bound, which is the smallest honest margin — a value below it would be measuring
 * the scheduler.
 */
export function selfSettlingTool(): NodeAgentDeps['executeTool'] {
  return tool({
    description: 'Run a command in the sandbox.',
    inputSchema: jsonSchema<{ command: string }>({
      type: 'object', required: ['command'], properties: { command: { type: 'string' } },
    }),
    execute: async ({ command }) => {
      await new Promise((settle) => { setTimeout(settle, 120); });
      return `${command}: exit 0`;
    },
  });
}

/** The swarm node, driven end to end through `runNodeAgent`. */
function nodeKindFixture(differences: readonly Difference[]): KindFixture {
  const firstRequestOf = async (script: ScriptedTurn, opts?: NodeFixtureOptions) => {
    const drive = await driveNode(script, opts);
    const first = drive.requests[0];
    if (!first) throw new Error('the node issued no provider request');
    return first;
  };
  // The node's REAL tool surface, built the way `runNodeLoop` builds it:
  // `buildBuiltinTools` over a runtime, filtered by the confined set with the
  // SAME `keepBuiltins` production calls. The report dep answers received —
  // no assertion here drives a report through this surface.
  let surface: ToolSet | null = null;
  const nodeSurface = (): ToolSet => {
    if (!surface) {
      const { rt } = createTestRuntime();
      surface = keepBuiltins(buildBuiltinTools({
        rt,
        logger: createRecordingLogger(),
        report: { report: async () => ({ received: true }) },
      }), NODE_BUILTIN_TOOLS);
    }
    return surface;
  };
  return {
    kind: 'swarm-node', differences,
    request: (history) => firstRequestOf(
      { steps: [{ text: 'Sort once.' }] },
      { messages: history },
    ),
    requestAfterToolResult: async (result) => {
      // A node's own second request is the one that carries the result, and it carries
      // it because the loop appended it — so the observation is of the SECOND call, not
      // of a history handed in. That is the real question for every kind: does the model
      // see what its own call returned.
      const drive = await driveNode(
        {
          steps: [
            { toolCall: { name: 'execute_tools', input: { command: 'wc -l reference.ts' } } },
            { text: 'Sort once.' },
          ],
        },
        { executeTool: fixedExecuteTool(result.output) },
      );
      const second = drive.requests[1];
      if (!second) {
        throw new Error(
          `the node took ${String(drive.requests.length)} provider calls, so no request followed its tool call`,
        );
      }
      return { request: second, producedOutput: result.output };
    },
    toolSurface: () => [...NODE_BUILTIN_TOOLS],
    // Nothing to set: `NodeAgentDeps.model` is a resolved object the search built,
    // and the node has no registry of its own to normalise a spec against.
    useModel: async () => 'is-handed-one',
    transcriptOfToolCall: async (result) => {
      const drive = await driveNode(
        {
          steps: [
            { toolCall: { name: 'execute_tools', input: { command: 'wc -l reference.ts' } } },
            { text: 'Sort once.' },
          ],
        },
        { executeTool: fixedExecuteTool(result.output) },
      );
      const recorded = drive.run?.report.toolCalls.find((call) => call.name === 'execute_tools');
      if (!recorded) throw new Error('the node transcript recorded no execute_tools call');
      return JSON.stringify(recorded.result);
    },
    // OBSERVED by DRIVING a node against a tool that outlives a sub-second detach
    // threshold. One observation answers C4 and C5 together, which is the pairing the
    // suite insists on: the recorded output being a BackgroundHandle proves a runner
    // exists and the threshold fired, and the run REACHING a terminal report proves the
    // settled job woke the node into a second turn. Neither is assertable from a
    // constant.
    background: async () => {
      const slow = selfSettlingTool();
      const drive = await driveNode(
        {
          steps: [
            { toolCall: { name: 'execute_tools', input: { command: 'sleep' } } },
            { text: 'Launched it; waiting on the result.' },
          ],
        },
        {
          executeTool: slow,
          backgroundPolicy: () => ({ detachAfterMs: 40, settleGraceMs: 400, wakesAfterTurn: true }),
        },
      );
      const call = drive.run?.report.toolCalls.find((entry) => entry.name === 'execute_tools');
      return isBackgroundHandle(call?.result) && drive.outcome.terminal !== null
        ? 'wired'
        : 'absent';
    },
    terminalOnFailure: async (error) => {
      const drive = await driveNode({
        steps: [{ text: 'unreachable' }],
        throwAt: { call: 0, error },
      });
      return nodeTerminal(drive, true);
    },
    terminalOnAbort: async () => {
      const controller = new AbortController();
      controller.abort();
      const drive = await driveNode({ signal: controller.signal, steps: [{ text: 'Sort once.' }] });
      return nodeTerminal(drive, true);
    },
    tool: (name) => {
      const entry = nodeSurface()[name];
      if (!entry) throw new Error(`the node's real surface holds no '${name}' tool`);
      return entry;
    },
    terminalOnCompletion: async () => {
      const drive = await driveNode({ steps: [{ text: 'Sort once.' }] });
      return nodeTerminal(drive, true);
    },
    // Declared, not absent-by-accident: a node's loop has no orchestrator and
    // no runner reachable outside it. The steering divergence is C11's node
    // case; the wake path is observed end to end by `background()` above.
    turnLoopSeam: () => null,
    backgroundSeam: () => null,
    wakeIntoLiveTurn: async () => null,
  };
}

function nodeTerminal(drive: NodeDrive, acceptsError: boolean): TerminalRecord {
  const terminal = drive.outcome.terminal;
  if (!terminal) return { status: 'no-record', errorMessage: null, acceptsError };
  return { status: terminal.status, errorMessage: terminal.errorMessage, acceptsError };
}

/**
 * The three fixtures, built fresh per call so no assertion inherits another's state.
 *
 * `differences` is supplied by the suite rather than baked in here, because the
 * declarations are the suite's own claims about what it found and belong next to the
 * assertions that observe them.
 */
export function kindFixtures(
  differences: Readonly<Record<AgentKind, readonly Difference[]>>,
): readonly KindFixture[] {
  const orchestrator = orchestratorHarness();
  orchestrator.agent.setObservedSoul('# SOUL\nA workspace root under test.');
  orchestrator.agent.declareScaffoldPresent();
  const subordinate = subordinateHarness();
  subordinate.agent.declareScaffoldPresent();
  return [
    actorFixture('cf-orchestrator', orchestrator, differences['cf-orchestrator']),
    actorFixture('cf-subordinate', subordinate, differences['cf-subordinate']),
    nodeKindFixture(differences['swarm-node']),
  ];
}
