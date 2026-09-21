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
 * turn's sleep-time settle event arrives (`memory.facts_deferred` or
 * `memory.facts_compressed`) — the sleep-time effect's
 * completion record — then, after the second turn, waits for log quiescence
 * and asserts the captured log holds zero failures and zero
 * `turn.terminal_effects_owed` events. `end()` emits the owed event exactly
 * when a close finishes with effects still owed (terminal-transition.ts), so
 * its absence after quiescence is the close finishing clean, and the worker
 * exiting with no "hung" exceptions is the same fact from the runtime side.
 *
 * WHY THIS FILE EXISTS. Two shipped defects are observable only over a real
 * OrchestratorAgent running two turns end to end over the real canonical
 * store: a transcript count that named a column the store never created
 * (2026-09-08), and the second turn's model request dropping
 * the message that started it (2026-09-08). Every bun suite seeds history
 * itself; the earlier workerd claim that a full turn cannot be hosted here is
 * stale — CompiledWasm modules and `workerLoaders` are wired for the sibling
 * probes in vitest.config.ts.
 */
import { Agent, getAgentByName, type AgentContext } from 'agents';
import { subscribe } from 'agents/observability';
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  SleepTimeUpdateSchema,
  parseWorkspaceTitle,
  hostedActorSocketPath, JsonValueSchema,
} from '@kinu.run/core';
import {
  createCompositeLogger,
  createConsoleLogger,
  createRecordingLogger,
  setDiagnosticsSink,
  type RecordingLogger,
} from '@kinu.run/core/obs';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import type {
  AgentLogEvent,
  ArmedWake,
  CallRecord,
  DriveOnceInput,
  DriveOnceResult,
  ExerciseResult,
  HttpCall,
  ParityCompleted,
  ParityFrame,
  ParityPrepared,
  ParityRows,
  PendingSteer,
  PendingSteerFile,
  PreparedConversation,
  QueueProbeMode,
  RawChatProbeResult,
} from './two-turn-shapes';
import {
  ArmedWakeSchema,
  DriveOnceInputSchema,
  DriveOnceResultSchema,
  ExerciseResultSchema,
  HttpCallSchema,
  ParityCompletedSchema,
  ParityFrameSchema,
  ParityPreparedSchema,
  ParityRowsSchema,
  PreparedConversationSchema,
  WakeDriveResultSchema,
  WakeRowsSchema,
  WAKE_MARKER,
  type WakeDriveResult,
  type WakeHoldPlacement,
  type WakeRows,
} from './two-turn-shapes';
import type { UserDO } from '../../src/user/user-do';
import { ownerCaller, type WorkMode } from '@kinu.run/core';
import type { ToolSet } from 'ai';

// Re-exported under their production names so the auxiliary worker's
// durableObjects bind the classes themselves — the same mechanism
// slate-actor-probe.ts:43-48 uses, for the same reason: a probe that retargets
// the class measures its own fixture, not the shipped surface.
export { UserDO } from '../../src/user/user-do';

/** The production orchestrator, sealed with its own surface plus the fixture
 *  reads, bound under the production name so the same service-binding
 *  wiring runs the actual production lifecycle. It adds NO production method
 *  and no state: the constructor only retains the given DurableObjectState so
 *  `pendingSteers` can observe the actor's durable send ledger — the rows the
 *  real socket path writes — as legitimate external storage, never reaching a
 *  protected member or a made-up setter. */
export class ObservedOrchestrator extends ProductionOrchestrator {
  private readonly actorState: AgentContext;

  constructor(ctx: AgentContext, env: ProbeEnv) {
    super(ctx, env);
    this.actorState = ctx;
    Reflect.deleteProperty(this, 'pendingSteers');
    Reflect.deleteProperty(this, 'pendingSteerFileRows');
    Reflect.deleteProperty(this, 'agentLogEvents');
    Reflect.deleteProperty(this, 'inboxState');
    Reflect.deleteProperty(this, 'runEnds');
    Reflect.deleteProperty(this, 'seedStaleDrainEvent');
    Reflect.deleteProperty(this, 'runEventWake');
    Reflect.deleteProperty(this, 'parityRows');
    Reflect.deleteProperty(this, 'wakeRows');
    Reflect.deleteProperty(this, 'armedWakeRows');
    Reflect.deleteProperty(this, 'driveArmedWakes');
    Reflect.deleteProperty(this, 'runStartCauses');
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'pendingSteers', 'pendingSteerFileRows', 'agentLogEvents', 'inboxState', 'runEnds', 'seedStaleDrainEvent', 'runEventWake', 'parityRows', 'wakeRows', 'armedWakeRows', 'driveArmedWakes', 'runStartCauses']);
  }

  /** The wake proof's hold on the SETTLE WINDOW: a turn-end extension is run
   *  by the inline `turn_end_extensions` effect, between the answer's commit
   *  and the pump's next item, so a hook that parks there holds the settle
   *  open. Parks over `/wake/wait` while a settle-placed hold is armed. */
  private _settleHoldInstalled = false;
  private installSettleHold(): void {
    if (this._settleHoldInstalled) return;
    this._settleHoldInstalled = true;
    this.extensions.register({
      name: 'probe.settle-hold',
      onTurnEnd: async () => {
        await fetch('http://probe-control.invalid/wake/wait');
      },
    });
  }

  /** The `shell` tool, for the wake proof: the command sleeps past the detach
   *  window and prints the marker — no container, the same wrap. Only the
   *  execute is the probe's; the schema, the wrap and the runner are the
   *  product's, which is what the detach and the settle are proven on. */
  protected override getRawToolsForWorkMode(mode: WorkMode, claimScope?: string): ToolSet {
    this.installSettleHold();
    const tools = super.getRawToolsForWorkMode(mode, claimScope);
    const shell = tools.shell;

    if (shell === undefined) return tools;

    return {
      ...tools,
      shell: {
        ...shell,
        execute: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, WAKE_RUN_SLEEP_MS));

          return `${WAKE_MARKER}\n`;
        },
      },
    };
  }

  /** The durable rows the wake proof reads: the job, the runs, the answers. */
  async wakeRows(): Promise<WakeRows> {
    const sql = this.actorState.storage.sql;

    return v.parse(WakeRowsSchema, {
      jobs: sql.exec('SELECT id, kind, status, result, settled_at FROM background_jobs ORDER BY created_at').toArray()
        .map((row) => ({
          id: String(row.id), kind: String(row.kind), status: String(row.status),
          result: row.result === null ? null : String(row.result), settledAt: row.settled_at === null ? null : Number(row.settled_at),
        })),
      runs: sql.exec("SELECT run_id, type, payload FROM run_events WHERE type IN ('run_start', 'run_end') ORDER BY rowid").toArray()
        .reduce<Array<{ runId: string; userMessage: string; reason: string | null }>>((runs, row) => {
          const payload = v.parse(v.looseObject({ userMessage: v.optional(v.string()), reason: v.optional(v.string()) }), JSON.parse(String(row.payload)));

          if (String(row.type) === 'run_start') runs.push({ runId: String(row.run_id), userMessage: payload.userMessage ?? '', reason: null });
          else {
            const run = runs.find((candidate) => candidate.runId === String(row.run_id));

            if (run !== undefined) run.reason = payload.reason ?? null;
          }

          return runs;
        }, []),
      assistantTexts: await this.assistantTexts(),
    });
  }

  /** The chat's assistant answers as a reader projects them, root first. */
  private async assistantTexts(): Promise<string[]> {
    const texts: string[] = [];

    for (const entry of this.chatTranscript.ancestry()) {
      if (entry.role !== 'assistant') continue;
      const projected = await this.chatTranscript.project(entry.id);

      if (projected !== null) texts.push(projected.content);
    }

    return texts;
  }

  /** The chat's entries, root first, each as the UI message a client reads. */
  private async conversationRows(): Promise<ParityRows['assistantMessages']> {
    const rows: ParityRows['assistantMessages'] = [];

    for (const entry of this.chatTranscript.ancestry()) {
      const message = await this.chatTranscript.message(entry.id);

      if (message !== null) rows.push({ id: entry.id, parentId: entry.parentId, role: entry.role, content: JSON.stringify(message) });
    }

    return rows;
  }

  /** The durable reservations a mid-turn send leaves: each accepted message's
   *  own client id bound to the turn it will land in — the row a reset must
   *  restore so a replayed frame keeps its token. */
  async pendingSteers(): Promise<PendingSteer[]> {
    return this.actorState.storage.sql
      .exec('SELECT actor_id, id, turn_id, mode, text FROM pending_steers ORDER BY actor_id, id')
      .toArray()
      .map((row) => ({
        actorId: String(row.actor_id),
        id: String(row.id),
        turnId: String(row.turn_id),
        mode: String(row.mode),
        text: String(row.text),
      }));
  }

  /** The file parts reserved alongside a pending steer — the durable half of
   *  an attachment that arrived while a turn was live. */
  async pendingSteerFileRows(): Promise<PendingSteerFile[]> {
    return this.actorState.storage.sql
      .exec('SELECT actor_id, steer_id, filename, media_type, url FROM pending_steer_files ORDER BY actor_id, steer_id, seq')
      .toArray()
      .map((row) => ({
        actorId: String(row.actor_id),
        steerId: String(row.steer_id),
        filename: String(row.filename),
        mediaType: String(row.media_type),
        url: String(row.url),
      }));
  }

  /** The event rows an unbindStale sweep sees: which drain turn owns each and
   *  the lease timestamp it judges staleness on. */
  async agentLogEvents(): Promise<AgentLogEvent[]> {
    return this.actorState.storage.sql
      .exec("SELECT id, turn_id, consumed_at, variant FROM agent_log WHERE kind = 'event' ORDER BY id")
      .toArray()
      .map((row) => ({
        id: String(row.id),
        turnId: row.turn_id === null ? null : String(row.turn_id),
        consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
        variant: String(row.variant),
      }));
  }


  /** Whether the inbox reads a turn in flight — the public `busy` getter the
   *  busy route itself consults, so a probe sees the admission the same way
   *  `routeBusyChat` does. */
  /** Every `run_end` the run ledger holds, in write order with its reason: how
   *  many times each run was closed and by what. A run the loop continues
   *  after a reset closes exactly once, by the loop. */
  async runEnds(): Promise<Array<{ runId: string; reason: string }>> {
    return this.actorState.storage.sql
      .exec(`SELECT run_id, payload FROM run_events WHERE type = 'run_end' ORDER BY ts, rowid`)
      .toArray()
      .map((row) => ({
        runId: String(row.run_id),
        reason: v.parse(v.object({ reason: v.string() }), JSON.parse(String(row.payload))).reason,
      }));
  }

  async inboxState(): Promise<{ busy: boolean }> {
    return { busy: this.orch.inbox.busy };
  }

  /** The durable record the parity script compares: the transcript, the
   *  pending-send ledger, the event log, the terminal ledger and the run
   *  ledger's continuation rows — every one read raw, in table order, so the
   *  test's normalizer is the only thing that decides what "the same" means. */
  async parityRows(): Promise<ParityRows> {
    const sql = this.actorState.storage.sql;

    return v.parse(ParityRowsSchema, {
      assistantMessages: await this.conversationRows(),
      pendingSteers: await this.pendingSteers(),
      pendingSteerFiles: await this.pendingSteerFileRows(),
      agentLog: sql.exec('SELECT id, kind, turn_id, variant, consumed_at, payload FROM agent_log ORDER BY rowid').toArray()
        .map((row) => ({
          id: String(row.id), kind: String(row.kind), turnId: row.turn_id === null ? null : String(row.turn_id),
          variant: row.variant === null ? null : String(row.variant), consumed: row.consumed_at !== null, payload: String(row.payload),
        })),
      terminalEffects: sql.exec('SELECT sequence_id, effect_key, effect_name, scope, seq, input_json, lane, status, outcome, attempts, settled_at FROM terminal_effects ORDER BY rowid').toArray()
        .map((row) => ({
          sequenceId: String(row.sequence_id), effectKey: String(row.effect_key), effectName: String(row.effect_name), scope: String(row.scope),
          seq: Number(row.seq), input: String(row.input_json), lane: String(row.lane), status: String(row.status),
          outcome: row.outcome === null ? null : String(row.outcome), attempts: Number(row.attempts), settled: row.settled_at !== null,
        })),
      runEvents: sql.exec("SELECT run_id, type, payload FROM run_events WHERE type IN ('run_start', 'step_finish', 'tool_call_end', 'run_end') ORDER BY rowid").toArray()
        .map((row) => ({ runId: String(row.run_id), type: String(row.type), payload: String(row.payload) })),
    });
  }
  /** The state a dead activation leaves behind: an event bound to a drain turn
   *  whose lease outlived it. `consumed_at = 0` is older than any grace, so the
   *  next wake's unbindStale must re-pend it rather than skip it as live work. */
  async seedStaleDrainEvent(marker: string): Promise<void> {
    this.ensureSchema();
    this.actorState.storage.sql.exec(
      `INSERT INTO agent_log
         (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
          trust, priority, payload_visibility, payload, received_at,
          schema_version, dedupe_key, consumed_at)
       VALUES (?, ?, 'event', 'evt-seeded-dead', 0, NULL, 'tr-seeded', 'webhook_bearer', 'webhook',
               'authenticated', 'normal', 'full', ?, 1, 1, NULL, 0)`,
      this.actorHandle().actorId,
      `ev-seeded-${marker}`,
      JSON.stringify({
        webhook_id: 'w-buffered', http_method: 'POST', http_headers: {},
        body: { mark: marker }, delivery_id: `d-${marker}`,
      }),
    );
  }

  /** The wake frame, driven synchronously for the test: `owedDeliveryWork`
   *  re-pends the stale leases (the unbindStale half), then the reactor drains
   *  whatever is pending — the two halves the platform alarm runs in order.
   *  The drain's model call lands async after admission, so the wake joins on
   *  the buffered event's marker reaching the wire log before returning: the
   *  fake parks `/log/until` until the call carrying the marker is recorded.
   *  A wake that never re-delivers hangs here, ended and named by the row's
   *  deadline. */
  async runEventWake(marker: string): Promise<void> {
    await this.owedDeliveryWork();
    await this.orch.drainPendingEvents({ rethrow: true });
    await fetch(`http://probe-control.invalid/log/until?marker=${encodeURIComponent(marker)}`);
  }

  /** The durable wake registry as the platform holds it: which callback each
   *  armed row names, and when. The discriminating read for a two-chain
   *  actor — a fold arms ONE chain's callback, and only that chain's frame
   *  runs. Future rows only, the same rule `armWakeRow`'s collapse applies:
   *  while a tick executes, the SDK keeps its own overdue row listed until the
   *  callback returns, and counting it would report a wake nothing owes. */
  async armedWakeRows(): Promise<ArmedWake[]> {
    const nowSec = Math.floor(Date.now() / 1000);

    return (await this.listSchedules())
      .filter((row) => row.time > nowSec)
      .map((row) => v.parse(ArmedWakeSchema, { callback: row.callback, at: row.time }))
      .sort((left, right) => left.at - right.at || left.callback.localeCompare(right.callback));
  }

  /**
   * Deliver the wakes this object has armed — ONE lap, in wake order — and
   * answer which callbacks ran.
   *
   * THE FRAME, NEVER THE WORK. The probe reads the registry and invokes the
   * callback each row names; it does not pick the chain and it does not call
   * `drainPendingEvents`, `maintenanceWork` or any other pass by hand. That is
   * the whole measurement for an actor with two wake chains: a fold arms a
   * callback, the platform delivers exactly that callback, and whether the
   * frame behind it can take the work is the product's answer — not the
   * probe's. A probe that drove a hand-picked pass would report a product that
   * was never asked (`hire-probe.ts:225-232` records that failure).
   *
   * In-request because the pool cannot deliver a real alarm to an object while
   * a request holds its input gate. ONE lap because one delivery is what the
   * platform owes for one armed row; a property that needs a second lap is a
   * finding the caller states, not one this method hides by looping.
   */
  async driveArmedWakes(): Promise<string[]> {
    // The two Kinu wake callbacks, paired with the frame each one names. A
    // `const` tuple list rather than a dictionary: the registry answers a
    // string, and this is the one place that string becomes a call.
    const frames = [
      ['_kinuTimerTick', () => this._kinuTimerTick()],
      ['_kinuTerminalRetryTick', () => this._kinuTerminalRetryTick()],
    ] as const;

    const armed = await this.armedWakeRows();
    const driven: string[] = [];

    for (const row of armed) {
      const frame = frames.find(([callback]) => callback === row.callback);

      if (frame === undefined) continue;
      await frame[1]();
      driven.push(row.callback);
    }

    return driven;
  }

  /** Every run the ledger opened, by what caused it. A drain turn is
   *  `caused_by: 'event_drain'`, which is how a reader tells the reactor's own
   *  turn from a chat turn that happened to absorb the batch. */
  async runStartCauses(): Promise<string[]> {
    return this.actorState.storage.sql
      .exec("SELECT payload FROM run_events WHERE type = 'run_start' ORDER BY rowid")
      .toArray()
      .map((row) => v.parse(
        v.fallback(v.looseObject({ caused_by: v.fallback(v.string(), '') }), { caused_by: '' }),
        JSON.parse(String(row.payload)),
      ).caused_by);
  }
}

export { ObservedOrchestrator as OrchestratorAgent };

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
  'claimOwner' | 'setModel' | 'setSoul' | 'beginGenesisTurn' | 'receivePeerMessage' | 'runTaskFromMcp' | 'evalAbortActivation' | 'workspaceTitle'
  | 'createSubordinateAgent'>
  & Pick<ObservedOrchestrator, 'pendingSteers' | 'pendingSteerFileRows' | 'agentLogEvents' | 'inboxState' | 'runEnds' | 'seedStaleDrainEvent' | 'runEventWake' | 'parityRows' | 'wakeRows'
  | 'armedWakeRows' | 'driveArmedWakes' | 'runStartCauses'>;

/** How long the wake proof's command sleeps: past the interactive detach
 *  window (30 s), so the call detaches and the job settles out of turn. */
const WAKE_RUN_SLEEP_MS = 40_000;

const SocketHistorySchema = v.array(v.object({ id: v.string(), role: v.string() }));

type SocketHistory = v.InferOutput<typeof SocketHistorySchema>;

/** Every frame the raw-chat drive reads off its socket, loosely: the chat
 *  request's own done frame (`id`, `done`, `landed`) and the steer lifecycle
 *  the object broadcasts beside it (`status`, `steerId`, `text`, `atStep`). */
const RawChatFrameSchema = v.looseObject({
  type: v.string(),
  id: v.optional(v.string()),
  done: v.optional(v.boolean()),
  landed: v.optional(v.string()),
  status: v.optional(v.string()),
  steerId: v.optional(v.string()),
  text: v.optional(v.string()),
  atStep: v.optional(v.number()),
});

/** The drive result shapes live in `./two-turn-shapes` — same schemas, same
 *  InferOutput types, but importable from the workerd typecheck project,
 *  which excludes this file for importing production `src` (see the
 *  `//exclude` note in this directory's tsconfig). */

/** The sleep-time effect's own completion record, one per settled turn: the
 *  lane runs on a cadence, so a turn it declines says so on the log exactly
 *  as one it compresses does. */
function sleepTimeSettled(emitted: readonly { event: string }[]): number {
  return emitted.filter((e) => e.event === 'memory.facts_deferred' || e.event === 'memory.facts_compressed').length;
}

/** Join on the product's own completion evidence: one sleep-time settle per
 *  turn, awaited on the recording sink's own delivery. A close that never
 *  finishes hangs here, ended and named by the row's deadline rather than by
 *  a clock beside it. */
function awaitSleepTimeSettled(recording: RecordingLogger, count: number): Promise<void> {
  return recording.until((emitted) => sleepTimeSettled(emitted) >= count);
}

/** A bounded wait on one promise, naming what did not arrive. */
async function awaitWithLimit<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  const expiry = Promise.withResolvers<never>();
  const timer = setTimeout(() => expiry.reject(new Error(what)), ms);

  try { return await Promise.race([work, expiry.promise]); }
  finally { clearTimeout(timer); }
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
  /** Spike 1: does an AbortSignal cross the service binding into `shell`?
   *  Returns the kind FakeAI recorded, or the throw's message — the caller
   *  cannot distinguish "no signal" from a serialization failure otherwise. */
  async signalProbe(): Promise<{ signalKind: string } | { threw: string }> {
    try {
      // SAFETY: the vitest config declares `env.AI` as this worker's service
      // binding to `FakeAI`, whose entrypoint contract provides `shell` — the
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

      await awaitSleepTimeSettled(recording, 1);

      restore = capture();
      const turnB = await target.runTaskFromMcp('B');

      if (turnB.status !== 'queued') {
        throw new Error(`two-turn probe: turn B skipped at enqueue: ${JSON.stringify(turnB)}`);
      }

      await awaitSleepTimeSettled(recording, 2);
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
        sleepTimeSettled: sleepTimeSettled(recording.emitted),
        catalogFallbacks: recording.emitted.filter((e) => e.event === 'models_dev.catalog_fallback').length,
        catalogHits: (await this.probeLog()).catalogHits,
      });
    } finally {
      restore();
    }
  }

  /** One workspace, `priorTurns` turns of `priorDeltas` streamed deltas
   *  each, then one turn of `deltas` — each timed from enqueue to the turn's
   *  settle, as the object itself experiences it. The transcript-cost gate
   *  reads the two timings against each other. */
  async longTurn(priorTurns: number, deltas: number, priorDeltas = 20): Promise<{ priorMs: number; longMs: number; calls: number }> {
    const workspace = `long-${priorTurns}-${deltas}-${priorDeltas}`;
    const target: QueueTarget = await this.queueTarget(workspace);
    const caller = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName('long-owner'));
    await userDO.registerWorkspace(caller, workspace, 'Long');
    const claim = await target.claimOwner('long-owner');
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await userDO.setCredential(caller, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: 'http://fake-models.invalid/v1', apiKey: 'probe-fixture-key',
    });
    await target.setModel('openai-compat/probe-long');
    await this.httpReset();
    const recording = createRecordingLogger();
    setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), recording]));

    const t0 = Date.now();

    for (let i = 0; i < priorTurns; i += 1) {
      const queued = await target.runTaskFromMcp(`long:${priorDeltas}`);

      if (queued.status !== 'queued') throw new Error(`long bench: prior turn ${JSON.stringify(queued)}`);
      await awaitSleepTimeSettled(recording, i + 1);
    }

    const priorMs = Date.now() - t0;
    const t1 = Date.now();
    const queued = await target.runTaskFromMcp(`long:${deltas}`);

    if (queued.status !== 'queued') throw new Error(`long bench: long turn ${JSON.stringify(queued)}`);
    await awaitSleepTimeSettled(recording, priorTurns + 1);
    const longMs = Date.now() - t1;

    return { priorMs, longMs, calls: (await this.httpCalls()).length };
  }

  /** The HTTP seam's readback: the Node-side handler's captured request log
   *  over the test-only control host. Only this worker's outbound handler
   *  routes there, so this fetch is the established "pull the pool's log over
   *  the existing RPC" pattern — no new Worker, no cross-worker binding. */
  async httpCalls(): Promise<HttpCall[]> {
    return (await this.probeLog()).calls;
  }

  /** The probe's outbound log: every model call, and how many times the
   *  worker fetched the provider catalog. */
  async probeLog(): Promise<{ calls: HttpCall[]; catalogHits: number }> {
    const response = await fetch('http://probe-control.invalid/log');

    // Parsed at the boundary: the `/log` branch constructs its answer as
    // `{ calls, catalogHits }`, and the schema names any drift.
    return v.parse(v.object({ calls: v.array(HttpCallSchema), catalogHits: v.number() }), await response.json());
  }

  /** Clear the HTTP log before a drive, so each test's wire proof is its own. */
  async httpReset(): Promise<void> {
    await fetch('http://probe-control.invalid/reset', { method: 'POST' });
  }

  /** Real socket intake and Think queue; only the remote model response is
   * held. Peer ingress queues a durable event-drain submission while both
   * socket inputs are pending, so its inherited lastBody belongs to B. */
  async queuedConversation(mode: Exclude<QueueProbeMode, 'cold' | 'attach-cold' | 'evt' | 'rwake' | 'twin'>): Promise<HttpCall[]> {
    const workspace = `queue-${mode}-workspace`;
    const owner = `queue-${mode}-owner`;

    const target: QueueTarget = await this.queueTarget(workspace);

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

      // A busy-routed send is announced `queued` under its client id the
      // moment the running turn's inbox takes it — its request is answered
      // only when the words land, which the held provider call forbids —
      // while an idle send only persists its row. send() resolves on
      // WHICHEVER arrives first, so it never outlives either path.
      const admittedIds = new Set<string>();
      socket.addEventListener('message', (event) => {
        const raw = v.is(v.string(), event.data) ? event.data : '';

        const frame = v.safeParse(
          v.object({ type: v.string(), id: v.optional(v.string()), done: v.optional(v.boolean()), status: v.optional(v.string()), steerId: v.optional(v.string()) }),
          raw.startsWith('{') ? JSON.parse(raw) : {},
        );

        if (!frame.success) return;

        if (frame.output.type === 'cf_agent_use_chat_response' && frame.output.done === true) {
          admittedIds.add(String(frame.output.id));
        }

        if (frame.output.type === 'steer_status' && frame.output.status === 'queued' && frame.output.steerId !== undefined) {
          admittedIds.add(frame.output.steerId.replace(/^input-/, ''));
        }
      });

      const send = async (text: string, file?: { filename: string; mediaType: string; url: string }): Promise<void> => {
        if (socket === null) throw new Error('queue probe socket is closed');
        socket.send(JSON.stringify({
          type: 'cf_agent_use_chat_request', id: text,
          init: { method: 'POST', body: JSON.stringify({
            messages: [{ id: `input-${text}`, role: 'user', parts: [
              ...(file !== undefined ? [{ type: 'file', mediaType: file.mediaType, url: file.url, filename: file.filename }] : []),
              { type: 'text', text },
            ] }],
            trigger: 'submit-message',
          }) },
        }));
        const began = Date.now();

        for (;;) {
          const page = await target.fetch(`https://probe/agents/orchestrator-agent/${workspace}/get-messages`);
          const history = v.parse(SocketHistorySchema, await page.json());

          if (history.some((row) => row.role === 'user' && row.id === `input-${text}`) || admittedIds.has(text)) break;

          if (Date.now() - began > 20000) throw new Error(`socket input ${text} neither persisted nor announced queued`);
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
      };

      if (mode === 'yield') {
        await send('QUEUE-OWNER');
        await fetch('http://probe-control.invalid/queue/arrived');
        await target.beginGenesisTurn();
      } else {
        const genesis = await target.beginGenesisTurn();

        if (!genesis.started) throw new Error('queue probe genesis did not start');
        await fetch('http://probe-control.invalid/queue/arrived');
        await send('QUEUE-A');
        await send('QUEUE-B', mode === 'attach'
          ? { filename: 'chart.png', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }
          : undefined);
      }

      if (mode === 'peer') {
        // A peer event is not an SDK chat request: it does not splice, it
        // writes a durable event row and its own event-drain turn drains it.
        // No socket 'submission:running' frame is issued for it now.
        const peer = await target.receivePeerMessage({
          sender_event_id: 'queue-peer-input', sender_agent_name: 'queue-peer', sender_user_id: owner,
          topic: 'queue-probe', body: 'QUEUE-PROGRAMMATIC', mode: 'build', reply_expected: false,
        });

        if (!peer.admitted) throw new Error(`queue probe peer input refused: ${peer.reason}`);
        await send('QUEUE-C');
      }

      if (mode === 'signal') await target.runTaskFromMcp('QUEUE-PROGRAMMATIC');

      const heldCalls = (await this.httpCalls()).filter((call) => call.model === 'probe-queue');

      if (heldCalls.length !== 1) throw new Error('queued requests ran before the held genesis response was released');
      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });

      // Turns, not sends: the held genesis, then ONE user-origin rerun of the
      // sends it could not land. A peer event that arrived mid-genesis rides
      // that rerun's first step rather than queueing a turn behind it; a
      // signal's own programmatic turn is the third.
      await awaitSleepTimeSettled(recording, { chat: 2, peer: 2, signal: 3, yield: 1, attach: 2 }[mode]);
      await awaitQuiet(recording);

      return await this.httpCalls();
    } finally {
      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });
      socket?.close(1000, 'queue probe complete');
      unsubscribe();
      restore();
    }
  }

  /**
   * THE BACKGROUND WAKE, on the loop, with the settle window held.
   *
   * The owner asks for a command that sleeps past the detach window. The call
   * detaches at 30 s and the turn goes on to its reply step. `where` says what
   * is held while the job settles at 40 s: the reply step itself (the model
   * call carrying the detach handle parks in the fake — the live incident's
   * window, the turn still RUNNING when the job settles), or the settle (the
   * probe's turn-end hook parks after the answer's commit). Either way the
   * wake asks the loop for a turn while the interactive turn still owns it.
   * The hold is released only after the job row says settled, and the drive
   * then waits for the woken turn to reach its reply. On Think's queue this
   * is the admission that parked forever; on the loop 'queued' means the pump
   * runs it next.
   */
  async backgroundWakeConversation(where: WakeHoldPlacement): Promise<WakeDriveResult> {
    const workspace = `wake-workspace-${where}`;
    const owner = `wake-owner-${where}`;
    const target: QueueTarget = await this.queueTarget(workspace);

    const caller = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(owner));
    await userDO.registerWorkspace(caller, workspace, 'Wake Probe');
    const claim = await target.claimOwner(owner);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await userDO.setCredential(caller, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: 'http://fake-models.invalid/v1', apiKey: 'probe-fixture-key',
    });
    await target.setModel('openai-compat/probe-wake');
    await target.setSoul('# Wake Probe\n\n## Mission\n\nFollow the owner\'s exact request.');
    await this.httpReset();
    await fetch('http://probe-control.invalid/wake/hold', { method: 'POST', body: JSON.stringify({ where }) });

    let socket: WebSocket | null = null;

    try {
      const response = await target.fetch(new Request(`https://probe/agents/orchestrator-agent/${workspace}`, {
        headers: { Upgrade: 'websocket' },
      }));

      socket = response.webSocket;

      if (response.status !== 101 || socket === null) throw new Error('wake probe did not receive a real WebSocket');
      socket.accept();
      socket.send(JSON.stringify({
        type: 'cf_agent_use_chat_request', id: 'wake-ask',
        init: { method: 'POST', body: JSON.stringify({
          messages: [{ id: 'input-wake-ask', role: 'user', parts: [{ type: 'text', text: 'WAKE-RUN' }] }],
          trigger: 'submit-message',
        }) },
      }));

      // The job settles on its own clock; the title stays held until it has.
      const began = Date.now();
      let settledAt: number | null = null;

      for (;;) {
        const rows = await target.wakeRows();
        const job = rows.jobs.find((candidate) => candidate.status !== 'running');

        if (job?.settledAt !== null && job?.settledAt !== undefined) {
          settledAt = job.settledAt;
          break;
        }

        if (Date.now() - began > WAKE_RUN_SLEEP_MS + 30_000) {
          const calls = await this.httpCalls();

          throw new Error(`wake probe: the detached job never settled — rows ${JSON.stringify(rows)}; calls ${JSON.stringify(calls.map((call) => ({ model: call.model, users: call.users, toolCalls: call.toolCalls, toolResults: call.toolResults })))}`);
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }

      // The window WAS held when the job settled: the held party arrived at
      // the hold before now, and is released only here.
      await fetch('http://probe-control.invalid/wake/arrived');
      const releasedAt = Date.now();
      await fetch('http://probe-control.invalid/wake/release', { method: 'POST' });

      // The woken turn: a second run, started for the runner's own message,
      // closed with a reply.
      for (;;) {
        const rows = await target.wakeRows();
        const woken = rows.runs.filter((run) => run.userMessage.includes('Background shell job'));

        if (woken.length > 0 && woken.every((run) => run.reason !== null)) {
          const calls = await this.httpCalls();

          return v.parse(WakeDriveResultSchema, {
            where, rows, releasedAt, settledAt,
            calls: calls.filter((call) => call.model === 'probe-wake')
              .map((call) => ({ model: call.model, users: call.users, toolResults: call.toolResults })),
          });
        }

        if (Date.now() - releasedAt > 45_000) {
          const calls = await this.httpCalls();

          throw new Error(`wake probe: the woken turn never closed — rows ${JSON.stringify(rows)}; calls ${JSON.stringify(calls.map((call) => ({ model: call.model, users: call.users.map((line) => line.slice(0, 120)), toolCalls: call.toolCalls, toolResults: call.toolResults })))}`);
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      await fetch('http://probe-control.invalid/wake/release', { method: 'POST' });
      socket?.close(1000, 'wake probe complete');
    }
  }

  /** The shared workspace+owner claim both queue modes open with: a real
   *  UserDO registration, the capability token, the compat credential, and the
   *  queue model pinned so the fake can hold one turn's call. */
  private async claimQueueWorkspace(mode: QueueProbeMode): Promise<{ target: QueueTarget; workspace: string; owner: string }> {
    const workspace = `queue-${mode}-workspace`;
    const owner = `queue-${mode}-owner`;

    const target: QueueTarget = await this.queueTarget(workspace);

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

    return { target, workspace, owner };
  }

  /** One chat frame over a real socket, persisted before it returns, and the
   *  exact wire it sent — the frame the cold test replays after the reset. */
  private async socketHistory(target: QueueTarget, workspace: string): Promise<SocketHistory> {
    const page = await target.fetch(`https://probe/agents/orchestrator-agent/${workspace}/get-messages`);

    return v.parse(SocketHistorySchema, await page.json());
  }

  private async sendChatFrame(
    target: QueueTarget, workspace: string, text: string,
    file?: { filename: string; mediaType: string; url: string },
  ): Promise<{ wire: string; landed: string | null }> {
    const response = await target.fetch(new Request(`https://probe/agents/orchestrator-agent/${workspace}`, {
      headers: { Upgrade: 'websocket' },
    }));

    const socket = response.webSocket;

    if (response.status !== 101 || socket === null) throw new Error('queue probe did not receive a real WebSocket');
    socket.accept();

    // The done frame carries `landed` — 'mid-turn' when the request was
    // busy-routed into a splice, 'turn' when it opened its own turn. Capture
    // it so a probe can assert WHICH admission the prompt took, not only that
    // it persisted.
    const landed = Promise.withResolvers<string | null>();
    socket.addEventListener('message', (event) => {
      const raw = v.is(v.string(), event.data) ? event.data : '';

      const frame = v.safeParse(
        v.object({ type: v.string(), id: v.optional(v.string()), done: v.optional(v.boolean()), landed: v.optional(v.string()) }),
        raw.startsWith('{') ? JSON.parse(raw) : {},
      );

      if (frame.success && frame.output.type === 'cf_agent_use_chat_response'
        && frame.output.done === true && frame.output.id === text) {
        landed.resolve(frame.output.landed ?? null);
      }
    });

    const wire = JSON.stringify({
      type: 'cf_agent_use_chat_request', id: text,
      init: { method: 'POST', body: JSON.stringify({
        messages: [{ id: `input-${text}`, role: 'user', parts: [
          ...(file !== undefined ? [{ type: 'file', mediaType: file.mediaType, url: file.url, filename: file.filename }] : []),
          { type: 'text', text },
        ] }],
        trigger: 'submit-message',
      }) },
    });

    try {
      socket.send(wire);
      const began = Date.now();

      for (;;) {
        const page = await target.fetch(`https://probe/agents/orchestrator-agent/${workspace}/get-messages`);
        const history = v.parse(SocketHistorySchema, await page.json());
        const transcript = history.some((row) => row.role === 'user' && row.id === `input-${text}`);
        const steered = (await target.pendingSteers()).some((row) => row.id === `input-${text}`);

        if (transcript || steered) break;

        if (Date.now() - began > 20000) throw new Error(`socket input ${text} left no durable trace`);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }

      // Wait on the done frame for `landed` — but a busy-routed frame can close
      // before the socket echoes it, so bound the wait and fall back to null.
      const landedValue = await Promise.race([
        landed.promise,
        new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);

      return { wire, landed: landedValue };
    } finally {
      socket.close(1000, 'frame sent');
    }
  }



  /** The cold drive's setup: the genesis turn's model call is held from the
   *  first probe-queue call, then B and C are sent mid-turn — each a
   *  pending_steers reservation bound to the genesis turn, durable before the
   *  reset. The replay must re-bind the same client id to the same turn id. */
  async prepareQueuedConversation(mode: QueueProbeMode): Promise<PreparedConversation> {
    const { target, workspace, owner } = await this.claimQueueWorkspace(mode);
    await fetch('http://probe-control.invalid/queue/hold', {
      method: 'POST', body: JSON.stringify({ from: 1 }),
    });

    const genesis = await target.beginGenesisTurn();

    if (!genesis.started) throw new Error('queue probe genesis did not start');

    // The 'attach' drive sends B with an image part: the reservation that must
    // survive the reset carries a file row beside the steer row.
    const attach = mode === 'attach' || mode === 'attach-cold'
      ? { filename: 'chart.png', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }
      : undefined;

    // Both frames go out while the held call is in flight — after the fake
    // reports it arrived — so each is a steer with no step left to land at
    // before the reset. Sent earlier, B can reach the turn's first drain and
    // land inside the held call, and the reset then has no reservation to keep.
    await fetch('http://probe-control.invalid/queue/arrived');
    const bWire = (await this.sendChatFrame(target, workspace, 'QUEUE-B', attach)).wire;
    const cWire = (await this.sendChatFrame(target, workspace, 'QUEUE-C')).wire;

    // Both admissions are durable before the reset: B's and C's mid-turn sends
    // each wrote a pending_steers row bound to the turn they will land in.
    const steers = await target.pendingSteers();
    const steerFiles = await target.pendingSteerFileRows();

    return v.parse(PreparedConversationSchema, { workspace, owner, bFrame: bWire, cFrame: cWire, steers, steerFiles });
  }

  /** The reset half: a fresh socket to the SAME object replays B's and C's
   *  exact frames. Each replay is a re-delivery of a reservation the object
   *  already holds — the durable pending_steers row, not the socket, binds it
   *  to the turn. Returns the post-reset ledger: the pending-steer
   *  reservations and their file rows. */
  async replayQueuedConversation(prepared: PreparedConversation): Promise<{ steers: PendingSteer[]; steerFiles: PendingSteerFile[] }> {
    const target: QueueTarget = await this.queueTarget(prepared.workspace);

    const response = await target.fetch(new Request(
      `https://probe/agents/orchestrator-agent/${prepared.workspace}`,
      { headers: { Upgrade: 'websocket' } },
    ));

    const socket = response.webSocket;

    if (response.status !== 101 || socket === null) throw new Error('replay did not receive a real WebSocket');
    socket.accept();

    try {
      socket.send(prepared.bFrame);
      socket.send(prepared.cFrame);
    } finally {
      socket.close(1000, 'replayed');
    }

    return { steers: await target.pendingSteers(), steerFiles: await target.pendingSteerFileRows() };
  }

  /** The join: release the held model call and wait on the queued turn's own
   *  completion evidence, then return the wire log, the two durable ledgers —
   *  the pending-steer reservations and the file rows any attachment left
   *  beside them — the transcript the drain wrote the landed sends into, and
   *  every run close the ledger holds. */
  async completeQueuedConversation(prepared: PreparedConversation): Promise<{ http: HttpCall[]; steers: PendingSteer[]; steerFiles: PendingSteerFile[]; transcript: SocketHistory; runEnds: Array<{ runId: string; reason: string }> }> {
    const target: QueueTarget = await this.queueTarget(prepared.workspace);

    const recording = createRecordingLogger();
    const restore = setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), recording]));

    try {
      // The fake logged the held call when it arrived, before the reset killed
      // the object that made it; only the calls the restarted object makes are
      // this half's measurement.
      await this.httpReset();
      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });
      // ONE turn: the re-opened genesis turn, with B and C landed at its first
      // step — the step boundary both were waiting for when the reset came.
      await awaitSleepTimeSettled(recording, 1);
      await awaitQuiet(recording);

      return {
        http: await this.httpCalls(), steers: await target.pendingSteers(), steerFiles: await target.pendingSteerFileRows(),
        transcript: await this.socketHistory(target, prepared.workspace),
        runEnds: await target.runEnds(),
      };
    } finally {
      restore();
    }
  }

  // ── The parity drive ────────────────────────────────────────────────────
  //
  // One scripted conversation over real sockets, the same script the local
  // backend's `chat-session-parity.ts` runs: an idle send, a send mid-turn
  // carrying a file, an interrupt, a tool-calling turn evicted after its tool
  // step settled and its answer had begun, a send acknowledged mid-turn before
  // the eviction, and the restart. `parityPrepare` runs to the instant of the
  // eviction and hands back everything durable plus every frame the sockets
  // saw; the test evicts; `parityComplete` reconnects, resumes, and finishes.

  /** A socket that records every frame it receives, in order, under a name. */
  private async paritySocket(
    target: QueueTarget, workspace: string, name: string, frames: ParityFrame[],
  ): Promise<{ socket: WebSocket; done: (id: string) => Promise<ParityFrame>; seen: (match: (frame: ParityFrame) => boolean, what: string) => Promise<void> }> {
    const response = await target.fetch(new Request(`https://probe/agents/orchestrator-agent/${workspace}`, {
      headers: { Upgrade: 'websocket' },
    }));

    const socket = response.webSocket;

    if (response.status !== 101 || socket === null) throw new Error(`parity socket ${name} did not open`);
    socket.accept();
    const waiters = new Map<string, ReturnType<typeof Promise.withResolvers<ParityFrame>>>();

    socket.addEventListener('message', (event) => {
      const raw = v.is(v.string(), event.data) ? event.data : '';

      if (!raw.startsWith('{')) return;

      const parsed = v.safeParse(v.looseObject({
        type: v.string(), id: v.optional(v.string()), done: v.optional(v.boolean()), error: v.optional(v.boolean()),
        landed: v.optional(v.string()), replay: v.optional(v.boolean()), continuation: v.optional(v.boolean()),
        body: v.optional(v.string()), steerId: v.optional(v.string()), status: v.optional(v.string()),
      }), JSON.parse(raw));

      if (!parsed.success) return;
      const { type, id, done, error, landed, replay, continuation, body, steerId, status } = parsed.output;

      const frame = v.parse(ParityFrameSchema, {
        socket: name, type,
        ...(id !== undefined && { id }), ...(done !== undefined && { done }), ...(error !== undefined && { error }),
        ...(landed !== undefined && { landed }), ...(replay !== undefined && { replay }),
        ...(continuation !== undefined && { continuation }),
        ...(body !== undefined && body !== '' && { body }),
        ...(steerId !== undefined && { steerId }), ...(status !== undefined && { status }),
      });

      frames.push(frame);

      // A done frame resolves the waiter for its request whether that waiter
      // was asked for before or after the frame arrived: the script asks for
      // a parked turn's done only after releasing the model, and the frame can
      // land in between.
      if (type === 'cf_agent_use_chat_response' && done === true && id !== undefined) {
        const waiter = waiters.get(id) ?? Promise.withResolvers<ParityFrame>();
        waiters.set(id, waiter);
        waiter.resolve(frame);
      }
    });

    return {
      socket,
      done: (id) => {
        const waiter = waiters.get(id) ?? Promise.withResolvers<ParityFrame>();
        waiters.set(id, waiter);

        return awaitWithLimit(waiter.promise, 20000, `parity: no done frame for ${id}`);
      },
      seen: async (match, what) => {
        const began = Date.now();

        while (!frames.some(match)) {
          if (Date.now() - began > 20000) throw new Error(`parity: socket ${name} never saw ${what}`);
          const tick = Promise.withResolvers<void>();
          setTimeout(tick.resolve, 20);
          await tick.promise;
        }
      },
    };
  }

  /** The socket's word that the running turn's inbox took this message. */
  private queuedSteer(steerId: string): (frame: ParityFrame) => boolean {
    return (frame) => frame.type === 'steer_status' && frame.status === 'queued' && frame.steerId === steerId;
  }

  private parityFrame(text: string, file?: { filename: string; mediaType: string; url: string }): string {
    return JSON.stringify({
      type: 'cf_agent_use_chat_request', id: text,
      init: { method: 'POST', body: JSON.stringify({
        messages: [{ id: `input-${text}`, role: 'user', parts: [
          ...(file !== undefined ? [{ type: 'file', mediaType: file.mediaType, url: file.url, filename: file.filename }] : []),
          { type: 'text', text },
        ] }],
        trigger: 'submit-message',
      }) },
    });
  }

  private async parityModelCalls(): Promise<Array<{ users: string[]; toolResults: string[]; roles: string[] }>> {
    return (await this.httpCalls()).filter((call) => call.model === 'probe-parity').map((call) => ({
      users: call.users.filter((u) => !u.startsWith('<')),
      toolResults: call.toolResults,
      roles: call.conversation.map((m) => m.role),
    }));
  }

  async parityPrepare(): Promise<ParityPrepared> {
    const workspace = 'parity-workspace';
    const owner = 'parity-owner';
    const target: QueueTarget = await this.queueTarget(workspace);

    const caller = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(owner));
    await userDO.registerWorkspace(caller, workspace, 'Parity');
    const claim = await target.claimOwner(owner);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await userDO.setCredential(caller, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: 'http://fake-models.invalid/v1', apiKey: 'probe-fixture-key',
    });
    await target.setModel('openai-compat/probe-parity');
    await target.setSoul('# Parity\n\n## Mission\n\nFollow the owner\'s exact request.');
    await this.httpReset();
    const recording = createRecordingLogger();
    const restore = setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), recording]));
    const frames: ParityFrame[] = [];
    const landings: Record<string, string | null> = {};
    const file = { filename: 'note.txt', mediaType: 'text/plain', url: 'data:text/plain;base64,aGVsbG8=' };
    let afterTwo: ParityRows | null = null;

    try {
      const { socket, done, seen } = await this.paritySocket(target, workspace, 'A', frames);

      try {
        // 1. An idle send runs as a turn of its own.
        socket.send(this.parityFrame('PARITY-ONE'));
        landings['PARITY-ONE'] = (await done('PARITY-ONE')).landed ?? null;
        await awaitSleepTimeSettled(recording, 1);

        // 2. A send mid-turn, carrying a file, while the turn's model call is
        //    parked. The echo lane has no second step, so the steer reruns as
        //    the operator's next turn once the parked turn settles — and its
        //    request is answered by that rerun, under the steer's own id,
        //    not at admission. What admission announces is `queued`.
        await fetch('http://probe-control.invalid/parity/hold', { method: 'POST', body: JSON.stringify({ parkAt: 'first' }) });
        socket.send(this.parityFrame('PARITY-TWO'));
        await fetch('http://probe-control.invalid/parity/arrived');
        socket.send(this.parityFrame('PARITY-TWO-STEER', file));
        await seen(this.queuedSteer('input-PARITY-TWO-STEER'), 'the steer admitted into the parked turn');
        await fetch('http://probe-control.invalid/parity/release', { method: 'POST' });
        landings['PARITY-TWO'] = (await done('PARITY-TWO')).landed ?? null;
        landings['PARITY-TWO-STEER'] = (await done('PARITY-TWO-STEER')).landed ?? null;
        await awaitSleepTimeSettled(recording, 3);
        await awaitQuiet(recording);
        afterTwo = await target.parityRows();

        // 3. An interrupt while the turn's model call is parked.
        await fetch('http://probe-control.invalid/parity/hold', { method: 'POST', body: JSON.stringify({ parkAt: 'first' }) });
        socket.send(this.parityFrame('PARITY-THREE'));
        await fetch('http://probe-control.invalid/parity/arrived');
        socket.send(JSON.stringify({ type: 'cf_agent_chat_request_cancel', id: 'PARITY-THREE' }));
        landings['PARITY-THREE'] = (await done('PARITY-THREE')).landed ?? null;
        await fetch('http://probe-control.invalid/parity/release', { method: 'POST' });
        await awaitQuiet(recording);

        // 4. A tool-calling turn: its tool step settles, its answer streams one
        //    delta and parks — then a send acknowledged mid-turn, and the
        //    eviction the test performs while everything is parked.
        await fetch('http://probe-control.invalid/parity/hold', { method: 'POST', body: JSON.stringify({ parkAt: 'partial' }) });
        socket.send(this.parityFrame('PARITY-FOUR-TOOL'));
        // The join is the socket's own evidence: the tool step's settled result
        // and the answer's first delta both reached the client before anything
        // else happens, so the state the eviction cuts is the same every run.
        await fetch('http://probe-control.invalid/parity/arrived');
        await seen((frame) => frame.id === 'PARITY-FOUR-TOOL' && frame.body !== undefined && frame.body.includes('"text-delta"'), "the parked answer's first delta");
        socket.send(this.parityFrame('PARITY-FOUR-STEER', file));
        // Acknowledged, not landed: the eviction below cuts the turn before
        // any step could take the words, and the request that sent them dies
        // with the isolate. The reservation is what survives.
        await seen(this.queuedSteer('input-PARITY-FOUR-STEER'), 'the steer admitted into the parked turn');
      } finally {
        socket.close(1000, 'parity prepared');
      }

      if (afterTwo === null) throw new Error('parity: the second turn never settled');

      return v.parse(ParityPreparedSchema, {
        workspace, owner, frames, landings, afterTwo,
        beforeRestart: await target.parityRows(),
        modelCallsBefore: await this.parityModelCalls(),
      });
    } finally {
      restore();
    }
  }

  async parityComplete(prepared: ParityPrepared): Promise<ParityCompleted> {
    const target: QueueTarget = await this.queueTarget(prepared.workspace);
    const recording = createRecordingLogger();
    const restore = setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), recording]));
    const frames: ParityFrame[] = [];
    const landings: Record<string, string | null> = {};
    const callsBefore = prepared.modelCallsBefore.length;

    try {
      // 5. The reconnect: the client asks to resume, the parked producer is
      //    released (the dead activation never consumes it), the wake
      //    continues the evicted turn and replays the acknowledged steer.
      const { socket, done } = await this.paritySocket(target, prepared.workspace, 'B', frames);

      try {
        socket.send(JSON.stringify({ type: 'cf_agent_stream_resume_request' }));
        await fetch('http://probe-control.invalid/parity/release', { method: 'POST' });
        await awaitQuiet(recording);
        await awaitSleepTimeSettled(recording, 1);
        await awaitQuiet(recording);

        // 6. A fresh send on the restarted actor.
        socket.send(this.parityFrame('PARITY-FIVE'));
        landings['PARITY-FIVE'] = (await done('PARITY-FIVE')).landed ?? null;
        await awaitSleepTimeSettled(recording, 2);
        await awaitQuiet(recording);
      } finally {
        socket.close(1000, 'parity complete');
      }

      return v.parse(ParityCompletedSchema, {
        frames, landings,
        end: await target.parityRows(),
        modelCallsAfter: (await this.parityModelCalls()).slice(callsBefore),
        failures: recording.emitted.filter((e) => e.code !== null).map((e) => ({ event: e.event, code: e.code ?? '', cause: e.cause ?? '' })),
      });
    } finally {
      restore();
    }
  }

  /** The orchestrator stub, typed to the fixture class the durableObjects
   *  binding installs — `env.OrchestratorAgent` is declared against the
   *  production class in env.d.ts, so the one place the fixture names its own
   *  class is the one place the type widens. */
  private queueTarget(workspace: string): Promise<QueueTarget> {
    return getAgentByName<ProbeEnv, ObservedOrchestrator>(
      // SAFETY: the durableObjects binding declares ObservedOrchestrator under
      // the OrchestratorAgent name (the re-export at the top of this file), and
      // that class extends ProductionOrchestrator and adds pendingSteers, so
      // every stub the namespace returns carries the member the production
      // declaration does not name.
      this.env.OrchestratorAgent as DurableObjectNamespace<ObservedOrchestrator>,
      workspace,
    );
  }




  /** The durable mid-turn reservations a named workspace's actor holds — the
   *  send-path ledger the warm arm reads to prove each socket input bound its
   *  own request and no second SDK turn ran. */
  async pendingSteersFor(workspace: string): Promise<PendingSteer[]> {
    const target: QueueTarget = await this.queueTarget(workspace);

    return await target.pendingSteers();
  }

  /** The event-redelivery drive's workspace: a real owner claim, compat
   *  credential and pinned queue model — the same claim every queue mode
   *  opens with. */
  async claimEventWorkspace(): Promise<{ workspace: string; owner: string }> {
    const { workspace, owner } = await this.claimQueueWorkspace('evt');

    return { workspace, owner };
  }

  /** The event rows an unbindStale sweep would see, for one workspace. */
  async agentLogEventsFor(workspace: string): Promise<AgentLogEvent[]> {
    const target: QueueTarget = await this.queueTarget(workspace);

    return await target.agentLogEvents();
  }

  /** Seed the state a dead activation leaves: an event bound to a drain turn
   *  whose lease outlived it, stale past every grace. */
  async seedStaleDrainEventFor(workspace: string, marker: string): Promise<void> {
    const target: QueueTarget = await this.queueTarget(workspace);

    await target.seedStaleDrainEvent(marker);
  }

  /** Drive the wake frame the platform alarm would run: re-pend the stale
   *  leases, then drain whatever is pending. */
  async runEventWakeFor(workspace: string, marker: string): Promise<void> {
    const target: QueueTarget = await this.queueTarget(workspace);

    await target.runEventWake(marker);
  }

  /**
   * The reactor-wake drive's workspace, claimed and left IDLE: no genesis
   * turn, no due trigger, nothing owed. The state an external event actually
   * arrives in for a workspace nobody is talking to.
   */
  async claimReactorWakeWorkspace(): Promise<{ workspace: string; owner: string }> {
    const { workspace, owner } = await this.claimQueueWorkspace('rwake');

    return { workspace, owner };
  }

  /**
   * One real external event through a real ingress, and the wake it armed.
   *
   * `receivePeerMessage` is the shipped cross-DO receiver: it gates the sender,
   * publishes through `EventLog.publish`, and calls the `onAdmitted` the
   * production orchestrator wires to `scheduleDrain` — so both halves of the
   * ingress contract run, the in-memory debounce and the durable arm. Nothing
   * is hand-inserted into `agent_log`.
   *
   * The armed rows are read back in the SAME call, before the caller can evict:
   * they are what the fold decided, and the verdict on a two-chain actor is
   * which callback carries it.
   */
  async publishPeerEvent(workspace: string, owner: string, body: string): Promise<ArmedWake[]> {
    const target: QueueTarget = await this.queueTarget(workspace);

    const admitted = await target.receivePeerMessage({
      sender_event_id: `rwake-${body}`, sender_agent_name: 'rwake-peer', sender_user_id: owner,
      topic: 'reactor-wake', body, mode: 'build', reply_expected: false,
    });

    if (!admitted.admitted) throw new Error(`reactor-wake probe peer input refused: ${admitted.reason}`);

    return await target.armedWakeRows();
  }

  /** The wake registry of one workspace, after an eviction: the rows that
   *  survived, which is what the platform would deliver next. */
  async armedWakesFor(workspace: string): Promise<ArmedWake[]> {
    const target: QueueTarget = await this.queueTarget(workspace);

    return await target.armedWakeRows();
  }

  /** Deliver one lap of whatever this workspace armed, and answer which
   *  callbacks ran — the product's own frames, chosen by its own registry. */
  async driveArmedWakesFor(workspace: string): Promise<string[]> {
    const target: QueueTarget = await this.queueTarget(workspace);

    return await target.driveArmedWakes();
  }

  /** What opened every run this workspace recorded. */
  async runStartCausesFor(workspace: string): Promise<string[]> {
    const target: QueueTarget = await this.queueTarget(workspace);

    return await target.runStartCauses();
  }

  /** Park until the model wire has carried `marker`. Called only after the
   *  durable row already proved the drain bound the event, so the join has a
   *  reached condition behind it rather than a hope. */
  async awaitWireMarker(marker: string): Promise<void> {
    await fetch(`http://probe-control.invalid/log/until?marker=${encodeURIComponent(marker)}`);
  }

  /** A fresh workspace's first chat: the claim, the socket's real
   *  first-run bench never saw. Returns the model-call count and the turn's
   *  terminal evidence so the test can say where the drive stopped. */
  async firstChat(): Promise<{ http: HttpCall[]; steers: PendingSteer[]; transcript: SocketHistory; sleepTimeSettled: number }> {
    const workspace = 'first-chat-workspace';
    const owner = 'first-chat-owner';
    const target: QueueTarget = await this.queueTarget(workspace);

    const caller = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(owner));
    await userDO.registerWorkspace(caller, workspace, 'First Chat');
    const claim = await target.claimOwner(owner);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await userDO.setCredential(caller, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: 'http://fake-models.invalid/v1', apiKey: 'probe-fixture-key',
    });
    await target.setModel('openai-compat/probe-queue');
    await target.setSoul('# First Chat\n\n## Mission\n\nAnswer briefly.');
    await this.httpReset();

    const recording = createRecordingLogger();
    const restore = setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), recording]));

    try {
      // One real chat frame — the same wire the composer's first prompt puts
      // on the socket. No held genesis, no queue arm: the first-run repro is
      // whether this one intake reaches the model.
      const { wire } = await this.sendChatFrame(target, workspace, 'FIRST-CHAT');

      void wire;

      // The model call, if it happens, is the discriminating datum — wait on
      // it directly rather than on the turn's settle, which the stall never
      // reaches.
      const began = Date.now();

      for (;;) {
        const calls = (await this.httpCalls()).filter((call) => call.model === 'probe-queue');

        if (calls.length > 0) break;

        if (Date.now() - began > 20000) break; // stall is the finding, not a hang
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }

      return {
        http: await this.httpCalls(),
        steers: await target.pendingSteers(),
        transcript: await this.socketHistory(target, workspace),
        sleepTimeSettled: sleepTimeSettled(recording.emitted),
      };
    } finally {
      restore();
    }
  }


  /**
   * TWO CLIENTS, ONE MESSAGE, AT ONCE: two sockets on one conversation each
   * put the same chat frame — the same client message id — on the wire with
   * no await between them. The property is the object's, not the browser's:
   * a message admitted once is one turn, one provider request and one row,
   * however many sockets delivered it. `send-admission.test.ts` proved this
   * on the retired submission surface; the loop's admission (`admitted` on
   * the wire, the pending-send ledger) owns it now.
   */
  async twinSends(): Promise<{ http: HttpCall[]; transcript: SocketHistory; steers: PendingSteer[]; runEnds: Array<{ runId: string; reason: string }> }> {
    const { target, workspace } = await this.claimQueueWorkspace('twin');
    const recording = createRecordingLogger();
    const restore = setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), recording]));
    const sockets: WebSocket[] = [];

    try {
      for (const tab of ['a', 'b']) {
        const response = await target.fetch(new Request(`https://probe/agents/orchestrator-agent/${workspace}`, {
          headers: { Upgrade: 'websocket' },
        }));

        if (response.status !== 101 || response.webSocket === null) throw new Error(`twin probe tab ${tab} did not receive a real WebSocket`);
        response.webSocket.accept();
        sockets.push(response.webSocket);
      }

      const wire = JSON.stringify({
        type: 'cf_agent_use_chat_request', id: 'TWIN',
        init: { method: 'POST', body: JSON.stringify({
          messages: [{ id: 'input-TWIN', role: 'user', parts: [{ type: 'text', text: 'TWIN' }] }],
          trigger: 'submit-message',
        }) },
      });

      for (const socket of sockets) socket.send(wire);

      // The turn's own settle is the end condition; a second admitted turn
      // would compress its facts too, so the count below is the count that
      // discriminates.
      await awaitSleepTimeSettled(recording, 1);
      await awaitQuiet(recording);

      return {
        http: await this.httpCalls(),
        transcript: await this.socketHistory(target, workspace),
        steers: await target.pendingSteers(),
        runEnds: await target.runEnds(),
      };
    } finally {
      for (const socket of sockets) socket.close(1000, 'twin probe complete');
      restore();
    }
  }

  /**
   * THE EVAL-ONLY ABORT ends an activation the way the platform does: the
   * stub call that asked rejects (that rejection is the receipt), and the
   * next request over a fresh stub finds the object alive again over the same
   * storage. Measured here because the first-run `background-wake` row rests
   * on it and the deployed build cannot be driven by `abortAllDurableObjects`.
   */
  async evalAbort(): Promise<{ receipt: string | null; alive: boolean }> {
    const { target, workspace } = await this.claimQueueWorkspace('twin');
    let receipt: string | null = null;

    try {
      await target.evalAbortActivation();
    } catch (cause) {
      receipt = cause instanceof Error ? cause.message : String(cause);
    }

    const fresh: QueueTarget = await this.queueTarget(workspace);
    await fresh.workspaceTitle();

    return { receipt, alive: true };
  }

  /**
   * THE AGENT TAB, as the browser opens one: the workspace mints a hired
   * actor the way the tab strip's "+" does (`createSubordinateAgent`), then a
   * socket is opened on that actor's OWN chat path and the two reads the tab
   * makes on mount are asked over it — `getActorSnapshot` and
   * `listAgentTasks`.
   *
   * The path is the point. On build cba44dcb9 the client built
   * a facet hop instead (the Agents SDK's `sub` option), which this transport
   * refuses, so the socket never opened and both reads timed out at the SDK's
   * 30 s backstop. Here the request goes to the object exactly as the edge
   * hands it over, and the answers are the proof.
   */
  async hostedActorTab(): Promise<{ name: string; snapshot: string; tasks: string; frames: number }> {
    const { target, workspace } = await this.claimQueueWorkspace('twin');
    const created = v.parse(v.object({ name: v.string() }), await target.createSubordinateAgent());
    const path = `https://probe/agents/orchestrator-agent/${workspace}/${hostedActorSocketPath(created.name)}`;
    const response = await target.fetch(new Request(path, { headers: { Upgrade: 'websocket' } }));
    const socket = response.webSocket;

    if (response.status !== 101 || socket === null) throw new Error(`the hosted actor path answered ${String(response.status)}, not a socket`);
    socket.accept();
    // The answers are carried back as their JSON text: a stub return of the
    // recursive JsonValue type is a type the compiler cannot instantiate
    // through the RPC boundary, and the reads under test are what the frames
    // say, which the text holds exactly.
    const answers = new Map<string, string>();
    const arrived = Promise.withResolvers<void>();
    let frames = 0;

    socket.addEventListener('message', (event) => {
      frames += 1;
      const raw = v.is(v.string(), event.data) ? event.data : '';

      const frame = v.safeParse(v.looseObject({ type: v.string(), id: v.string(), result: v.optional(JsonValueSchema), error: v.optional(v.string()) }),
        raw.startsWith('{') ? JSON.parse(raw) : {});

      if (!frame.success || frame.output.type !== 'rpc') return;
      answers.set(frame.output.id, frame.output.error === undefined
        ? JSON.stringify(frame.output.result ?? null)
        : `ERROR ${frame.output.error}`);

      if (answers.size === 2) arrived.resolve();
    });

    try {
      socket.send(JSON.stringify({ type: 'rpc', id: 'tab-snapshot', method: 'getActorSnapshot', args: [created.name] }));
      socket.send(JSON.stringify({ type: 'rpc', id: 'tab-tasks', method: 'listAgentTasks', args: [] }));
      await arrived.promise;

      return {
        name: created.name,
        snapshot: answers.get('tab-snapshot') ?? '',
        tasks: answers.get('tab-tasks') ?? '',
        frames,
      };
    } finally {
      socket.close(1000, 'agent tab probe complete');
    }
  }

  /** The first-run regression: a workspace born with a mission (genesis turn
   *  running) receives its owner's first chat — which lands as a mid-turn
   *  steer — and the resume after genesis settles must reach the model. */
  async firstChatAfterGenesis(): Promise<{ http: HttpCall[]; steers: PendingSteer[]; inbox: { busy: boolean }; landed: string | null; transcript: SocketHistory; failures: Array<{ event: string; code: string; cause: string }> }> {
    const workspace = 'first-gen-workspace';
    const owner = 'first-gen-owner';
    const target: QueueTarget = await this.queueTarget(workspace);

    const caller = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(owner));
    await userDO.registerWorkspace(caller, workspace, 'First Gen');
    const claim = await target.claimOwner(owner);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await userDO.setCredential(caller, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: 'http://fake-models.invalid/v1', apiKey: 'probe-fixture-key',
    });
    await target.setModel('openai-compat/probe-queue');
    await target.setSoul('# First Gen\n\n## Mission\n\nAnswer briefly.');
    await this.httpReset();

    const recording = createRecordingLogger();
    setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), recording]));
    // A real genesis turn — the shape create-with-mission leaves. No hold:
    // the first-run stall is a FIRST turn that admits but never calls the
    // model, so genesis runs to its own completion while the owner chat lands
    // inside it (a steer) and is answered by that same turn.
    const genesis = await target.beginGenesisTurn();

    if (!genesis.started) throw new Error('first-gen probe genesis did not start');

    const { landed } = await this.sendChatFrame(target, workspace, 'FIRST-PROMPT');

    // The first prompt is a steer on the live genesis turn: it lands inside
    // that turn's step, not behind it — one model call carries both. Wait on
    // the call AND the turn's close (busy falls when genesis settles) so the
    // landed row and the retired steer are both observable before the read.
    const began = Date.now();

    for (;;) {
      const calls = (await this.httpCalls()).filter((call) => call.model === 'probe-queue');
      const inbox = await target.inboxState();

      if (calls.length >= 1 && !inbox.busy) break;

      if (Date.now() - began > 30000) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    return {
      http: await this.httpCalls(),
      steers: await target.pendingSteers(),
      inbox: await target.inboxState(),
      landed,
      transcript: await this.socketHistory(target, workspace),
      failures: recording.emitted
        .filter((e) => e.code !== null)
        .map((e) => ({ event: e.event, code: e.code ?? 'unclassified', cause: e.cause ?? '' })),
    };
  }

  /**
   * ONE RAW CHAT FRAME PUT ON A BUSY CONVERSATION.
   *
   * The pinned model answers its first call with a real tool call, so the
   * held turn HAS a second step — the boundary a mid-turn send lands at —
   * and the provider is parked on that turn's first call while the frame
   * goes out under the CLIENT's own message id.
   *
   * Everything returned is what the surface itself could see: what the
   * admission announced while the turn still ran, the reservation it wrote,
   * whether the words reached the transcript instead, how the request was
   * answered once the words landed, the `steer_status` landings broadcast
   * to the socket, the provider calls, and the assistant rows the drive
   * ended with.
   */
  async rawChat(): Promise<RawChatProbeResult> {
    const workspace = 'raw-steer-workspace';
    const owner = 'raw-steer-owner';
    const target: QueueTarget = await this.queueTarget(workspace);

    const caller = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(owner));
    await userDO.registerWorkspace(caller, workspace, 'Raw Chat Probe');
    const claim = await target.claimOwner(owner);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await userDO.setCredential(caller, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: 'http://fake-models.invalid/v1', apiKey: 'probe-fixture-key',
    });
    await target.setModel('openai-compat/probe-steer');
    await target.setSoul('# Raw Chat Probe\n\n## Mission\n\nFollow the owner\'s exact request.');
    await this.httpReset();
    await fetch('http://probe-control.invalid/queue/hold', { method: 'POST', body: JSON.stringify({ from: 1 }) });

    const recording = createRecordingLogger();
    const restore = setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), recording]));
    const frames: v.InferOutput<typeof RawChatFrameSchema>[] = [];
    const admitted = Promise.withResolvers<string>();
    const answered = Promise.withResolvers<string>();
    let socket: WebSocket | null = null;

    try {
      const response = await target.fetch(new Request(`https://probe/agents/orchestrator-agent/${workspace}`, {
        headers: { Upgrade: 'websocket' },
      }));

      socket = response.webSocket;

      if (response.status !== 101 || socket === null) throw new Error('raw chat probe did not receive a real WebSocket');
      socket.accept();
      socket.addEventListener('message', (event) => {
        const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), RawChatFrameSchema), event.data);

        if (!parsed.success) return;
        frames.push(parsed.output);

        if (parsed.output.type === 'steer_status' && parsed.output.steerId === 'raw-client-id' && parsed.output.status === 'queued') {
          admitted.resolve(parsed.output.status);
        }

        if (parsed.output.type === 'cf_agent_use_chat_response' && parsed.output.id === 'raw-request'
          && parsed.output.done === true) {
          answered.resolve(parsed.output.landed ?? 'closed');
        }
      });

      const genesis = await target.beginGenesisTurn();

      if (!genesis.started) throw new Error('raw chat probe genesis did not start');
      // The turn's first provider call is parked in the fake: everything
      // below happens while the conversation is genuinely busy.
      await fetch('http://probe-control.invalid/queue/arrived');
      socket.send(JSON.stringify({
        type: 'cf_agent_use_chat_request', id: 'raw-request',
        init: { method: 'POST', body: JSON.stringify({
          trigger: 'submit-message',
          messages: [{ id: 'raw-client-id', role: 'user', parts: [{ type: 'text', text: 'RAW-STEER' }] }],
        }) },
      }));

      // The admission's own broadcast is the signal: the running turn's inbox
      // announces the words `queued` under the client's id while the provider
      // call is still parked, and only then are the durable traces read — the
      // reservation under that id, and whether the words reached the
      // transcript as a turn of their own instead. The hold stays armed until
      // this frame arrives, so words the object does not take hang here and
      // the row fails on its clock. The request itself is answered later, at
      // the step that takes the words: the landing is decided there, never at
      // admission.
      const admission = await admitted.promise;
      const persistedWhileHeld = (await this.socketHistory(target, workspace)).some((row) => row.id === 'raw-client-id');
      const pendingIds = (await target.pendingSteers()).map((row) => row.id);

      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });
      const landing = await answered.promise;
      // ONE turn when the words landed inside it; a second turn when they
      // could only run after it — each turn settles its own sleep-time lane.
      await awaitSleepTimeSettled(recording, persistedWhileHeld ? 2 : 1);
      await awaitQuiet(recording);

      return {
        admission, landing, pendingIds, persistedWhileHeld,
        landed: frames.flatMap((frame) => frame.type === 'steer_status' && frame.status === 'landed'
          && frame.steerId !== undefined && frame.text !== undefined && frame.atStep !== undefined
          ? [{ id: frame.steerId, text: frame.text, atStep: frame.atStep }]
          : []),
        calls: (await this.httpCalls()).filter((call) => call.model === 'probe-steer'),
        answerCount: (await this.socketHistory(target, workspace)).filter((row) => row.role === 'assistant').length,
      };
    } finally {
      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });
      socket?.close(1000, 'raw chat probe complete');
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

      await awaitSleepTimeSettled(recording, 1);
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
        sleepTimeSettled: sleepTimeSettled(recording.emitted),
        catalogFallbacks: recording.emitted.filter((e) => e.event === 'models_dev.catalog_fallback').length,
        catalogHits: (await this.probeLog()).catalogHits,
      });
    } finally {
      restore();
    }
  }
}
