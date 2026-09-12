/**
 * The two-turn probe worker — the REAL OrchestratorAgent driven through two
 * full Think turns against a model service that is this worker's own
 * WorkerEntrypoint.
 *
 * THE SEAM. `createAgentProviderRegistry` binds `env.AI` as the development
 * Workers AI binding whenever `env.DEV_USER_EMAIL` is also set
 * (agent-registry.ts:117-123), and `createWorkersAIProvider` then builds the
 * REAL openai-compatible model over `createDirectWorkersAIFetch(binding)`
 * (workers-ai.ts:44-49). That adapter calls one method —
 * `binding.run(model, inputs, { signal, returnRawResponse: true })`
 * (direct-workers-ai-fetch.ts:159) — so an entrypoint named `AI` on a service
 * binding IS the external inference plane, and no production flag exists.
 * `FakeAI` answers one native-dialect SSE frame (`{response: "echo:<text>"}`)
 * plus `data: [DONE]`, which `openAIChunkTransform` translates into the
 * chat.completion.chunk stream the AI SDK consumes
 * (direct-workers-ai-fetch.ts:282-338,358-534).
 *
 * WHY THIS FILE EXISTS. Two shipped defects are observable only over a real
 * OrchestratorAgent running two turns end to end with the real Think session
 * store: the pane-COUNT read of `assistant_messages` naming a column the SDK
 * never creates (2026-09-08), and the second turn's model request dropping
 * the message that started it (2026-09-08). Every bun suite seeds history
 * itself; the earlier workerd claim that a full turn cannot be hosted here is
 * stale — CompiledWasm modules and `workerLoaders` are wired for the sibling
 * probes in vitest.config.ts.
 *
 * THE SPIKES the test file drives before asserting anything:
 *  1. `signalProbe` — whether an `AbortSignal` survives the service-binding
 *     RPC into `run`'s options (the adapter passes it unconditionally).
 *  2. `claimOwner` + `getWorkspaceSnapshot` — whether the hosted workspace
 *     plane (nimbus session behind the workspace VFS) boots under the pool.
 */
import { Agent, getAgentByName } from 'agents';
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import type { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import type { UserDO } from '../../src/user/user-do';
import { ownerCaller } from '../../src/user/workspace-capability';

// Re-exported under their production names so the auxiliary worker's
// durableObjects bind the classes themselves — the same mechanism
// slate-actor-probe.ts:43-48 uses, for the same reason: a probe that retargets
// the class measures its own fixture, not the shipped surface.
export { UserDO } from '../../src/user/user-do';

export { OrchestratorAgent } from '../../src/orchestrator';

/** The request shape `bindingInputs` hands the binding (direct-workers-ai-
 *  fetch.ts:209-227): the chat body minus `model`, messages whose `content`
 *  is a string or an array of parts. Parsed rather than trusted. */
const TextPartSchema = v.object({ type: v.literal('text'), text: v.string() });

const MessageContentSchema = v.union([v.string(), v.array(v.unknown())]);

type MessageContent = v.InferOutput<typeof MessageContentSchema>;

const RunInputsSchema = v.object({
  messages: v.optional(v.array(v.object({
    role: v.optional(v.string()),
    content: v.optional(v.unknown()),
  }))),
  stream: v.optional(v.boolean()),
});

type RunInputs = v.InferOutput<typeof RunInputsSchema>;

/** `options` as the adapter builds it; `signal` stays `unknown` because what
 *  it arrives as IS the spike's measurement. */
interface RunOptions {
  readonly signal?: unknown;
  readonly returnRawResponse?: boolean;
  readonly extraHeaders?: Record<string, string>;
}

/** The one method the adapter calls, typed the way it types it. */
interface AIRunner {
  run(model: string, inputs: RunInputs, options?: RunOptions): Promise<Response | ReadableStream<Uint8Array> | object>;
}

interface RecordedCall {
  readonly model: string;
  /** Every `role === 'user'` message text in request order. */
  readonly users: readonly string[];
  /** What `options.signal` arrived as — the spike's answer. */
  readonly signalKind: string;
  /** Whether the request asked to stream — the turn calls, separated from the
   *  non-turn lanes (fact compression, reflections) the same binding serves. */
  readonly stream: boolean;
}

/** The whole log for this isolate; the test reads it through the probe root. */
const recordedCalls: RecordedCall[] = [];

/** The model's side of `messages[].content`, schema-narrowed at the boundary. */
function messageText(content: MessageContent): string {
  return v.is(v.string(), content)
    ? content
    : content.flatMap((part) => {
      const text = v.safeParse(TextPartSchema, part);

      return text.success ? [text.output.text] : [];
    }).join('');
}

/** The kind token the test asserts on for the signal argument: a live
 *  AbortSignal, the absent markers, or `foreign` for whatever the marshalling
 *  produced instead. Computed inline in `run` — the classification IS the
 *  read; there is no narrower type to hand a helper. */
export class FakeAI extends WorkerEntrypoint {
  /** The one method `createDirectWorkersAIFetch` calls on the binding. */
  async run(model: string, inputs: RunInputs, options?: RunOptions): Promise<Response> {
    const signal = options?.signal;

    const signalKind =
      signal === undefined ? 'undefined'
      : signal === null ? 'null'
      : signal instanceof AbortSignal ? 'AbortSignal'
      : 'foreign';

    const users = (v.parse(RunInputsSchema, inputs).messages ?? [])
      .filter((m) => m.role === 'user')
      .map((m) => messageText(v.parse(MessageContentSchema, m.content ?? '')));

    const stream = (v.parse(RunInputsSchema, inputs).stream ?? false) === true;

    recordedCalls.push({ model, users, signalKind, stream });
    // The prompt appends harness-side user messages after the typed text —
    // the `<dynamic_context>` block and signal splices — so the echo answers
    // the last TYPED line, the one a dropped-message defect loses.
    const text = users.filter((u) => !u.startsWith('<')).at(-1) ?? '';

    if (!stream) {
      // Non-turn lanes (fact compression, reflections) ask for a whole
      // completion: a native `{"response": ...}` object is the answer the
      // adapter's `completedResponse` wraps, and handing them the stream
      // spelling is what made compression read `data: {` as JSON above.
      return Response.json({ response: `echo:${text}`, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } });
    }

    const encoder = new TextEncoder();

    const frames = [
      `data: ${JSON.stringify({ response: `echo:${text}`, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } })}\n\n`,
      'data: [DONE]\n\n',
    ];

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));

          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

export class TwoTurnProbeRoot extends Agent<ProbeEnv> {
  /** Spike 1: does an AbortSignal cross the service binding into `run`?
   *  Returns the kind FakeAI recorded, or the throw's message — the caller
   *  cannot distinguish "no signal" from a serialization failure otherwise. */
  async signalProbe(): Promise<{ signalKind: string } | { threw: string }> {
    try {
      // SAFETY: the vitest config declares `env.AI` as this worker's service
      // binding to `FakeAI`, whose entrypoint contract provides `run` — the
      // member AIRunner names and the only member the adapter calls.
      const binding: AIRunner | undefined = this.env.AI as AIRunner | undefined;
      const controller = new AbortController();

      await binding?.run('probe', { messages: [] }, { signal: controller.signal, returnRawResponse: true });

      return { signalKind: recordedCalls.at(-1)?.signalKind ?? 'no-call-recorded' };
    } catch (cause) {
      return { threw: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** The recorded model requests, in order. */
  calls(): RecordedCall[] {
    return recordedCalls;
  }

  async exercise(): Promise<{
    register: object;
    claim: object;
    model: object;
    turnA: object;
    turnB: object;
    snapshot: object;
    history: object;
    calls: RecordedCall[];
  }> {
    const raw: Pick<Fetcher, 'fetch'> = await getAgentByName<ProbeEnv, ProductionOrchestrator>(
      this.env.OrchestratorAgent, 'two-turn-workspace',
    );

    // SAFETY: `getAgentByName` constructed the stub over the `OrchestratorAgent`
    // binding, and every picked name is a method the production class declares
    // and `ORCHESTRATOR_RPC_SURFACE` lists, so the narrowed calls resolve.
    const target = raw as Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator,
      'claimOwner' | 'setModel' | 'runTaskFromMcp' | 'getWorkspaceSnapshot' | 'getChatHistoryPage'>;

    // The production workspace-create sequence: the owner registers the name,
    // the workspace claims its owner, and the UserDO mints the capability
    // token `userCaller()` needs for the registry reads a turn performs
    // (title hydration, release board, credential listing).
    const caller = await ownerCaller(this.env);

    // SAFETY: `env.UserDO` declares the real `UserDO` class in this worker's
    // durableObjects, so the stub carries the registry methods the owner
    // caller tier admits.
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName('probe-owner')) as
      DurableObjectStub & Pick<UserDO, 'registerWorkspace' | 'ensureWorkspaceCapability'>;

    const register = await userDO.registerWorkspace(caller, 'two-turn-workspace', 'Two-Turn Probe');
    const claim = await target.claimOwner('probe-owner');
    await userDO.ensureWorkspaceCapability('two-turn-workspace', claim.capabilityHash);

    const model = await target.setModel('workers-ai/@cf/qwen/qwen3-30b-a3b-fp8');
    const turnA = await target.runTaskFromMcp('A');
    const turnB = await target.runTaskFromMcp('B');
    const snapshot = await target.getWorkspaceSnapshot();
    const history = await target.getChatHistoryPage({});

    return { register, claim, model, turnA, turnB, snapshot, history, calls: recordedCalls };
  }
}
