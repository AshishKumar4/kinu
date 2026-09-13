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
 *
 * EVERY LANE, not just the turn. Three product call sites reach this binding
 * during the probe, and the fake answers each from that lane's own contract —
 * keyed on the request SHAPE (the stream flag, the leading system role),
 * never on prompt text:
 *  - the turn (`streamText`): `inputs.stream === true` with `messages`.
 *    Answered with one native-dialect SSE frame (`{response: "echo:<text>"}`)
 *    plus `data: [DONE]`, which `openAIChunkTransform` translates into the
 *    chat.completion.chunk stream the AI SDK consumes
 *    (direct-workers-ai-fetch.ts:282-338,358-534). The echo answers the last
 *    TYPED user line: the real prompt appends harness-side user rows after it
 *    (the `<dynamic_context>` block), and the dropped-message defect loses
 *    exactly the typed line.
 *  - the sleep-time judge (`generateText`, user-only messages):
 *    orchestrator.ts:2698 `runSleepTimeCompute` hands the answer to core's
 *    `extractJsonObject` + `SleepTimeUpdateSchema` (sleep-time-compute.ts),
 *    and null keeps the terminal row owed forever. Answered with a
 *    `v.parse` of the imported schema — the empty update, which is the
 *    model's honest "nothing to remember".
 *  - the title suggest (`generateText` with a system half):
 *    actor-agent.ts:5597 `suggestTitle` hands the answer to core's
 *    `parseWorkspaceTitle` (naming.ts:365, `{title}` JSON). Answered with a
 *    title JSON that is gated through that same parse at build time — the
 *    lane's own reader admits the fake's answer, or the fake throws.
 *  Anything else throws a named error: an unrecognized shape is a lane the
 *  probe does not satisfy, which is a product finding, not a gap to paper
 *  over with an echo.
 *
 * THE SETTLE. `terminal.settle` hands the close to a detached durable fiber
 * (`holdTerminalClose`), so the turn-driving RPC returns before the terminal
 * effects land. The probe joins the product's own evidence instead of the
 * fiber: after each turn it polls the installed recording sink until that
 * turn's `memory.facts_compressed` event arrives — the sleep-time effect's
 * completion record — then, after the second turn, waits for log quiescence
 * and asserts the captured log holds zero failures and zero
 * `turn.terminal_effects_owed` events. `end()` emits the owed event exactly
 * when a close finishes with effects still owed (terminal-transition.ts), so
 * its absence after quiescence is the close finishing clean, and the worker
 * exiting with no "hung" exceptions is the same fact from the runtime side.
 *
 * WHY THIS FILE EXISTS. Two shipped defects are observable only over a real
 * OrchestratorAgent running two turns end to end with the real Think session
 * store: the pane-COUNT read of `assistant_messages` naming a column the SDK
 * never creates (2026-09-08), and the second turn's model request dropping
 * the message that started it (2026-09-08). Every bun suite seeds history
 * itself; the earlier workerd claim that a full turn cannot be hosted here is
 * stale — CompiledWasm modules and `workerLoaders` are wired for the sibling
 * probes in vitest.config.ts.
 */
import { Agent, getAgentByName } from 'agents';
import { subscribe } from 'agents/observability';
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  SleepTimeUpdateSchema,
  parseWorkspaceTitle,
} from '@kinu.run/core';
import {
  createCompositeLogger,
  createConsoleLogger,
  createRecordingLogger,
  setDiagnosticsSink,
  type RecordingLogger,
} from '@kinu.run/core/obs';
import type { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import type {
  CallRecord,
  DriveOnceInput,
  DriveOnceResult,
  ExerciseResult,
  HttpCall,
} from './two-turn-shapes';
import {
  DriveOnceInputSchema,
  DriveOnceResultSchema,
  ExerciseResultSchema,
  HttpCallSchema,
} from './two-turn-shapes';
import type { UserDO } from '../../src/user/user-do';
import { ownerCaller } from '@kinu.run/core';

// Re-exported under their production names so the auxiliary worker's
// durableObjects bind the classes themselves — the same mechanism
// slate-actor-probe.ts:43-48 uses, for the same reason: a probe that retargets
// the class measures its own fixture, not the shipped surface.
export { UserDO } from '../../src/user/user-do';

export { OrchestratorAgent } from '../../src/orchestrator';

/** The request shape `bindingInputs` hands the binding (direct-workers-ai-
 *  fetch.ts:209-227): the openai-compatible body minus `model`, with `stream`
 *  always set. The layer normalizes every call to `messages` first, so a turn
 *  carries `stream: true` and the completion lanes `stream: false` with a
 *  leading system message (title) or user-only messages (sleep). */
const TextPartSchema = v.object({ type: v.literal('text'), text: v.string() });

const MessageContentSchema = v.union([v.string(), v.array(v.unknown())]);

type MessageContent = v.InferOutput<typeof MessageContentSchema>;

const RunInputsSchema = v.object({
  messages: v.optional(v.array(v.object({
    role: v.optional(v.string()),
    content: v.optional(v.unknown()),
  }))),
  prompt: v.optional(v.unknown()),
  system: v.optional(v.unknown()),
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


/** The whole call log for this isolate; the test reads it through the root. */
const recordedCalls: CallRecord[] = [];

/** The model's side of `messages[].content`, schema-narrowed at the boundary. */
function messageText(content: MessageContent): string {
  return v.is(v.string(), content)
    ? content
    : content.flatMap((part) => {
      const text = v.safeParse(TextPartSchema, part);

      return text.success ? [text.output.text] : [];
    }).join('');
}

/** The empty sleep-time update, parsed against the lane's own imported schema
 *  — the model's honest "nothing to remember", which the judge accepts and
 *  the tombstone records. */
function sleepTimeAnswer(): string {
  return JSON.stringify(v.parse(SleepTimeUpdateSchema, { upserts: [], decay: [] }));
}

/** The title suggestion, admitted by the lane's own reader before it is ever
 *  served: `parseWorkspaceTitle` returning null is the fake failing its own
 *  build, loudly, rather than the lane failing the turn. */
function titleAnswer(): string {
  const answer = JSON.stringify({ title: 'Two Turn Probe' });

  if (parseWorkspaceTitle(answer) === null) {
    throw new Error('FakeAI: built a title answer the product title parse rejects');
  }

  return answer;
}

export class FakeAI extends WorkerEntrypoint {
  /** The one method `createDirectWorkersAIFetch` calls on the binding. */
  async run(model: string, inputs: RunInputs, options?: RunOptions): Promise<Response> {
    const signal = options?.signal;

    const signalKind =
      signal === undefined ? 'undefined'
      : signal === null ? 'null'
      : signal instanceof AbortSignal ? 'AbortSignal'
      : 'foreign';

    const parsed = v.parse(RunInputsSchema, inputs);
    const stream = parsed.stream ?? false;
    const messages = parsed.messages ?? [];

    // The turn now travels the HTTP seam (pinned `openai-compat/probe`), so
    // the only streamed calls that still reach this binding are the probe's
    // own `signalProbe` — answered by the turn lane below. The lifecycle
    // variants (early-DONE, pending) moved to the HTTP fake with the turns
    // that drive them; their RPC arms and red tests are evidence in the run
    // logs, not permanent residents here.
    const users = messages
      .filter((m) => m.role === 'user')
      .map((m) => messageText(v.parse(MessageContentSchema, m.content ?? '')));
    // The lane key. The openai-compatible layer normalizes every call to
    // `messages` before the binding (a `prompt` string never arrives as one),
    // so the turn is `stream: true` and every completion lane is `stream:
    // false`; among completions the title lane's leading system message —
    // `suggestTitle` passes the system half separately
    // (actor-agent.ts:5609-5615) — separates it from the sleep judge's
    // user-only messages (orchestrator.ts:2698). Roles, never text.

    const lane = stream ? 'turn' : messages[0]?.role === 'system' ? 'title' : 'sleep';

    recordedCalls.push({ model, users, signalKind, stream, lane });

    if (lane === 'turn') {
      // The echo answers the last TYPED line — harness-side user rows
      // (`<dynamic_context>` and friends) ride after it. A single buffered
      // body rather than a custom ReadableStream: `streamedResponse` needs a
      // body to forward (`direct-workers-ai-fetch.ts:253`), and a constructed
      // string body keeps the pipe lifecycle entirely on workerd's side.

      const text = users.filter((u) => !u.startsWith('<')).at(-1) ?? '';

      const body =
        `data: ${JSON.stringify({ response: `echo:${text}`, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } })}\n\n`
        + 'data: [DONE]\n\n';

      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }

    if (lane === 'title') {
      return Response.json({ response: titleAnswer() });
    }

    if (lane === 'sleep' && messages.length > 0) {
      return Response.json({ response: sleepTimeAnswer() });
    }

    throw new Error(
      `FakeAI: unrecognized non-stream request shape (keys: ${Object.keys(parsed).join(',')}) — `
      + 'a lane the probe does not satisfy; extend the fake or report the lane',
    );
}
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

type QueueTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator,
  'claimOwner' | 'setModel' | 'setSoul' | 'beginGenesisTurn' | 'receivePeerMessage'>;

const SocketHistorySchema = v.array(v.object({ id: v.string(), role: v.string() }));

/** The drive result shapes live in `./two-turn-shapes` — same schemas, same
 *  InferOutput types, but importable from the workerd typecheck project,
 *  which excludes this file for importing production `src` (see the
 *  `//exclude` note in this directory's tsconfig). */

/** Bounded join on the product's own completion evidence: one
 *  `memory.facts_compressed` per settled sleep-time effect. Throws naming the
 *  missing evidence rather than hanging the suite. */
async function awaitFactsCompressed(
  recording: RecordingLogger,
  count: number,
): Promise<void> {
  const started = Date.now();

  for (;;) {
    const seen = recording.emitted.filter((e) => e.event === 'memory.facts_compressed').length;

    if (seen >= count) return;

    if (Date.now() - started > 20000) {
      throw new Error(
        `two-turn probe: ${String(count)} facts_compressed events never arrived `
        + `(saw ${String(seen)}); the terminal close did not finish`,
      );
    }

    const tick = Promise.withResolvers<void>();

    setTimeout(tick.resolve, 50);
    await tick.promise;
  }
}

/** Bounded quiescence: the isolate is quiet when no diagnostic line lands for
 *  a full second. The close's `end()` emits the owed event synchronously, so
 *  a quiet log with no owed event is a close that finished clean. */
async function awaitQuiet(recording: RecordingLogger): Promise<void> {
  const started = Date.now();
  let seen = recording.emitted.length;
  let silentSince = Date.now();

  for (;;) {
    const tick = Promise.withResolvers<void>();

    setTimeout(tick.resolve, 50);
    await tick.promise;

    const now = Date.now();

    if (recording.emitted.length !== seen) {
      seen = recording.emitted.length;
      silentSince = now;
    } else if (now - silentSince >= 1000) {
      return;
    }

    if (now - started > 15000) {
      throw new Error('two-turn probe: log never went quiet; work is still detached at exit');
    }
  }
}

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

      await binding?.run(
        'probe',
        { messages: [], stream: true },
        { signal: controller.signal, returnRawResponse: true },
      );

      // The probe's own call never came from the product; it leaves the log
      // it only entered to measure the marshalling.
      const recorded = recordedCalls.pop();

      return { signalKind: recorded?.signalKind ?? 'no-call-recorded' };
    } catch (cause) {
      return { threw: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** The recorded model requests, in order. */
  calls(): CallRecord[] {
    return recordedCalls;
  }

  /** The real drive: claim, pin the model, two turns each joined on its own
   *  terminal settle, snapshot, history, and the captured log's verdict. */
  async exercise(): Promise<ExerciseResult> {
    // The documented test seam (obs/log.ts): record AND keep console output.
    // Captured AFTER warmup, before every turn: each DO constructor installs
    // the analytics sink on first stub use (actor-agent.ts:1453-1462), which
    // REPLACES whatever sink exists — an install at the top of this method
    // would be clobbered by the very constructors the drive warms. Past
    // construction nothing reinstalls (install.ts:309, same env), so a capture
    // before each turn owns the sink for that turn and its detached close.
    // The analytics rows the capture displaces go nowhere in this pool; the
    // console half keeps every line visible.
    const recording = createRecordingLogger();

    const capture = (): (() => void) => setDiagnosticsSink(
      createCompositeLogger([createConsoleLogger(), recording]),
    );

    let restore: () => void = () => {};

    try {
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
        DurableObjectStub & Pick<UserDO, 'registerWorkspace' | 'ensureWorkspaceCapability' | 'setCredential'>;

      const register = await userDO.registerWorkspace(caller, 'two-turn-workspace', 'Two-Turn Probe');
      const claim = await target.claimOwner('probe-owner');

      await userDO.ensureWorkspaceCapability('two-turn-workspace', claim.capabilityHash);

      // The HTTP seam's credential: the static openai-compat provider resolves
      // its baseURL from this stored key (never models.dev), and the global
      // fetch the agent falls back to reaches the Node-side fake through this
      // worker's outboundService. Fixture values only — the wire assertions
      // below prove they arrive.
      await userDO.setCredential(caller, 'openai-compat.default', {
        kind: 'openai-compat',
        baseURL: 'http://fake-models.invalid/v1',
        apiKey: 'probe-fixture-key',
      });
      await this.httpReset();

      const model = await target.setModel('openai-compat/probe');
      restore = capture();
      const turnA = await target.runTaskFromMcp('A');

      if (turnA.status !== 'queued') {
        throw new Error(`two-turn probe: turn A skipped at enqueue: ${JSON.stringify(turnA)}`);
      }

      await awaitFactsCompressed(recording, 1);

      restore = capture();
      const turnB = await target.runTaskFromMcp('B');

      if (turnB.status !== 'queued') {
        throw new Error(`two-turn probe: turn B skipped at enqueue: ${JSON.stringify(turnB)}`);
      }

      await awaitFactsCompressed(recording, 2);
      await awaitQuiet(recording);

      const snapshot = await target.getWorkspaceSnapshot();
      const history = await target.getChatHistoryPage({});

      // Parsed at the boundary: the wire carries exactly these shapes, so the
      // RPC declaration (InferOutput below) can never drift from them.
      return v.parse(ExerciseResultSchema, {
        register, claim, model, turnA, turnB, snapshot, history,
        calls: recordedCalls,
        http: await this.httpCalls(),
        failures: recording.emitted
          .filter((e) => e.code !== null)
          .map((e) => ({ event: e.event, code: e.code ?? 'unclassified', cause: e.cause ?? '' })),
        owedEffects: recording.emitted
          .filter((e) => e.event === 'turn.terminal_effects_owed')
          .flatMap((e) => {
            const owed = e.fields['owed'];

            return v.is(v.string(), owed) ? owed.split(',').filter((k) => k.length > 0) : [];
          }),
        factsCompressed: recording.emitted
          .filter((e) => e.event === 'memory.facts_compressed').length,
      });
    } finally {
      restore();
    }
  }

  /** The HTTP seam's readback: the Node-side handler's captured request log
   *  over the test-only control host. Only this worker's outbound handler
   *  routes there, so this fetch is the established "pull the pool's log over
   *  the existing RPC" pattern — no new Worker, no cross-worker binding. */
  async httpCalls(): Promise<HttpCall[]> {
    const response = await fetch('http://probe-control.invalid/log');

    // SAFETY: the `/log` branch constructs its answer as `{ calls: [...log] }`,
    // so this object shape is owner-guaranteed by the handler in this tree;
    // v.parse against the shared array schema names any drift.
    return v.parse(v.array(HttpCallSchema), (await response.json() as { calls: unknown }).calls);
  }

  /** Clear the HTTP log before a drive, so each test's wire proof is its own. */
  async httpReset(): Promise<void> {
    await fetch('http://probe-control.invalid/reset', { method: 'POST' });
  }

  /** Real socket intake and Think queue; only the remote model response is
   * held. Peer ingress queues a durable event-drain submission while both
   * socket inputs are pending, so its inherited lastBody belongs to B. */
  async queuedConversation(mode: 'chat' | 'peer'): Promise<HttpCall[]> {
    const workspace = `queue-${mode}-workspace`;
    const owner = `queue-${mode}-owner`;

    const target: QueueTarget = await getAgentByName<ProbeEnv, ProductionOrchestrator>(
      this.env.OrchestratorAgent, workspace,
    );

    const caller = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(owner));
    await userDO.registerWorkspace(caller, workspace, 'Queue Probe');
    const claim = await target.claimOwner(owner);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await userDO.setCredential(caller, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: 'http://fake-models.invalid/v1', apiKey: 'probe-fixture-key',
    });
    await target.setModel('openai-compat/probe-queue');
    await target.setSoul('# Queue Probe\n\n## Mission\n\nFollow the owner\'s exact request.');
    await this.httpReset();
    await fetch('http://probe-control.invalid/queue/hold', { method: 'POST' });
    const recording = createRecordingLogger();
    const restore = setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), recording]));
    const submission = Promise.withResolvers<void>();

    const unsubscribe = subscribe('message', (event) => {
      if (event.name === workspace && event.type === 'submission:status' && event.payload.status === 'running') {
        submission.resolve();
      }
    });

    let socket: WebSocket | null = null;

    try {
      const response = await target.fetch(new Request(`https://probe/agents/orchestrator-agent/${workspace}`, {
        headers: { Upgrade: 'websocket' },
      }));

      socket = response.webSocket;

      if (response.status !== 101 || socket === null) throw new Error('queue probe did not receive a real WebSocket');
      socket.accept();
      const genesis = await target.beginGenesisTurn();

      if (!genesis.started) throw new Error('queue probe genesis did not start');
      await fetch('http://probe-control.invalid/queue/arrived');

      const send = async (text: string): Promise<void> => {
        if (socket === null) throw new Error('queue probe socket is closed');
        socket.send(JSON.stringify({
          type: 'cf_agent_use_chat_request', id: text,
          init: { method: 'POST', body: JSON.stringify({
            messages: [{ id: `input-${text}`, role: 'user', parts: [{ type: 'text', text }] }],
            trigger: 'submit-message',
          }) },
        }));
        const began = Date.now();

        for (;;) {
          const response = await target.fetch(`https://probe/agents/orchestrator-agent/${workspace}/get-messages`);
          const history = v.parse(SocketHistorySchema, await response.json());

          if (history.some((row) => row.role === 'user' && row.id === `input-${text}`)) break;

          if (Date.now() - began > 20000) throw new Error(`socket input ${text} was not persisted`);
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
      };

      await send('QUEUE-A');
      await send('QUEUE-B');

      if (mode === 'peer') {
        const peer = await target.receivePeerMessage({
          sender_event_id: 'queue-peer-input', sender_agent_name: 'queue-peer', sender_user_id: owner,
          topic: 'queue-probe', body: 'QUEUE-PROGRAMMATIC', mode: 'build', reply_expected: false,
        });

        if (!peer.admitted) throw new Error(`queue probe peer input refused: ${peer.reason}`);
        await submission.promise;
        await send('QUEUE-C');
      }

      const heldCalls = (await this.httpCalls()).filter((call) => call.model === 'probe-queue');

      if (heldCalls.length !== 1) throw new Error('queued requests ran before the held genesis response was released');
      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });
      await awaitFactsCompressed(recording, mode === 'chat' ? 3 : 5);
      await awaitQuiet(recording);

      return await this.httpCalls();
    } finally {
      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });
      socket?.close(1000, 'queue probe complete');
      unsubscribe();
      restore();
    }
  }


  /** One parameterized drive for the lifecycle variants: its own workspace so
   *  Think state never crosses between experiments. The early-[DONE] variant
   *  pins a model whose stream the fake leaves open after [DONE]; the turn
   *  still completes, and whatever the runtime does with the un-closed pipe
   *  is the discriminating datum against the normal-EOF drive. */
  async driveOnce(input: DriveOnceInput): Promise<DriveOnceResult> {
    const drive = v.parse(DriveOnceInputSchema, input);
    // Capture AFTER warmup, like `exercise`: each DO constructor installs the
    // analytics sink on first stub use, replacing whatever exists — an install
    // up front would be clobbered by the register/claim below.
    const recording = createRecordingLogger();

    const capture = (): (() => void) => setDiagnosticsSink(
      createCompositeLogger([createConsoleLogger(), recording]),
    );

    let restore: () => void = () => {};

    try {
      const raw: Pick<Fetcher, 'fetch'> = await getAgentByName<ProbeEnv, ProductionOrchestrator>(
        this.env.OrchestratorAgent, drive.workspace,
      );

      // SAFETY: `getAgentByName` constructed the stub over the `OrchestratorAgent`
      // binding, and every picked name is a method the production class declares
      // and `ORCHESTRATOR_RPC_SURFACE` lists, so the narrowed calls resolve.
      const target = raw as Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator,
        'claimOwner' | 'setModel' | 'runTaskFromMcp' | 'getWorkspaceSnapshot' | 'getChatHistoryPage' | 'writeWorkspaceFile'>;

      const caller = await ownerCaller(this.env);

      // SAFETY: `env.UserDO` declares the real `UserDO` class in this worker's
      // durableObjects, so the stub carries the registry methods the owner
      // caller tier admits.
      const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(drive.owner)) as
        DurableObjectStub & Pick<UserDO, 'registerWorkspace' | 'ensureWorkspaceCapability' | 'setCredential'>;

      await userDO.registerWorkspace(caller, drive.workspace, drive.displayName);
      const claim = await target.claimOwner(drive.owner);

      await userDO.ensureWorkspaceCapability(drive.workspace, claim.capabilityHash);
      await userDO.setCredential(caller, 'openai-compat.default', {
        kind: 'openai-compat',
        baseURL: 'http://fake-models.invalid/v1',
        apiKey: 'probe-fixture-key',
      });
      await this.httpReset();
      await target.setModel(drive.model);

      // The tool roundtrip's fixture: a harmless file in the workspace the
      // `file` tool reads for real when the fake answers the tool call.
      // Seeded through the existing workspace-file RPC, never the VFS.
      if (drive.seedFile !== undefined) {
        const seeded = await target.writeWorkspaceFile({
          kind: 'file',
          path: drive.seedFile.path,
          data: drive.seedFile.content,
        });

        if (!seeded.ok) throw new Error(`two-turn probe: fixture seed failed for ${drive.seedFile.path}`);
      }

      restore = capture();
      const turn = await target.runTaskFromMcp(drive.text);

      if (turn.status !== 'queued') {
        const http = await this.httpCalls();

        const history = await target.getChatHistoryPage({});

        const failures = recording.emitted
          .filter((e) => e.code !== null)
          .map((e) => ({ event: e.event, code: e.code ?? 'unclassified', cause: e.cause ?? '' }));

        throw new Error(`two-turn probe: turn skipped at enqueue: ${JSON.stringify({ turn, http, history, failures })}`);
      }

      await awaitFactsCompressed(recording, 1);
      await awaitQuiet(recording);

      const snapshot = await target.getWorkspaceSnapshot();
      const history = await target.getChatHistoryPage({});

      return v.parse(DriveOnceResultSchema, {
        turn, snapshot, history,
        calls: recordedCalls,
        http: await this.httpCalls(),
        failures: recording.emitted
          .filter((e) => e.code !== null)
          .map((e) => ({ event: e.event, code: e.code ?? 'unclassified', cause: e.cause ?? '' })),
        owedEffects: recording.emitted
          .filter((e) => e.event === 'turn.terminal_effects_owed')
          .flatMap((e) => {
            const owed = e.fields['owed'];

            return v.is(v.string(), owed) ? owed.split(',').filter((k) => k.length > 0) : [];
          }),
        factsCompressed: recording.emitted
          .filter((e) => e.event === 'memory.facts_compressed').length,
      });
    } finally {
      restore();
    }
  }
}
