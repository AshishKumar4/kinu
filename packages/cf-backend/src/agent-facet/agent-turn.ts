/** One delegated turn in the agent's isolate: its model loop here, every tool call back in the workspace. */
import { jsonSchema, tool, type ModelMessage, type ToolSet, type UIMessageChunk } from 'ai';
import {
  CHAT_SESSION_ID, HeadCapture, agentAffinityKey, decodeJsonValue, withEffectClaims, REAL_CLOCK, answerParts, classifyRunEnd, closeTurnRun, openTurnRun, runHeadInference, permitInPlan,
  type AuthRequest, type AuthResolution, type RelayedProvider, type EnqueueTurnResult, type HeadInferenceDeps, type ProgrammaticTurn, type JsonObject, type ObservedCall, type ProviderEnv, type WorkMode,
  type Executor, type Memory, type MissionBudgetPort, type HeadStep, type HeadStreamKind, type AgentSignal, type SendOutcome,
} from '@kinu.run/core';
import { attempt, diagnostics, renderCauseChain, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import { createAgentProviderRegistry, type UserCredentialClient } from '../providers/agent-registry';
import { codexContainerFetch } from '../egress/codex-egress-route';
import type { AgentDatabase } from './agent-database';
import type { AgentHeadDelta, AgentReview, AgentTurnTask, AgentToolAnswer, AgentToolCall, AgentTrace, AgentTurnEnd, AgentTurnProfile, PreparedAgentTurn } from '@kinu.run/core';

export interface AgentWorkspace {
  session(): NimbusSessionSurface;
  stateSession(): NimbusSessionSurface;
  memory(): Memory;
  program(turnId: string, ...args: Parameters<Executor['execute']>): ReturnType<Executor['execute']>;
  traceTurn(turnId: string, event: AgentTrace): Promise<void>;
  traceStream(turnId: string, lines: ReadableStream<Uint8Array>): Promise<void>;
  resume(turnId: string): Promise<readonly ModelMessage[] | null>;
  guard(turnId: string, ...args: Parameters<MissionBudgetPort['guard']>): ReturnType<MissionBudgetPort['guard']>;
  debit(turnId: string, ...args: Parameters<MissionBudgetPort['debit']>): Promise<void>;
  prepareTurn(turnId: string): Promise<PreparedAgentTurn>;
  profile(turnId: string, availableTools: readonly string[], workMode: WorkMode): Promise<AgentTurnProfile>;
  advise(review: AgentReview): Promise<void>;
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  executeTool(call: AgentToolCall): Promise<AgentToolAnswer>;
  observe(lines: ReadableStream<Uint8Array>, call: ObservedCall): Promise<void>;
  answerMetadata(turnId: string, narration: readonly string[]): Promise<JsonObject | null>;
  finishTurn(turnId: string, end: AgentTurnEnd): Promise<void>;
  failTurn(turnId: string, failure: string): Promise<void>;
  getAuth(key: string, opts?: AuthRequest): Promise<AuthResolution | null>;
  listCredentials(): ReturnType<UserCredentialClient['listCredentials']>;
  relayDevice(provider: RelayedProvider): ReturnType<UserCredentialClient['relayDevice']>;
  relayModelCall(deviceId: string, callId: string, request: Request): Promise<Response>;
  cancelModelRelay(callId: string): Promise<void>;
  forwardCodex(callId: string, request: Request): Promise<Response>;
  sayToParent(signal: AgentSignal): Promise<SendOutcome>;
  cancelCodex(callId: string): Promise<void>;
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

/** A step's words on one stream, then its record; a call per word filled the relay's isolate (AGENTS.md Waste). */
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
  turn: { readonly id: string; readonly live: { dynamic: PreparedAgentTurn['dynamic'] }; readonly capture: HeadCapture; readonly database: AgentDatabase },
): ToolSet {
  return Object.fromEntries(prepared.tools.map((descriptor) => {
    const entry = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(descriptor.inputSchema),
      execute: async (input, { toolCallId }) => {
        const answer = await workspace.executeTool({
          activity: turn.database.takeActivity(), turnId: turn.id, callId: toolCallId, name: descriptor.name, input: decodeJsonValue({ value: input }),
        });

        turn.live.dynamic = answer.dynamic;
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

interface LiveTurn {
  dynamic: PreparedAgentTurn['dynamic'];
  inputs?: AgentTurnProfile['inputs'];
}

export interface QueuedAgentTask {
  readonly after: Promise<void>;
  readonly database: AgentDatabase;
  readonly workspace: AgentWorkspace;
  readonly providers: ProviderEnv;
  readonly task: AgentTurnTask;
}

export function queueAgentTask({ after, database, workspace, providers, task }: QueuedAgentTask): Promise<void> {
  return settle(attempt({ doing: "running a delegated turn in the agent's own isolate", otherwise: 'io' }, async () => {
    await after;
    await runTurn(database, workspace, providers, task);
  }).pipe(
    Effect.tapError((failure) => attempt(
      { doing: 'reporting a delegated turn that could not run', otherwise: 'io' },
      () => workspace.failTurn(task.sequenceId, renderCauseChain(failure)),
    )),
    Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('agent.turn_failed', failure, { turn: task.sequenceId }); })),
  ));
}


async function runTurn(
  database: AgentDatabase, workspace: AgentWorkspace, providers: ProviderEnv, task: AgentTurnTask,
): Promise<void> {
  const prepared = await workspace.prepareTurn(task.sequenceId);

  database.prepare(task.sequenceId, prepared);
  const actor = await database.acquire();
  const live: LiveTurn = { dynamic: prepared.dynamic };

  const registry = createAgentProviderRegistry({
    env: providers,
    userDO: { stub: brokeredCredentials(workspace), caller: AGENT_CALLER },
    accountFor: (provider) => actor.stores.config.getProviderAccounts()[provider] ?? prepared.accounts[provider]
      ?? live.inputs?.envelope.catalog.accounts?.[provider],
    codexContainer: codexContainerFetch({ forward: (callId, request) => workspace.forwardCodex(callId, request), cancel: (callId) => workspace.cancelCodex(callId) }),
    appTitle: 'Kinu',
  });

  const stop = database.stop(task.sequenceId).signal;
  const capture = new HeadCapture();
  const runId = prepared.runId;

  const inference: HeadInferenceDeps = {
    actor,
    runId,
    clock: REAL_CLOCK,
    model: registry.resolveModel(prepared.model, agentAffinityKey(prepared.input.rootId)),
    tools: withEffectClaims(workspaceTools(workspace, prepared, { id: task.sequenceId, live, capture, database }), {
      actor: actor.handle,
      sql: actor.runtime.storage.sql,
      turnId: () => task.sequenceId,
      durable: (callId, signal) => actor.session.durableCall(callId, signal),
    }),
    capture,
    workspaceLayout: prepared.workspaceLayout,
    isAborted: () => stop.aborted,
    signal: stop,
    profile: async ({ availableTools, workMode }) => {
      const resolved = await workspace.profile(task.sequenceId, availableTools, workMode);

      live.dynamic = resolved.dynamic;
      live.inputs = resolved.inputs;

      return resolved;
    },
    advise: async (turn, reachable, mode) => await workspace.advise({ turnId: task.sequenceId, turn, reachable, mode }),
    dynamic: () => live.dynamic,
    observeStream: async (chunks, call) => { await workspace.observe(lines(chunks), call); },
  };

  const trace = prepared.trace ? new HeadTrace(workspace, task.sequenceId) : null;
  let produced: readonly ModelMessage[] | undefined;

  if (prepared.birthContext !== undefined) inference.delegation = { assignmentId: task.sequenceId, birthContext: prepared.birthContext };

  if (prepared.framing !== undefined) inference.framing = prepared.framing;

  if (prepared.reportMessages) inference.reportMessages = (messages) => { produced = messages; };

  if (prepared.resume) inference.resume = () => workspace.resume(task.sequenceId);

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
    agentId: actor.record.actorId, causedBy: actor.record.origin === 'swarm' ? 'swarm' : 'subordinate_task', userMessage: task.body,
    turnIndex: actor.session.orchestrator.sessionTurnIndex,
  });

  const report = await runHeadInference(prepared.input, inference);

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

  await trace?.flush();
  await workspace.finishTurn(task.sequenceId, {
    ...report,
    activity: database.takeActivity(),
    errorMessage: report.errorMessage ?? null,
    narration: narration.join('\n'),
    ...(produced !== undefined && { produced }),
  });
}
