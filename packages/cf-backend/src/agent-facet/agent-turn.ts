/** One delegated turn in the agent's isolate: its model loop here, every tool call back in the workspace. */
import { jsonSchema, tool, type ModelMessage, type ToolSet, type UIMessageChunk } from 'ai';
import {
  CHAT_SESSION_ID, agentAffinityKey, HeadCapture, decodeJsonValue, decodeModelMessageValues, encodeModelMessageValues, withEffectClaims, REAL_CLOCK, answerParts, classifyRunEnd, closeTurnRun, openTurnRun, runHeadInference, permitInPlan,
  type AuthRequest, type AuthResolution, type RelayedProvider, type EnqueueTurnResult, type HeadInferenceDeps, type ProgrammaticTurn, type JsonObject, type JsonValue, type ObservedCall, type ProviderEnv, type Executor, type Memory, type MissionBudgetPort, type HeadStep, type HeadStreamKind, type AgentSignal, type SendOutcome,
  turnSourcesFromBundle, captureOperationProfile, type ModelCallReport, type ModelOperationEvent,
  type AdvisorRecoverySnapshot, type AgentFigures, type HostedActor, type OwedReport, type SerializedMessage, type SessionEvent,
  type SubordinateReportLedger, type SubordinateReportStatus, type TaskTurnEnding, type WorkMode, type ResolvedTurnProfile, type DynamicContext,
} from '@kinu.run/core';

import { attempt, diagnostics, hold, logged, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import { createAgentProviderRegistry, routedModelReads, type AgentProviderRegistry, type UserCredentialClient } from '../providers/agent-registry';
import { compactionDiagnostics, hostedActorCompaction } from '@kinu.run/compaction';
import { codexContainerFetch } from '../egress/codex-egress-route';
import type { AgentDatabase } from './agent-database';
import type { ChatTurnRequest } from '../agent-turns';
import type { AgentHeadDelta, AgentReview, AgentTurnTask, AgentToolAnswer, AgentToolCall, AgentTrace, AgentTurnEnd, PreparedAgentTurn } from '@kinu.run/core';

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
  turnEnded(event: SessionEvent, figures: AgentFigures): Promise<void>;
  owedReport(
    turn: { readonly reports: SubordinateReportLedger; readonly ownerDriven: boolean },
    ended: { readonly ending: TaskTurnEnding; readonly assistantText: string; readonly narration: readonly string[] },
  ): Promise<OwedReport | null>;
  parentReport(report: {
    readonly text: string; readonly status: SubordinateReportStatus; readonly mode: WorkMode; readonly sequenceId: string; readonly quiet?: true;
  }): Promise<string>;
  /** Persists the title the agent suggested itself; null lands the stand-in alone. */
  autoTitle(subject: string, title: string | null): Promise<void>;
  hireAdvisor(advisor: AdvisorRecoverySnapshot): Promise<void>;
  /** A facet sets no alarm: the instant it next owes work, or none, replacing what it said before. */
  owes(next: number | null): Promise<void>;
  birthContext(drainTurnId: string): Promise<SerializedMessage[]>;
  steerSkills(text: string, alreadyActive: readonly string[]): Promise<string | null>;
  advise(review: AgentReview): Promise<void>;
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  executeTool(call: AgentToolCall): Promise<AgentToolAnswer>;
  observe(lines: ReadableStream<Uint8Array>, call: ObservedCall): Promise<void>;
  answerMetadata(turnId: string, narration: readonly string[]): Promise<JsonObject | null>;
  getAuth(key: string, opts?: AuthRequest): Promise<AuthResolution | null>;
  listCredentials(): ReturnType<UserCredentialClient['listCredentials']>;
  relayDevice(provider: RelayedProvider): ReturnType<UserCredentialClient['relayDevice']>;
  relayModelCall(deviceId: string, callId: string, request: Request): Promise<Response>;
  cancelModelRelay(callId: string): Promise<void>;
  forwardCodex(callId: string, request: Request): Promise<Response>;
  sayToParent(signal: AgentSignal): Promise<SendOutcome>;
  cancelCodex(callId: string): Promise<void>;
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

function brokeredCredentials(workspace: AgentWorkspace): UserCredentialClient {
  return {
    getAuth: (_caller, key, opts) => workspace.getAuth(key, opts),
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
  turn: { readonly id: string; readonly mode: WorkMode; readonly live: { dynamic: PreparedAgentTurn['dynamic'] }; readonly capture: HeadCapture; readonly database: AgentDatabase },
): ToolSet {
  return Object.fromEntries(prepared.tools.map((descriptor) => {
    const entry = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(descriptor.inputSchema),
      execute: async (input, { toolCallId }) => {
        const answer = await workspace.executeTool({
          activity: turn.database.takeActivity(), turnId: turn.id, mode: turn.mode, callId: toolCallId, name: descriptor.name, input: decodeJsonValue({ value: input }),
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

function facetModels(actor: HostedActor, workspace: AgentWorkspace, providers: ProviderEnv, prepared: PreparedAgentTurn): AgentProviderRegistry {
  return createAgentProviderRegistry({
    env: providers,
    userDO: { stub: brokeredCredentials(workspace), caller: AGENT_CALLER },
    accountFor: (provider) => actor.stores.config.getProviderAccounts()[provider] ?? prepared.accounts[provider]
      ?? prepared.sources.profileInputs.envelope.catalog.accounts?.[provider],
    codexContainer: codexContainerFetch({ forward: (callId, request) => workspace.forwardCodex(callId, request), cancel: (callId) => workspace.cancelCodex(callId) }),
    appTitle: 'Kinu',
  });
}

/** A turn in this isolate, assembled as every actor's is: from what its workspace read of it (core turnSourcesFromBundle)
 *  and what this isolate holds, its own models and compaction among them. */
export function facetTurnSources(turn: {
  readonly actor: HostedActor;
  readonly workspace: AgentWorkspace;
  readonly providers: ProviderEnv;
  readonly prepared: PreparedAgentTurn;
  readonly spend: FacetSpend;
  readonly live: LiveTurn;
  readonly runId: string;
  readonly turnId: string;
}) {
  const { actor, prepared, spend } = turn;
  const registry = facetModels(actor, turn.workspace, turn.providers, prepared);
  // Its calls are routed under its own conversation, as a CLI hire's are.
  const affinity = agentAffinityKey(actor.record.name);

  const compaction = hostedActorCompaction(actor, {
    logger: compactionDiagnostics,
    summarizer: () => registry.resolveModel(prepared.sources.model, affinity),
    spend,
    model: () => prepared.sources.model,
  });

  const sources = turnSourcesFromBundle(prepared.sources, {
    rt: actor.runtime,
    config: actor.stores.config,
    models: { normalize: (spec) => registry.normalizeSpecSync(spec), resolve: (spec) => registry.resolveModel(spec, affinity), routed: routedModelReads(registry) },
    scaffoldSpend: { source: 'scaffold', report: spend.report, operations: spend.operations },
    operations: spend.operations,
    observeStream: async (chunks, call) => { await turn.workspace.observe(lines(chunks), call); },
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

export function facetTurnTools(
  workspace: AgentWorkspace, prepared: PreparedAgentTurn, actor: HostedActor,
  turn: { readonly id: string; readonly mode: WorkMode; readonly live: LiveTurn; readonly capture: HeadCapture; readonly database: AgentDatabase },
): ToolSet {
  return withEffectClaims(workspaceTools(workspace, prepared, turn), {
    actor: actor.handle,
    sql: actor.runtime.storage.sql,
    turnId: () => turn.id,
    durable: (callId, signal) => actor.session.durableCall(callId, signal),
  });
}

/** A one-shot run on the shared assembly and step loop. */
export async function runAgentTask(
  database: AgentDatabase, workspace: AgentWorkspace, providers: ProviderEnv, task: AgentTurnTask,
): Promise<AgentTurnEnd> {
  const prepared = await workspace.prepareTurn(task.sequenceId);

  database.prepare(task.sequenceId, prepared);
  const actor = await database.acquire();
  const live: LiveTurn = { dynamic: prepared.dynamic };

  const stop = database.stop(task.sequenceId).signal;
  const capture = new HeadCapture();
  const runId = prepared.runId;
  const spend = new FacetSpend(workspace);
  const { sources, trigger } = facetTurnSources({ actor, workspace, providers, prepared, spend, live, runId, turnId: task.sequenceId });

  const inference: HeadInferenceDeps = {
    actor,
    runId,
    clock: REAL_CLOCK,
    sources,
    compaction: trigger,
    tools: facetTurnTools(workspace, prepared, actor, { id: task.sequenceId, mode: task.mode, live, capture, database }),
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
  const narration = completion === undefined ? [] : await transcript.narration(answerParts(completion.outputPartReferences, completion.finalTextReference));

  if (completion !== undefined) await database.answer(completion, await workspace.answerMetadata(completion.turnId, narration));
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
