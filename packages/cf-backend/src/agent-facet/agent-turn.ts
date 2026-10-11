/** One delegated turn in the agent's isolate: its model loop here, every tool call back in the workspace. */
import { jsonSchema, tool, type ModelMessage, type ToolSet, type UIMessageChunk } from 'ai';
import {
  ASK_OWNER_TOOL, CHAT_SESSION_ID, actorAffinity, askOwnerTool, HeadCapture, decodeJsonValue, decodeModelMessageValues, encodeModelMessageValues, withEffectReceipt, REAL_CLOCK, answerParts, classifyRunEnd, closeTurnRun, openTurnRun, runHeadInference, permitInPlan, imageModelOutput,
  type AuthRequest, type AuthResolution, type HandedOffTurn, type RelayedProvider, type EnqueueTurnResult, type HeadInferenceDeps, type ProgrammaticTurn, type JsonObject, type JsonValue, type Executor, type Memory, type MissionBudgetPort, type HeadStep, type HeadStreamKind, type AgentSignal, type SendOutcome,
  turnSourcesFromBundle, captureOperationProfile, type ModelCallReport, type ModelOperationEvent,
  type AdvisorRecoverySnapshot, type AgentFigures, type AgentStandingReport, type HostedActor, type OwedReport, type SerializedMessage, type SessionEvent,
  type SubordinateReportLedger, type SubordinateReportStatus, type TaskTurnEnding, type WorkMode, type ResolvedTurnProfile, type DynamicContext,
} from '@kinu.run/core';

import { attempt, diagnostics, hold, logged, settle, type ErrorCode } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import { routedModelReads, type AgentProviderDeps, type AgentProviderRegistry, type UserCredentialClient } from '../providers/agent-registry';
import { compactionDiagnostics, hostedActorCompaction } from '@kinu.run/compaction';
import type { AgentDatabase } from './agent-database';
import type { StepPacer } from './step-pacer';
import type { ChatTurnRequest } from '../agent-turns';
import type { AgentHeadDelta, AgentReview, AgentTurnActivity, AgentTurnTask, AgentToolAnswer, AgentToolCall, AgentTrace, AgentTurnEnd, CacheWarmArm, OpenWork, PreparedAgentTurn } from '@kinu.run/core';

/** The answer's metadata, unless the workspace reads the turn's narration before it can say it. One shape, not a union:
 *  a stub's promise of a union is a union of promises. */
export interface AnswerMetadataReply {
  readonly owesNarration: boolean;
  readonly metadata: JsonObject | null;
}

/** Asks without the narration first: a turn that changed no slate it did not show never reads it. */
export async function answerMetadataOf(
  workspace: Pick<AgentWorkspace, 'answerMetadata'>, turnId: string, narration: () => Promise<readonly string[]>,
): Promise<JsonObject | null> {
  const first = await workspace.answerMetadata(turnId, null);

  return first.owesNarration ? (await workspace.answerMetadata(turnId, await narration())).metadata : first.metadata;
}

/** How a delivered run ended: its end, or the refusal that kept it from running. */
export type AgentRunOutcome = { readonly ended: AgentTurnEnd } | { readonly refused: { readonly code: ErrorCode; readonly message: string } };

export interface AgentWorkspace {
  session(): NimbusSessionSurface;
  stateSession(): NimbusSessionSurface;
  memory(): Memory;
  program(turnId: string, ...args: Parameters<Executor['execute']>): ReturnType<Executor['execute']>;
  traceTurn(turnId: string, event: AgentTrace): Promise<void>;
  traceStream(turnId: string, lines: ReadableStream<Uint8Array>): Promise<void>;
  /** In the session codec's durable form: a ModelMessage's type is too deep for an RPC signature. */
  resume(turnId: string): Promise<readonly JsonValue[] | null>;
  guard(turnId: string, ...args: Parameters<MissionBudgetPort['guard']>): ReturnType<MissionBudgetPort['guard']>;
  debit(turnId: string, ...args: Parameters<MissionBudgetPort['debit']>): Promise<void>;
  prepareTurn(turnId: string): Promise<PreparedAgentTurn>;
  /** The profile the agent assembled its turn on; answers the live block on it. */
  bindProfile(turnId: string, profile: ResolvedTurnProfile): Promise<DynamicContext>;
  /** A null id reads one between turns. */
  prepareChat(request: ChatTurnRequest): Promise<PreparedAgentTurn>;
  chatEvent(event: SessionEvent): Promise<void>;
  /** The turn's end, with the agent's figures as it ends. */
  /** `activity`: the lines its turn logged that no tool call took. */
  turnEnded(event: SessionEvent, figures: AgentFigures, activity: readonly AgentTurnActivity[]): Promise<void>;
  owedReport(
    /** `taskId`: the assignment this turn answers, if one opened it. */
    turn: { readonly reports: SubordinateReportLedger; readonly ownerDriven: boolean; readonly taskId: string | null },
    ended: { readonly ending: TaskTurnEnding; readonly assistantText: string; readonly narration: readonly string[] },
  ): Promise<OwedReport | null>;
  parentReport(report: {
    readonly text: string; readonly status: SubordinateReportStatus; readonly mode: WorkMode; readonly sequenceId: string; readonly quiet?: true;
  }): Promise<string>;
  /** Persists the title the agent suggested itself; null lands the stand-in alone. */
  autoTitle(subject: string, title: string | null): Promise<void>;
  /** The workspace's own agent hands its settled turn to the workspace, which owes that turn's lanes. Repeatable: the
   *  workspace keys what it owes on the turn. */
  turnSettled(settled: HandedOffTurn): Promise<void>;
  hireAdvisor(advisor: AdvisorRecoverySnapshot): Promise<void>;
  /** A facet sets no alarm: the instant it next needs waking, or none, and whether it holds owed work at all (a parked
   *  effect needs no wake but is still owed), replacing what it said before. */
  /** `standing`: the agent's standing as it reports it, which the workspace reads in place of asking. */
  owes(seq: number, next: number | null, holds: boolean, standing: AgentStandingReport): Promise<void>;
  birthContext(drainTurnId: string): Promise<SerializedMessage[]>;
  steerSkills(text: string, alreadyActive: readonly string[]): Promise<string | null>;
  /** Its open tasks and running jobs, where its tools wrote them. */
  openWork(): Promise<OpenWork>;
  /** The workspace's lane that keeps its prompt cache warm (`CacheWarming`); one an agent has none of keeps nothing. */
  /** A model request is starting: until when the cache stayed warm for the last one, read before it voids the lane. */
  noteModelRequest(lastRequestAt: number | null): Promise<number | null>;
  armCacheWarm(input: CacheWarmArm): Promise<number | null>;
  advise(review: AgentReview): Promise<void>;
  /** A delivered run's end, or why it could not run: its workspace's caller awaits it (design v2 §1). */
  runEnded(id: string, outcome: AgentRunOutcome): Promise<void>;
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  executeTool(call: AgentToolCall): Promise<AgentToolAnswer>;
  observe(lines: ReadableStream<Uint8Array>): Promise<void>;
  /** Calls the agent's `step` for the turn's waiting step, and answers once that step has ended (`StepPacer`). */
  paceStep(turnId: string): Promise<void>;
  /** The answer's metadata. The turn's narration names the slates its words promoted, read only when the turn changed
   *  a slate it did not show: asked without it then, the workspace takes nothing and answers `owesNarration`. */
  answerMetadata(turnId: string, narration: readonly string[] | null): Promise<AnswerMetadataReply>;
  getAuth(key: string, opts?: AuthRequest): Promise<AuthResolution | null>;
  listCredentials(): ReturnType<UserCredentialClient['listCredentials']>;
  relayDevice(provider: RelayedProvider): ReturnType<UserCredentialClient['relayDevice']>;
  relayModelCall(deviceId: string, callId: string, request: Request): Promise<Response>;
  cancelModelRelay(callId: string): Promise<void>;
  sayToParent(signal: AgentSignal): Promise<SendOutcome>;
  /** What the agent logged that no tool call or task's end carried, for the workspace's activity log. */
  logActivity(lines: readonly AgentTurnActivity[]): Promise<void>;
  /** The agent's non-turn model calls (its compaction's folds), filed with the workspace's spend. */
  reportModelCall(report: ModelCallReport): Promise<void>;
  reportModelOperation(event: ModelOperationEvent): Promise<void>;
}

class StepWords implements UnderlyingDefaultSource<Uint8Array> {
  private words: ReadableStreamDefaultController<Uint8Array> | null = null;

  private open = true;

  readonly stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(this);

  start(words: ReadableStreamDefaultController<Uint8Array>): void {
    this.words = words;
  }

  cancel(): void {
    this.open = false;
  }

  write(bytes: Uint8Array): void {
    if (this.open) this.words?.enqueue(bytes);
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    this.words?.close();
  }
}

/** A step's words on one stream, then its record (AGENTS.md Waste). */
class HeadTrace {
  private live: { readonly words: StepWords; readonly sent: Promise<void> } | null = null;

  private readonly encoder = new TextEncoder();

  constructor(private readonly workspace: AgentWorkspace, private readonly turnId: string) {}

  delta(kind: HeadStreamKind, delta: string): void {
    const line: AgentHeadDelta = { kind, delta };

    (this.live ?? this.openStep()).words.write(this.encoder.encode(`${JSON.stringify(line)}\n`));
  }

  async step(sequence: number, step: HeadStep): Promise<void> {
    await this.flush();
    await this.workspace.traceTurn(this.turnId, { kind: 'step', sequence, step });
  }

  async flush(): Promise<void> {
    const live = this.live;

    if (live === null) return;
    this.live = null;
    live.words.end();
    await live.sent;
  }

  relay(words: StepWords): Promise<void> {
    return settle(attempt({ doing: "relaying an agent's live head output", otherwise: 'io' },
      () => this.workspace.traceStream(this.turnId, words.stream)).pipe(Effect.catch((failure) => Effect.sync(() => {
        diagnostics.failure('agent.head_output_failed', failure, { turn: this.turnId });
      }))));
  }

  private openStep(): { readonly words: StepWords; readonly sent: Promise<void> } {
    const words = new StepWords();

    this.live = { words, sent: this.relay(words) };

    return this.live;
  }
}

const AGENT_CALLER = { workspaceToken: '' };

/** Bounded well below an access token's life (an hour, for the providers whose login the owner holds), so a credential
 *  held here is refreshed before it could expire; an upstream's refusal refreshes it at once. */
const CREDENTIAL_HELD_MS = 5 * 60_000;

/** Each workspace client's broker: the isolate's turns share the credentials one of them read. */
const brokers = new WeakMap<AgentWorkspace, UserCredentialClient>();

/** The isolate's credentials, held under their refresh rules (design v2 §8): a step asks its workspace for one only once
 *  it is older than {@link CREDENTIAL_HELD_MS}, or an upstream refused the one held, whichever turn of it asks. */
function brokeredCredentials(workspace: AgentWorkspace): UserCredentialClient {
  const known = brokers.get(workspace);

  if (known !== undefined) return known;
  const broker = heldCredentials(workspace);

  brokers.set(workspace, broker);

  return broker;
}

function heldCredentials(workspace: AgentWorkspace): UserCredentialClient {
  const held = new Map<string, { readonly at: number; readonly auth: AuthResolution | null }>();

  return {
    getAuth: async (_caller, key, opts) => {
      const known = held.get(key);

      if (opts?.rejected === undefined && known !== undefined && Date.now() - known.at < CREDENTIAL_HELD_MS) return known.auth;
      const auth = await workspace.getAuth(key, opts);

      held.set(key, { at: Date.now(), auth });

      return auth;
    },
    listCredentials: () => workspace.listCredentials(),
    relayDevice: (_caller, provider) => workspace.relayDevice(provider),
    relayModelCall: (_caller, deviceId, callId, request) => workspace.relayModelCall(deviceId, callId, request),
    cancelModelRelay: (_caller, callId) => workspace.cancelModelRelay(callId),
  };
}

function lines(chunks: ReadableStream<UIMessageChunk>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return chunks.pipeThrough(new TransformStream<UIMessageChunk, Uint8Array>({
    transform: (chunk, controller) => { controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`)); },
  }));
}

function workspaceTools(
  workspace: AgentWorkspace,
  prepared: PreparedAgentTurn,
  turn: FacetToolTurn,
): ToolSet {
  return Object.fromEntries(prepared.tools.map((descriptor) => {
    // The owner answers it, nothing executes it: its call parks in this isolate's store, which the repair reads.
    if (descriptor.name === ASK_OWNER_TOOL) return [descriptor.name, askOwnerTool()];

    const entry = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(descriptor.inputSchema),
      execute: async (input, { toolCallId }) => {
        const answer = await workspace.executeTool({
          activity: turn.database.takeActivity(), turnId: turn.id, mode: turn.mode, parentDriven: turn.parentDriven, ...(turn.driving !== undefined && { driving: turn.driving }),
          callId: toolCallId, name: descriptor.name, input: decodeJsonValue({ value: input }),
        });

        turn.live.dynamic = answer.dynamic;
        turn.database.recordReports(turn.id, answer.reports);
        turn.capture.evidence.push(...answer.captured.evidence);
        turn.capture.decisions.push(...answer.captured.decisions);
        turn.capture.artifacts.push(...answer.captured.artifacts);
        turn.capture.toolCalls.push(...answer.captured.toolCalls);
        turn.capture.childHeadIds.push(...answer.captured.childHeadIds);

        return answer.output;
      },
      // As the workspace's own tool renders it: an image reaches the model, and the transcript, as an image.
      toModelOutput: imageModelOutput,
    });

    return [descriptor.name, descriptor.planAllowed ? permitInPlan(entry) : entry];
  }));
}

export interface LiveTurn {
  dynamic: PreparedAgentTurn['dynamic'];
}

/** Filed in the order it was spent. */
export class FacetSpend {
  private filed: Promise<unknown> = Promise.resolve();

  constructor(private readonly workspace: AgentWorkspace) {}

  readonly report = (report: ModelCallReport): void => { this.file(() => this.workspace.reportModelCall(report)); };

  readonly operations = (event: ModelOperationEvent): void => { this.file(() => this.workspace.reportModelOperation(event)); };

  async settled(): Promise<void> {
    await this.filed;
  }

  private file(work: () => Promise<void>): void {
    this.filed = this.filed.then(() => hold(logged('agent.spend_relay_failed', { doing: "filing an agent's spend with its workspace", otherwise: 'unavailable' }, work)));
  }
}

/** The registry an agent's isolate resolves its models through, over its own providers (`AgentFacet.models`). */
export type FacetModels = (deps: Omit<AgentProviderDeps, 'env'>) => AgentProviderRegistry;

function facetModels(actor: HostedActor, workspace: AgentWorkspace, models: FacetModels, prepared: PreparedAgentTurn): AgentProviderRegistry {
  return models({
    userDO: { stub: brokeredCredentials(workspace), caller: AGENT_CALLER },
    accountFor: (provider) => actor.stores.config.getProviderAccounts()[provider] ?? prepared.accounts[provider]
      ?? prepared.sources.profileInputs.envelope.catalog.accounts?.[provider],
    appTitle: 'Kinu',
  });
}

/** A turn in this isolate, assembled as every actor's is: from what its workspace read of it (core turnSourcesFromBundle)
 *  and what this isolate holds, its own models and compaction among them. */
export function facetTurnSources(turn: {
  readonly actor: HostedActor;
  readonly workspace: AgentWorkspace;
  readonly models: FacetModels;
  readonly prepared: PreparedAgentTurn;
  readonly spend: FacetSpend;
  readonly live: LiveTurn;
  readonly runId: string;
  readonly turnId: string;
  readonly pacer: StepPacer;
}) {
  const { actor, prepared, spend } = turn;
  const registry = facetModels(actor, turn.workspace, turn.models, prepared);
  // Its calls are routed under its own conversation, as a CLI hire's are, in its workspace's cache.
  const affinity = actorAffinity(actor.record);

  const compaction = hostedActorCompaction(actor, {
    logger: compactionDiagnostics,
    models: { normalize: (spec) => registry.normalizeSpecSync(spec || prepared.sources.model), resolve: (spec) => registry.resolveModel(spec, affinity) },
    report: (_actor, report) => spend.report(report),
    operations: spend.operations,
  });

  const sources = turnSourcesFromBundle(prepared.sources, {
    rt: actor.runtime,
    config: actor.stores.config,
    models: { normalize: (spec) => registry.normalizeSpecSync(spec), resolve: (spec) => registry.resolveModel(spec, affinity), routed: routedModelReads(registry) },
    scaffoldSpend: { source: 'scaffold', report: spend.report, operations: spend.operations },
    operations: spend.operations,
    observeStream: async (chunks) => { await turn.workspace.observe(lines(chunks)); },
    paceStep: (signal) => turn.pacer.pace(turn.workspace, turn.turnId, signal),
    attachmentBudget: actor.session.orchestrator.acc.context,
    extensions: () => [compaction.extension],
    dynamic: () => () => turn.live.dynamic,
    // The workspace answers tools and the live block on the profile assembled here.
    settle: async (profile) => { turn.live.dynamic = await turn.workspace.bindProfile(turn.turnId, profile); },
    taskPlan: () => null,
    operation: (profile, inputs) => captureOperationProfile({ actor: actor.handle, profile, inputs, runId: turn.runId, turnId: turn.turnId }),
  });

  return { sources, trigger: compaction.trigger };
}

/** A turn's tool calls carry its lane, so a workspace that restarted mid-turn rebuilds the same turn. */
interface FacetToolTurn {
  readonly id: string;
  readonly mode: WorkMode;
  readonly parentDriven: boolean;
  readonly driving: JsonObject | undefined;
  readonly live: LiveTurn;
  readonly capture: HeadCapture;
  readonly database: AgentDatabase;
}

export function facetTurnTools(workspace: AgentWorkspace, prepared: PreparedAgentTurn, actor: HostedActor, turn: FacetToolTurn): ToolSet {
  return withEffectReceipt(workspaceTools(workspace, prepared, turn), {
    actor: actor.handle,
    sql: actor.runtime.storage.sql,
    turnId: () => turn.id,
    durable: (callId, signal) => actor.session.durableCall(callId, signal),
    // Each runs in its workspace, whose receipt, in the store its effect commits to, answers a re-ask: the receipt here
    // points there (design v2 §4). Asking owners parks here and is not among them.
    elsewhere: (name) => name !== ASK_OWNER_TOOL,
  });
}

/** A one-shot run on the shared assembly and step loop. */
export async function runAgentTask(
  { database, workspace, models, pacer }: { readonly database: AgentDatabase; readonly workspace: AgentWorkspace; readonly models: FacetModels; readonly pacer: StepPacer },
  task: AgentTurnTask,
): Promise<AgentTurnEnd> {
  const prepared = await workspace.prepareTurn(task.sequenceId);

  database.prepare({ turnId: task.sequenceId, runId: prepared.runId }, prepared);
  const actor = await database.acquire();
  const live: LiveTurn = { dynamic: prepared.dynamic };

  const stop = database.stop(task.sequenceId).signal;
  const capture = new HeadCapture();
  const runId = prepared.runId;
  const spend = new FacetSpend(workspace);
  const { sources, trigger } = facetTurnSources({ actor, workspace, models, prepared, spend, live, runId, turnId: task.sequenceId, pacer });

  const inference: HeadInferenceDeps = {
    actor,
    runId,
    clock: REAL_CLOCK,
    sources,
    compaction: trigger,
    tools: facetTurnTools(workspace, prepared, actor, { id: task.sequenceId, mode: task.mode, parentDriven: false, driving: undefined, live, capture, database }),
    opening: decodeModelMessageValues(prepared.opening),
    capture,
    isAborted: () => stop.aborted,
    signal: stop,
    advise: async (turn, reachable, mode) => await workspace.advise({ turnId: task.sequenceId, turn, reachable, mode }),
  };

  const { brief } = prepared;

  if (brief !== undefined) inference.brief = () => brief;

  const trace = prepared.trace ? new HeadTrace(workspace, task.sequenceId) : null;
  let produced: readonly ModelMessage[] | undefined;

  if (prepared.reportMessages) inference.reportMessages = (messages) => { produced = messages; };

  if (prepared.resume) {
    inference.resume = async () => {
      const resumed = await workspace.resume(task.sequenceId);

      return resumed === null ? null : decodeModelMessageValues(resumed);
    };
  }

  if (prepared.missionLabels !== undefined) inference.mission = {
    labels: prepared.missionLabels,
    port: {
      guard: (...args) => workspace.guard(task.sequenceId, ...args),
      debit: (...args) => workspace.debit(task.sequenceId, ...args),
    },
  };

  if (trace !== null) {
    inference.reportStep = (sequence, step) => trace.step(sequence, step);
    inference.reportDelta = (kind, delta) => { trace.delta(kind, delta); };
  }

  openTurnRun(actor.stores.eventRecorder, runId, {
    agentId: actor.record.actorId, causedBy: 'swarm', userMessage: task.body,
    turnIndex: actor.session.orchestrator.sessionTurnIndex,
  });

  // Every end closes the stream; an open one holds the relay.
  let report: Awaited<ReturnType<typeof runHeadInference>>;

  try {
    report = await runHeadInference(prepared.input, inference);
  } finally {
    await trace?.flush();
  }

  closeTurnRun(actor.stores.eventRecorder, runId, {
    turnIndex: actor.session.orchestrator.sessionTurnIndex,
    usage: report.usage,
    workMode: actor.session.workMode,
    ...classifyRunEnd({
      completed: report.status === 'completed',
      interrupted: report.status === 'aborted',
      errorText: report.errorMessage,
    }),
  });

  const transcript = actor.stores.history.transcript(CHAT_SESSION_ID);
  const completion = report.canonicalCompletion;
  // The run's report carries its narration, so it is read whether or not the answer's metadata needs it.
  const narration = completion === undefined ? [] : await transcript.narration(answerParts(completion.outputPartReferences, completion.finalTextReference));

  if (completion !== undefined) await database.answer(completion, await answerMetadataOf(workspace, completion.turnId, async () => narration));
  await spend.settled();

  return {
    ...report,
    activity: database.takeActivity(),
    figures: database.figures(),
    errorMessage: report.errorMessage ?? null,
    narration: narration.join('\n'),
    ...(produced !== undefined && { produced: encodeModelMessageValues(produced) }),
  };
}
