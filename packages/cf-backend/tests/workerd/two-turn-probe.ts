/**
 * Two-turn probe: the real OrchestratorAgent drives two full Think turns against a
 * fake `AI` WorkerEntrypoint, answering each lane (turn, sleep-time judge, title) by
 * request shape, never prompt text. Defends (2026-09-08): a transcript count naming a
 * missing column, and the second turn's request dropping the message that started it.
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
  type RecordedLog,
  type RecordingLogger,
} from '@kinu.run/core/obs';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import type {
  AgentLogEvent,
  CallRecord,
  DriveOnceInput,
  DriveOnceResult,
  ExerciseResult,
  HistoryResult,
  HttpCall,
  ParityCompleted,
  ParityFrame,
  ParityPrepared,
  ParityRows,
  PendingSteer,
  PendingSteerFile,
  PreparedConversation,
  QueuedConversation,
  QueueProbeMode,
  RawChatProbeResult,
  ReactorEviction,
  ReactorWake,
} from './two-turn-shapes';
import {
  DriveOnceInputSchema,
  DriveOnceResultSchema,
  ExerciseResultSchema,
  HistorySchema,
  HttpCallSchema,
  ParityCompletedSchema,
  ParityFrameSchema,
  ParityPreparedSchema,
  ParityRowsSchema,
  PreparedConversationSchema,
  TurnSchema,
  ReactorEvictionSchema,
  WakeDriveResultSchema,
  WakeRowsSchema,
  WAKE_MARKER,
  type WakeDriveResult,
  type WakeHoldPlacement,
  type WakeRows,
} from './two-turn-shapes';
import { ownerCaller, type PeerMessage, type WorkMode } from '@kinu.run/core';
import type { ToolSet } from 'ai';

// Re-exported under production names so the auxiliary worker binds the shipped
// classes, as slate-actor-probe.ts:43-48 does.
export { UserDO } from '../../src/user/user-do';

/** DO SQLite types columns as `ArrayBuffer | string | number | null`; refuse a blob at the read. */
const textColumn = (value: SqlStorageValue): string => v.parse(v.string(), value);

/** The production orchestrator plus fixture reads; adds no production method or state,
 *  only retains DurableObjectState to observe the durable send ledger. */
export class ObservedOrchestrator extends ProductionOrchestrator {
  private readonly actorState: AgentContext;

  constructor(ctx: AgentContext, env: ProbeEnv) {
    super(ctx, env);
    this.actorState = ctx;
    Reflect.deleteProperty(this, 'chatHistoryPage');
    Reflect.deleteProperty(this, 'pendingSteers');
    Reflect.deleteProperty(this, 'pendingSteerFileRows');
    Reflect.deleteProperty(this, 'agentLogEvents');
    Reflect.deleteProperty(this, 'inboxState');
    Reflect.deleteProperty(this, 'runEnds');
    Reflect.deleteProperty(this, 'seedStaleDrainEvent');
    Reflect.deleteProperty(this, 'runEventWake');
    Reflect.deleteProperty(this, 'parityRows');
    Reflect.deleteProperty(this, 'wakeRows');
    Reflect.deleteProperty(this, 'receivePeerThenEvict');
    Reflect.deleteProperty(this, 'timerTickFinished');
    Reflect.deleteProperty(this, 'runCauses');
    Reflect.deleteProperty(this, 'drainRunClosed');
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'chatHistoryPage', 'pendingSteers', 'pendingSteerFileRows', 'agentLogEvents', 'inboxState', 'runEnds', 'seedStaleDrainEvent', 'runEventWake', 'parityRows', 'wakeRows', 'receivePeerThenEvict', 'timerTickFinished', 'runCauses', 'drainRunClosed']);
  }

  /** Parks a turn-end extension over `/wake/wait`, holding the settle window open
   *  (between the answer's commit and the pump's next item). */
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

  /** Only the execute is the probe's; schema, wrap and runner are the product's. */
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

  /** Runs inside the object: `DurableObjectStub`'s mapping of `Page<ChatHistoryEntry>`
   *  overflows TypeScript's instantiation depth at the caller. */
  async chatHistoryPage(): Promise<HistoryResult> {
    return v.parse(HistorySchema, await this.getChatHistoryPage({}));
  }

  async wakeRows(): Promise<WakeRows> {
    const sql = this.actorState.storage.sql;

    return v.parse(WakeRowsSchema, {
      jobs: sql.exec('SELECT id, kind, status, result, settled_at FROM background_jobs ORDER BY created_at').toArray()
        .map((row) => ({
          id: textColumn(row.id), kind: textColumn(row.kind), status: textColumn(row.status),
          result: row.result === null ? null : textColumn(row.result), settledAt: row.settled_at === null ? null : Number(row.settled_at),
        })),
      runs: sql.exec("SELECT run_id, type, payload FROM run_events WHERE type IN ('run_start', 'run_end') ORDER BY rowid").toArray()
        .reduce<Array<{ runId: string; userMessage: string; reason: string | null }>>((runs, row) => {
          const payload = v.parse(v.looseObject({ userMessage: v.optional(v.string()), reason: v.optional(v.string()) }), JSON.parse(textColumn(row.payload)));

          if (textColumn(row.type) === 'run_start') runs.push({ runId: textColumn(row.run_id), userMessage: payload.userMessage ?? '', reason: null });
          else {
            const run = runs.find((candidate) => candidate.runId === textColumn(row.run_id));

            if (run !== undefined) run.reason = payload.reason ?? null;
          }

          return runs;
        }, []),
      assistantTexts: await this.assistantTexts(),
    });
  }

  private async assistantTexts(): Promise<string[]> {
    const texts: string[] = [];

    for (const entry of this.chatTranscript.ancestry()) {
      if (entry.role !== 'assistant') continue;
      const projected = await this.chatTranscript.project(entry.id);

      if (projected !== null) texts.push(projected.content);
    }

    return texts;
  }

  private async conversationRows(): Promise<ParityRows['assistantMessages']> {
    const rows: ParityRows['assistantMessages'] = [];

    for (const entry of this.chatTranscript.ancestry()) {
      const message = await this.chatTranscript.message(entry.id);

      if (message !== null) rows.push({ id: entry.id, parentId: entry.parentId, role: entry.role, content: JSON.stringify(message) });
    }

    return rows;
  }

  /** The row a reset must restore so a replayed frame keeps its token. */
  async pendingSteers(): Promise<PendingSteer[]> {
    return this.actorState.storage.sql
      .exec('SELECT actor_id, id, turn_id, mode, text FROM pending_steers ORDER BY actor_id, id')
      .toArray()
      .map((row) => ({
        actorId: textColumn(row.actor_id),
        id: textColumn(row.id),
        turnId: row.turn_id === null ? null : textColumn(row.turn_id),
        mode: textColumn(row.mode),
        text: textColumn(row.text),
      }));
  }

  async pendingSteerFileRows(): Promise<PendingSteerFile[]> {
    return this.actorState.storage.sql
      .exec('SELECT actor_id, steer_id, filename, media_type, url FROM pending_steer_files ORDER BY actor_id, steer_id, seq')
      .toArray()
      .map((row) => ({
        actorId: textColumn(row.actor_id),
        steerId: textColumn(row.steer_id),
        filename: textColumn(row.filename),
        mediaType: textColumn(row.media_type),
        url: textColumn(row.url),
      }));
  }

  async agentLogEvents(): Promise<AgentLogEvent[]> {
    return this.actorState.storage.sql
      .exec("SELECT id, turn_id, consumed_at, variant FROM agent_log WHERE kind = 'event' ORDER BY id")
      .toArray()
      .map((row) => ({
        id: textColumn(row.id),
        turnId: row.turn_id === null ? null : textColumn(row.turn_id),
        consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
        variant: textColumn(row.variant),
      }));
  }


  /** The public `busy` getter `routeBusyChat` consults. */
  /** A run the loop continues after a reset closes exactly once, by the loop. */
  async runEnds(): Promise<Array<{ runId: string; reason: string }>> {
    return this.actorState.storage.sql
      .exec(`SELECT run_id, payload FROM run_events WHERE type = 'run_end' ORDER BY ts, rowid`)
      .toArray()
      .map((row) => ({
        runId: textColumn(row.run_id),
        reason: v.parse(v.object({ reason: v.string() }), JSON.parse(textColumn(row.payload))).reason,
      }));
  }

  async inboxState(): Promise<{ busy: boolean }> {
    return { busy: this.orch.inbox.busy };
  }

  /** Read raw in table order, so the test's normalizer alone decides what "the same" means. */
  async parityRows(): Promise<ParityRows> {
    const sql = this.actorState.storage.sql;

    return v.parse(ParityRowsSchema, {
      assistantMessages: await this.conversationRows(),
      pendingSteers: await this.pendingSteers(),
      pendingSteerFiles: await this.pendingSteerFileRows(),
      agentLog: sql.exec('SELECT id, kind, turn_id, variant, consumed_at, payload FROM agent_log ORDER BY rowid').toArray()
        .map((row) => ({
          id: textColumn(row.id), kind: textColumn(row.kind), turnId: row.turn_id === null ? null : textColumn(row.turn_id),
          variant: row.variant === null ? null : textColumn(row.variant), consumed: row.consumed_at !== null, payload: textColumn(row.payload),
        })),
      terminalEffects: sql.exec('SELECT sequence_id, effect_key, effect_name, scope, seq, input_json, lane, status, outcome, attempts, settled_at FROM terminal_effects ORDER BY rowid').toArray()
        .map((row) => ({
          sequenceId: textColumn(row.sequence_id), effectKey: textColumn(row.effect_key), effectName: textColumn(row.effect_name), scope: textColumn(row.scope),
          seq: Number(row.seq), input: textColumn(row.input_json), lane: textColumn(row.lane), status: textColumn(row.status),
          outcome: row.outcome === null ? null : textColumn(row.outcome), attempts: Number(row.attempts), settled: row.settled_at !== null,
        })),
      runEvents: sql.exec("SELECT run_id, type, payload FROM run_events WHERE type IN ('run_start', 'step_finish', 'tool_call_end', 'run_end') ORDER BY rowid").toArray()
        .map((row) => ({ runId: textColumn(row.run_id), type: textColumn(row.type), payload: textColumn(row.payload) })),
    });
  }
  /** `consumed_at = 0` is older than any grace, so the next wake's unbindStale must re-pend it. */
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

  /** unbindStale then drain, as the platform alarm runs them; joins on the marker reaching
   *  the wire log, so a wake that never re-delivers hangs until the row's deadline. */
  async runEventWake(marker: string): Promise<void> {
    await this.owedDeliveryWork();
    await this.orch.drainPendingEvents({ rethrow: true });
    await fetch(`http://probe-control.invalid/log/until?marker=${encodeURIComponent(marker)}`);
  }

  /**
   * The shipped receiver, then this activation's eviction, as one critical section. The row an arrival
   * arms comes due at the next whole second, when the platform delivers it; blocking concurrency keeps
   * that alarm out until the abort, however late the section runs. A timer armed inside the section is
   * not held back, so the section never starts one: the abort would drop scheduleDrain's debounce anyway,
   * and a debounce that fired first would drain on the wrong evidence. The detached durable arm is joined
   * and synced first, since an abort drops writes not yet durable. The rows ride the abort's reason.
   */
  async receivePeerThenEvict(msg: PeerMessage): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.host.setTimer = () => undefined;
      const armedBefore = (await this.listSchedules()).map((row) => row.callback);
      const admitted = await this.receivePeerMessage(msg);

      if (!admitted.admitted) throw new Error(`reactor-wake probe peer input refused: ${admitted.reason}`);
      await this.settleBackgroundTasks();
      await this.ctx.storage.sync();
      const armedAfter = (await this.listSchedules()).map((row) => row.callback);
      const evictedWith = (await this.agentLogEvents()).filter((row) => row.variant === 'peer_agent');

      this.ctx.abort(`${REACTOR_EVICTION}${JSON.stringify({ armedBefore, armedAfter, evictedWith })}`);
    });
  }

  /** Settled by the first `_kinuTimerTick` this activation finishes, whoever delivered it. */
  private readonly firstTimerTick = Promise.withResolvers<void>();

  override async _kinuTimerTick(...args: Parameters<ProductionOrchestrator['_kinuTimerTick']>): Promise<void> {
    try {
      await super._kinuTimerTick(...args);
    } finally {
      this.firstTimerTick.resolve();
    }
  }

  async timerTickFinished(): Promise<void> {
    await this.firstTimerTick.promise;
  }

  /** Each run's cause in start order, and whether it closed; a drain turn is `caused_by: 'event_drain'`. */
  async runCauses(): Promise<Array<{ cause: string; closed: boolean }>> {
    const sql = this.actorState.storage.sql;

    const closed = new Set(sql.exec("SELECT run_id FROM run_events WHERE type = 'run_end'").toArray()
      .map((row) => textColumn(row.run_id)));

    return sql.exec("SELECT run_id, payload FROM run_events WHERE type = 'run_start' ORDER BY rowid").toArray()
      .map((row) => ({
        cause: v.parse(
          v.fallback(v.looseObject({ caused_by: v.fallback(v.string(), '') }), { caused_by: '' }),
          JSON.parse(textColumn(row.payload)),
        ).caused_by,
        closed: closed.has(textColumn(row.run_id)),
      }));
  }

  /**
   * Every run's cause once an `event_drain` run has closed, read from this workspace's own ledger (the model
   * log and the diagnostics sink are shared by every workspace). Each read follows a fresh signal that the
   * next recorded `run_end` settles, so a close between the read and the wait is still seen; the runner's
   * deadline ends a close that never comes.
   */
  async drainRunClosed(): Promise<string[]> {
    let recorded = Promise.withResolvers<void>();

    const stop = this.eventRecorder.observe((event) => {
      if (event.type === 'run_end') recorded.resolve();
    });

    try {
      for (;;) {
        const next = Promise.withResolvers<void>();

        recorded = next;
        const runs = await this.runCauses();

        if (runs.some((run) => run.cause === 'event_drain' && run.closed)) return runs.map((run) => run.cause);
        await next.promise;
      }
    } finally {
      stop();
    }
  }
}

export { ObservedOrchestrator as OrchestratorAgent };

/** The shape `bindingInputs` hands the binding (direct-workers-ai-fetch.ts:209-227):
 *  a turn carries `stream: true`; completion lanes `stream: false`. */
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

/** `signal` stays `unknown` because what it arrives as is the spike's measurement. */
interface RunOptions {
  readonly signal?: unknown;
  readonly returnRawResponse?: boolean;
  readonly extraHeaders?: Record<string, string>;
}

interface AIRunner {
  run(model: string, inputs: RunInputs, options?: RunOptions): Promise<Response | ReadableStream<Uint8Array> | object>;
}


const recordedCalls: CallRecord[] = [];

function messageText(content: MessageContent): string {
  return v.is(v.string(), content)
    ? content
    : content.flatMap((part) => {
      const text = v.safeParse(TextPartSchema, part);

      return text.success ? [text.output.text] : [];
    }).join('');
}

/** Parsed against the lane's own imported schema. */
function sleepTimeAnswer(): string {
  return JSON.stringify(v.parse(SleepTimeUpdateSchema, { upserts: [], decay: [] }));
}

/** Admitted by `parseWorkspaceTitle` at build time, so the fake fails loudly, not the turn. */
function titleAnswer(): string {
  const answer = JSON.stringify({ title: 'Two Turn Probe' });

  if (parseWorkspaceTitle(answer) === null) {
    throw new Error('FakeAI: built a title answer the product title parse rejects');
  }

  return answer;
}

/** Keyed on request shape: streamed is the turn; a leading system message is the title
 *  (actor-agent.ts:5609-5615); user-only is the sleep-time judge (orchestrator.ts:2698). */
function laneOf(stream: boolean, messages: readonly { role?: string }[]): CallRecord['lane'] {
  if (stream) return 'turn';

  if (messages[0]?.role === 'system') return 'title';

  return 'sleep';
}

export class FakeAI extends WorkerEntrypoint {
  /** The one method `createDirectWorkersAIFetch` calls on the binding. */
  async run(model: string, inputs: RunInputs, options?: RunOptions): Promise<Response> {
    const signal = options?.signal;

    // Absent and null stay distinct: only one means the adapter never passed a signal.
    let signalKind = 'foreign';

    if (signal === undefined) signalKind = 'undefined';
    else if (signal === null) signalKind = 'null';
    else if (signal instanceof AbortSignal) signalKind = 'AbortSignal';

    const parsed = v.parse(RunInputsSchema, inputs);
    const stream = parsed.stream ?? false;
    const messages = parsed.messages ?? [];

    // Turns travel the HTTP seam; the only streamed calls here are the probe's own `signalProbe`.
    const users = messages
      .filter((m) => m.role === 'user')
      .map((m) => messageText(v.parse(MessageContentSchema, m.content ?? '')));

    // The layer normalizes every call to `messages`, so the lane key reads the stream flag and leading role.
    const lane = laneOf(stream, messages);

    recordedCalls.push({ model, users, signalKind, stream, lane });

    if (lane === 'turn') {
      // Echo the last typed line (harness rows ride after it). A buffered body: `streamedResponse`
      // needs one to forward (direct-workers-ai-fetch.ts:253).

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

/** `durableObjects` installs `ObservedOrchestrator` under the `OrchestratorAgent` name,
 *  so every stub the namespace returns carries the fixture reads. */
interface ProbeRootEnv extends Omit<ProbeEnv, 'AI' | 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<ObservedOrchestrator>;
  /** `vitest.config.ts` binds `AI` to this worker's own `FakeAI` entrypoint. */
  readonly AI?: AIRunner;
}

/** Named member by member: `DurableObjectStub<OrchestratorAgent>` over `getChatHistoryPage`
 *  overflows TypeScript's instantiation depth. */
type ExerciseTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator,
  'claimOwner' | 'setModel' | 'runTaskFromMcp' | 'getWorkspaceSnapshot' | 'writeWorkspaceFile'>
  & Pick<ObservedOrchestrator, 'chatHistoryPage'>;

type QueueTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator,
  'claimOwner' | 'setModel' | 'setSoul' | 'beginGenesisTurn' | 'receivePeerMessage' | 'runTaskFromMcp' | 'evalAbortActivation' | 'workspaceTitle'
  | 'createSubordinateAgent'>
  & Pick<ObservedOrchestrator, 'pendingSteers' | 'pendingSteerFileRows' | 'agentLogEvents' | 'inboxState' | 'runEnds' | 'seedStaleDrainEvent' | 'runEventWake' | 'parityRows' | 'wakeRows'
  | 'receivePeerThenEvict' | 'timerTickFinished' | 'runCauses' | 'drainRunClosed'>;

/** Sleeps past the interactive detach window, so the call detaches and settles out of turn. */
const WAKE_RUN_SLEEP_MS = 40_000;

const SocketHistorySchema = v.array(v.object({ id: v.string(), role: v.string() }));

type SocketHistory = v.InferOutput<typeof SocketHistorySchema>;

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

/** Result shapes live in `./two-turn-shapes`, importable from the workerd typecheck
 *  project, which excludes this file (see this directory's tsconfig). */

/** One per settled turn: a turn the lane declines logs it just as one it compresses. */
function sleepTimeSettled(emitted: readonly { event: string }[]): number {
  return emitted.filter((e) => e.event === 'memory.facts_deferred' || e.event === 'memory.facts_compressed').length;
}

function owedEffectKeys(emitted: readonly RecordedLog[]): string[] {
  return emitted
    .filter((e) => e.event === 'turn.terminal_effects_owed')
    .flatMap((e) => {
      const owed = e.fields['owed'];

      return v.is(v.string(), owed) ? owed.split(',').filter((key) => key.length > 0) : [];
    });
}

/** A close that never finishes hangs here, ended by the row's deadline, not a side clock. */
function awaitSleepTimeSettled(recording: RecordingLogger, count: number): Promise<void> {
  return recording.until((emitted) => sleepTimeSettled(emitted) >= count);
}

async function awaitWithLimit<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  const expiry = Promise.withResolvers<never>();
  const timer = setTimeout(() => expiry.reject(new Error(what)), ms);

  try { return await Promise.race([work, expiry.promise]); }
  finally { clearTimeout(timer); }
}

/** The close's `end()` emits the owed event synchronously, so a quiet log without it is a clean close. */
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

/** Prefixes the reason `receivePeerThenEvict` aborts with, ahead of the rows it saw. */
const REACTOR_EVICTION = 'reactor-wake probe eviction: ';

/** The rows an evicting call carried out in its abort's reason; the call answering at all is the failure. */
async function evictionOf(call: Promise<void>): Promise<ReactorEviction> {
  try {
    await call;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const at = message.indexOf(REACTOR_EVICTION);

    if (at === -1) throw cause;

    return v.parse(ReactorEvictionSchema, JSON.parse(message.slice(at + REACTOR_EVICTION.length)));
  }

  throw new Error('reactor-wake probe: the arrival call answered, so the object was never evicted');
}


export class TwoTurnProbeRoot extends Agent<ProbeRootEnv> {
  /** Returns the recorded kind or the throw's message, separating "no signal" from serialization failure. */
  async signalProbe(): Promise<{ signalKind: string } | { threw: string }> {
    try {
      const binding = this.env.AI;
      const controller = new AbortController();

      await binding?.run(
        'probe',
        { messages: [], stream: true },
        { signal: controller.signal, returnRawResponse: true },
      );

      const recorded = recordedCalls.pop();

      return { signalKind: recorded?.signalKind ?? 'no-call-recorded' };
    } catch (cause) {
      return { threw: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  calls(): CallRecord[] {
    return recordedCalls;
  }

  async exercise(): Promise<ExerciseResult> {
    // Capture after warmup, before every turn: each DO constructor replaces the sink on first
    // stub use (actor-agent.ts:1453-1462); nothing reinstalls after (install.ts:309).
    const recording = createRecordingLogger();

    const capture = (): (() => void) => setDiagnosticsSink(
      createCompositeLogger([createConsoleLogger(), recording]),
    );

    let restore: () => void = () => {};

    try {
      const target: ExerciseTarget = await getAgentByName<ProbeEnv, ObservedOrchestrator>(
        this.env.OrchestratorAgent, 'two-turn-workspace',
      );

      // The capability token is needed for the registry reads a turn performs.
      const caller = await ownerCaller(this.env);
      const userDO = this.env.UserDO.get(this.env.UserDO.idFromName('probe-owner'));

      const register = await userDO.registerWorkspace(caller, 'two-turn-workspace', 'Two-Turn Probe');
      const claim = await target.claimOwner('probe-owner');

      await userDO.ensureWorkspaceCapability('two-turn-workspace', claim.capabilityHash);

      // The static openai-compat provider resolves its baseURL from this key; fixture values only.
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
      const history = await target.chatHistoryPage();

      // Parsed at the boundary, so the RPC declaration (InferOutput) cannot drift from the wire.
      return v.parse(ExerciseResultSchema, {
        register, claim, model, turnA, turnB, snapshot, history,
        calls: recordedCalls,
        http: await this.httpCalls(),
        failures: recording.emitted
          .filter((e) => e.code !== null)
          .map((e) => ({ event: e.event, code: e.code ?? 'unclassified', cause: e.cause ?? '' })),
        owedEffects: owedEffectKeys(recording.emitted),
        sleepTimeSettled: sleepTimeSettled(recording.emitted),
        catalogFallbacks: recording.emitted.filter((e) => e.event === 'models_dev.catalog_fallback').length,
        catalogHits: (await this.probeLog()).catalogHits,
      });
    } finally {
      restore();
    }
  }

  /** Timed enqueue-to-settle as the object experiences it; the transcript-cost gate compares them. */
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

  /** Only this worker's outbound handler routes to the control host, so no new Worker or binding. */
  async httpCalls(): Promise<HttpCall[]> {
    return (await this.probeLog()).calls;
  }

  async probeLog(): Promise<{ calls: HttpCall[]; catalogHits: number }> {
    const response = await fetch('http://probe-control.invalid/log');

    return v.parse(v.object({ calls: v.array(HttpCallSchema), catalogHits: v.number() }), await response.json());
  }

  async httpReset(): Promise<void> {
    await fetch('http://probe-control.invalid/reset', { method: 'POST' });
  }

  /** Only the remote model response is held; peer ingress queues a durable event-drain
   * submission while both socket inputs are pending, so its inherited lastBody belongs to B. */
  async queuedConversation(mode: Exclude<QueueProbeMode, 'cold' | 'attach-cold' | 'evt' | 'rwake' | 'twin'>): Promise<QueuedConversation> {
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

      // A busy-routed send is announced `queued` when the inbox takes it; an idle send only
      // persists its row. send() resolves on whichever arrives first.
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
        // A peer event writes a durable event row drained by its own turn; no 'submission:running' frame.
        const peer = await target.receivePeerMessage({
          sender_event_id: 'queue-peer-input', sender_agent_name: 'queue-peer', sender_user_id: owner,
          topic: 'queue-probe', body: 'QUEUE-PROGRAMMATIC', mode: 'build', reply_expected: false,
        });

        if (!peer.admitted) throw new Error(`queue probe peer input refused: ${peer.reason}`);
        await send('QUEUE-C');
      }

      const task = mode === 'signal' ? v.parse(TurnSchema, await target.runTaskFromMcp('QUEUE-PROGRAMMATIC')) : null;

      const heldCalls = (await this.httpCalls()).filter((call) => call.model === 'probe-queue');

      if (heldCalls.length !== 1) throw new Error('queued requests ran before the held genesis response was released');
      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });

      // The held genesis and one user-origin rerun of the sends it could not land; a signal or peer
      // event that waited with them rides its first step.
      await awaitSleepTimeSettled(recording, { chat: 2, peer: 2, signal: 2, yield: 1, attach: 2 }[mode]);
      await awaitQuiet(recording);

      return { http: await this.httpCalls(), task };
    } finally {
      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });
      socket?.close(1000, 'queue probe complete');
      unsubscribe();
      restore();
    }
  }

  /**
   * Background wake with the settle window held (`where`: reply step or settle): the wake
   * asks the loop for a turn while the interactive turn owns it; on the loop, 'queued'
   * means the pump runs it next.
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

      // The window was held when the job settled; the held party is released only here.
      await fetch('http://probe-control.invalid/wake/arrived');
      const releasedAt = Date.now();
      await fetch('http://probe-control.invalid/wake/release', { method: 'POST' });

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

  /** Returns the exact wire it sent, which the cold test replays after the reset. */
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

    // `landed`: 'mid-turn' (busy-routed splice) or 'turn' (own turn).
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

      // A busy-routed frame can close before the socket echoes it, so bound the wait.
      const landedValue = await Promise.race([
        landed.promise,
        new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);

      return { wire, landed: landedValue };
    } finally {
      socket.close(1000, 'frame sent');
    }
  }



  /** The replay must re-bind the same client id to the same turn id. */
  async prepareQueuedConversation(mode: QueueProbeMode): Promise<PreparedConversation> {
    const { target, workspace, owner } = await this.claimQueueWorkspace(mode);
    await fetch('http://probe-control.invalid/queue/hold', {
      method: 'POST', body: JSON.stringify({ from: 1 }),
    });

    const genesis = await target.beginGenesisTurn();

    if (!genesis.started) throw new Error('queue probe genesis did not start');

    const attach = mode === 'attach' || mode === 'attach-cold'
      ? { filename: 'chart.png', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }
      : undefined;

    // Sent after the fake reports the held call: sent earlier, B can land inside it and the
    // reset has no reservation to keep.
    await fetch('http://probe-control.invalid/queue/arrived');
    const bWire = (await this.sendChatFrame(target, workspace, 'QUEUE-B', attach)).wire;
    const cWire = (await this.sendChatFrame(target, workspace, 'QUEUE-C')).wire;

    const steers = await target.pendingSteers();
    const steerFiles = await target.pendingSteerFileRows();

    return v.parse(PreparedConversationSchema, { workspace, owner, bFrame: bWire, cFrame: cWire, steers, steerFiles });
  }

  /** The durable pending_steers row, not the socket, binds each replay to the turn. */
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

  async completeQueuedConversation(prepared: PreparedConversation): Promise<{ http: HttpCall[]; steers: PendingSteer[]; steerFiles: PendingSteerFile[]; transcript: SocketHistory; runEnds: Array<{ runId: string; reason: string }> }> {
    const target: QueueTarget = await this.queueTarget(prepared.workspace);

    const recording = createRecordingLogger();
    const restore = setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), recording]));

    try {
      // Only calls the restarted object makes are this half's measurement.
      await this.httpReset();
      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });
      // One turn: the re-opened genesis, with B and C landed at its first step.
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

  // The parity drive: the same script as the local backend's `chat-session-parity.ts`;
  // `parityPrepare` runs to the eviction instant, `parityComplete` resumes after it.

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

      // A done frame resolves its waiter whether asked for before or after it arrived.
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
        socket.send(this.parityFrame('PARITY-ONE'));
        landings['PARITY-ONE'] = (await done('PARITY-ONE')).landed ?? null;
        await awaitSleepTimeSettled(recording, 1);

        // 2. Mid-turn send with a file while the call is parked: it reruns as the next turn,
        //    answered under its own id, not at admission (admission announces `queued`).
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

        await fetch('http://probe-control.invalid/parity/hold', { method: 'POST', body: JSON.stringify({ parkAt: 'first' }) });
        socket.send(this.parityFrame('PARITY-THREE'));
        await fetch('http://probe-control.invalid/parity/arrived');
        socket.send(JSON.stringify({ type: 'cf_agent_chat_request_cancel', id: 'PARITY-THREE' }));
        landings['PARITY-THREE'] = (await done('PARITY-THREE')).landed ?? null;
        await fetch('http://probe-control.invalid/parity/release', { method: 'POST' });
        await awaitQuiet(recording);

        await fetch('http://probe-control.invalid/parity/hold', { method: 'POST', body: JSON.stringify({ parkAt: 'partial' }) });
        socket.send(this.parityFrame('PARITY-FOUR-TOOL'));
        // The eviction waits for the tool result and first delta on the socket, so it cuts the same state every run.
        await fetch('http://probe-control.invalid/parity/arrived');
        await seen((frame) => frame.id === 'PARITY-FOUR-TOOL' && frame.body !== undefined && frame.body.includes('"text-delta"'), "the parked answer's first delta");
        socket.send(this.parityFrame('PARITY-FOUR-STEER', file));
        // Acknowledged, not landed: the eviction cuts the turn first; the reservation is what survives.
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
      // 5. Resume: the parked producer is released, the wake continues the evicted turn and
      //    replays the acknowledged steer.
      const { socket, done } = await this.paritySocket(target, prepared.workspace, 'B', frames);

      try {
        socket.send(JSON.stringify({ type: 'cf_agent_stream_resume_request' }));
        await fetch('http://probe-control.invalid/parity/release', { method: 'POST' });
        await awaitQuiet(recording);
        await awaitSleepTimeSettled(recording, 1);
        await awaitQuiet(recording);

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
        seed: await (await target.fetch(`https://probe/agents/orchestrator-agent/${prepared.workspace}/get-messages`)).text(),
      });
    } finally {
      restore();
    }
  }

  private queueTarget(workspace: string): Promise<QueueTarget> {
    return getAgentByName<ProbeEnv, ObservedOrchestrator>(this.env.OrchestratorAgent, workspace);
  }




  /** Proves each socket input bound its own request and no second SDK turn ran. */
  async pendingSteersFor(workspace: string): Promise<PendingSteer[]> {
    const target: QueueTarget = await this.queueTarget(workspace);

    return await target.pendingSteers();
  }

  async claimEventWorkspace(): Promise<{ workspace: string; owner: string }> {
    const { workspace, owner } = await this.claimQueueWorkspace('evt');

    return { workspace, owner };
  }

  async agentLogEventsFor(workspace: string): Promise<AgentLogEvent[]> {
    const target: QueueTarget = await this.queueTarget(workspace);

    return await target.agentLogEvents();
  }

  async seedStaleDrainEventFor(workspace: string, marker: string): Promise<void> {
    const target: QueueTarget = await this.queueTarget(workspace);

    await target.seedStaleDrainEvent(marker);
  }

  /** Ends on the woken drain run's close, so its turn leaves nothing for the next test to count. */
  async runEventWakeFor(workspace: string, marker: string): Promise<void> {
    const target: QueueTarget = await this.queueTarget(workspace);

    await target.runEventWake(marker);
    await target.drainRunClosed();
  }

  /** Claimed and left idle: no genesis turn, no due trigger, nothing owed. */
  async claimReactorWakeWorkspace(): Promise<{ workspace: string; owner: string }> {
    const { workspace, owner } = await this.claimQueueWorkspace('rwake');

    return { workspace, owner };
  }

  /**
   * One external event into the idle workspace through the shipped receiver (`receivePeerMessage`,
   * wired to `scheduleDrain`), the object evicted in the arrival's own call, then the platform's own
   * delivery of what the eviction left armed: the fresh activation's first `_kinuTimerTick` is joined,
   * not driven. Once that tick drained the event, the drain's model call and its run's close are joined
   * too, so nothing the drain does lands in the next test's logs.
   */
  async reactorWake(workspace: string, owner: string, body: string): Promise<ReactorWake> {
    const target: QueueTarget = await this.queueTarget(workspace);

    const evicted = await evictionOf(target.receivePeerThenEvict({
      sender_event_id: `rwake-${body}`, sender_agent_name: 'rwake-peer', sender_user_id: owner,
      topic: 'reactor-wake', body, mode: 'build', reply_expected: false,
    }));

    // Bound before the eviction, or no Kinu timer armed: no tick of this arrival is left to join.
    if (evicted.evictedWith.some((row) => row.turnId !== null) || !evicted.armedAfter.includes('_kinuTimerTick')) {
      return { ...evicted, drained: [], causes: [] };
    }

    const fresh: QueueTarget = await this.queueTarget(workspace);
    await fresh.timerTickFinished();
    const drained = (await fresh.agentLogEvents()).filter((row) => row.variant === 'peer_agent');

    // A tick that left the event unbound is the finding; its drain's model call would never come.
    if (drained.every((row) => row.turnId === null)) return { ...evicted, drained, causes: [] };
    await fetch(`http://probe-control.invalid/log/until?marker=${encodeURIComponent(body)}`);

    return { ...evicted, drained, causes: await fresh.drainRunClosed() };
  }

  /** Returns the model-call count and terminal evidence so the test can say where the drive stopped. */
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
      const { wire } = await this.sendChatFrame(target, workspace, 'FIRST-CHAT');

      void wire;

      // Wait on the model call, not the turn's settle, which the stall never reaches.
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
   * Two sockets put the same client message id at once: a message admitted once is one
   * turn, one provider request and one row, however many sockets delivered it.
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

      // A second admitted turn would compress its facts too, so this count discriminates.
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
   * The eval-only abort ends an activation as the platform does; measured here because
   * the deployed build cannot be driven by `abortAllDurableObjects`.
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
   * The agent tab: a socket on the hired actor's own chat path (not a facet hop via the SDK
   * `sub` option, which this transport refuses), then `getActorSnapshot` and its own `listBackgroundJobs`.
   */
  async hostedActorTab(): Promise<{ name: string; snapshot: string; jobs: string; frames: number }> {
    const { target, workspace } = await this.claimQueueWorkspace('twin');
    const created = v.parse(v.object({ name: v.string() }), await target.createSubordinateAgent());
    const path = `https://probe/agents/orchestrator-agent/${workspace}/${hostedActorSocketPath(created.name)}`;
    const response = await target.fetch(new Request(path, { headers: { Upgrade: 'websocket' } }));
    const socket = response.webSocket;

    if (response.status !== 101 || socket === null) throw new Error(`the hosted actor path answered ${String(response.status)}, not a socket`);
    socket.accept();
    // Carried as JSON text: the recursive JsonValue type cannot be instantiated through the RPC boundary.
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
      socket.send(JSON.stringify({ type: 'rpc', id: 'tab-jobs', method: 'listBackgroundJobs', args: [50, created.name] }));
      await arrived.promise;

      return {
        name: created.name,
        snapshot: answers.get('tab-snapshot') ?? '',
        jobs: answers.get('tab-jobs') ?? '',
        frames,
      };
    } finally {
      socket.close(1000, 'agent tab probe complete');
    }
  }

  /** A first chat that lands as a steer on a live genesis turn must reach the model after resume. */
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
    const genesis = await target.beginGenesisTurn();

    if (!genesis.started) throw new Error('first-gen probe genesis did not start');

    const { landed } = await this.sendChatFrame(target, workspace, 'FIRST-PROMPT');

    // Wait on the call and the turn's close so the landed row and retired steer are both observable.
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
   * One raw chat frame on a busy conversation: the provider is parked on the first call of a
   * turn with a second step, and the frame goes out under the client's own message id.
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
      await fetch('http://probe-control.invalid/queue/arrived');
      socket.send(JSON.stringify({
        type: 'cf_agent_use_chat_request', id: 'raw-request',
        init: { method: 'POST', body: JSON.stringify({
          trigger: 'submit-message',
          messages: [{ id: 'raw-client-id', role: 'user', parts: [{ type: 'text', text: 'RAW-STEER' }] }],
        }) },
      }));

      // Read durable traces only after the `queued` broadcast; the landing is decided at the step
      // that takes the words, never at admission.
      const admission = await admitted.promise;
      const persistedWhileHeld = (await this.socketHistory(target, workspace)).some((row) => row.id === 'raw-client-id');
      const pendingIds = (await target.pendingSteers()).map((row) => row.id);

      await fetch('http://probe-control.invalid/queue/release', { method: 'POST' });
      const landing = await answered.promise;
      // One turn when the words landed inside it; two when they ran after it.
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


  /** Own workspace per variant so Think state never crosses between experiments. */
  async driveOnce(input: DriveOnceInput): Promise<DriveOnceResult> {
    const drive = v.parse(DriveOnceInputSchema, input);
    // Capture after warmup: each DO constructor replaces the sink on first stub use.
    const recording = createRecordingLogger();

    const capture = (): (() => void) => setDiagnosticsSink(
      createCompositeLogger([createConsoleLogger(), recording]),
    );

    let restore: () => void = () => {};

    try {
      const target: ExerciseTarget = await getAgentByName<ProbeEnv, ObservedOrchestrator>(
        this.env.OrchestratorAgent, drive.workspace,
      );

      const caller = await ownerCaller(this.env);
      const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(drive.owner));

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

      // Seeded through the workspace-file RPC, never the VFS.
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

        const history = await target.chatHistoryPage();

        const failures = recording.emitted
          .filter((e) => e.code !== null)
          .map((e) => ({ event: e.event, code: e.code ?? 'unclassified', cause: e.cause ?? '' }));

        throw new Error(`two-turn probe: turn skipped at enqueue: ${JSON.stringify({ turn, http, history, failures })}`);
      }

      await awaitSleepTimeSettled(recording, 1);
      await awaitQuiet(recording);

      const snapshot = await target.getWorkspaceSnapshot();
      const history = await target.chatHistoryPage();

      return v.parse(DriveOnceResultSchema, {
        turn, snapshot, history,
        calls: recordedCalls,
        http: await this.httpCalls(),
        failures: recording.emitted
          .filter((e) => e.code !== null)
          .map((e) => ({ event: e.event, code: e.code ?? 'unclassified', cause: e.cause ?? '' })),
        owedEffects: owedEffectKeys(recording.emitted),
        sleepTimeSettled: sleepTimeSettled(recording.emitted),
        catalogFallbacks: recording.emitted.filter((e) => e.event === 'models_dev.catalog_fallback').length,
        catalogHits: (await this.probeLog()).catalogHits,
      });
    } finally {
      restore();
    }
  }
}
