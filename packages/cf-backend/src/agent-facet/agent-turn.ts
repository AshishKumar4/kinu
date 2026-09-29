/** One delegated turn in the agent's isolate: its model loop here, every tool call back in the workspace. */
import { jsonSchema, tool, type ToolSet, type UIMessageChunk } from 'ai';
import {
  CHAT_SESSION_ID, HeadCapture, decodeJsonValue, withEffectClaims, REAL_CLOCK, answerParts, classifyRunEnd, closeTurnRun, openTurnRun, runHeadInference,
  type AuthRequest, type EnqueueTurnResult, type HeadInferenceDeps, type ProgrammaticTurn, type HeadReport, type JsonObject, type ObservedCall, type ProviderEnv, type WorkMode,
} from '@kinu.run/core';
import { attempt, diagnostics, renderCauseChain, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import { createAgentProviderRegistry, type UserCredentialClient } from '../providers/agent-registry';
import type { AgentDatabase } from './agent-database';
import type { AgentReview, AgentTask, AgentToolAnswer, AgentToolCall, AgentTurnEnd, AgentTurnProfile, PreparedAgentTurn } from './protocol';

export interface AgentWorkspace {
  session(): NimbusSessionSurface;
  stateSession(): NimbusSessionSurface;
  prepareTurn(turnId: string): Promise<PreparedAgentTurn>;
  profile(turnId: string, availableTools: readonly string[], workMode: WorkMode): Promise<AgentTurnProfile>;
  advise(review: AgentReview): Promise<void>;
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  executeTool(call: AgentToolCall): Promise<AgentToolAnswer>;
  observe(lines: ReadableStream<Uint8Array>, call: ObservedCall): Promise<void>;
  answerMetadata(turnId: string, narration: readonly string[]): Promise<JsonObject | null>;
  finishTurn(turnId: string, end: AgentTurnEnd): Promise<void>;
  failTurn(turnId: string, failure: string): Promise<void>;
  getAuthHeaders(key: string, opts?: AuthRequest): Promise<Record<string, string> | null>;
  getCredentialBaseURL(key: string): Promise<string | null>;
  listCredentials(): ReturnType<UserCredentialClient['listCredentials']>;
  codexRelayDevice(): ReturnType<UserCredentialClient['codexRelayDevice']>;
  relayCodex(deviceId: string, callId: string, request: Request): Promise<Response>;
  cancelCodexRelay(callId: string): Promise<void>;
}

const AGENT_CALLER = { workspaceToken: '' };

function brokeredCredentials(workspace: AgentWorkspace): UserCredentialClient {
  return {
    getAuthHeaders: (_caller, key, opts) => workspace.getAuthHeaders(key, opts),
    getCredentialBaseURL: (_caller, key) => workspace.getCredentialBaseURL(key),
    listCredentials: () => workspace.listCredentials(),
    codexRelayDevice: () => workspace.codexRelayDevice(),
    relayCodex: (_caller, deviceId, callId, request) => workspace.relayCodex(deviceId, callId, request),
    cancelCodexRelay: (_caller, callId) => workspace.cancelCodexRelay(callId),
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
  return Object.fromEntries(prepared.tools.map((descriptor) => [descriptor.name, tool({
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
  })]));
}

const TURN_END: Readonly<Record<HeadReport['status'], AgentTurnEnd['status']>> = {
  completed: 'completed', aborted: 'aborted', budget_exceeded: 'budget_exceeded', errored: 'errored',
};

export interface QueuedAgentTask {
  readonly after: Promise<void>;
  readonly database: AgentDatabase;
  readonly workspace: AgentWorkspace;
  readonly providers: ProviderEnv;
  readonly task: AgentTask;
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
  database: AgentDatabase, workspace: AgentWorkspace, providers: ProviderEnv, task: AgentTask,
): Promise<void> {
  const prepared = await workspace.prepareTurn(task.sequenceId);

  database.price(prepared.model, prepared.pricing);
  const actor = await database.acquire();
  const live = { dynamic: prepared.dynamic };

  const registry = createAgentProviderRegistry({
    env: providers,
    userDO: { stub: brokeredCredentials(workspace), caller: AGENT_CALLER },
    appTitle: 'Kinu',
  });

  const stop = database.stop(task.sequenceId).signal;
  const capture = new HeadCapture();
  const runId = crypto.randomUUID();

  const inference: HeadInferenceDeps = {
    actor,
    runId,
    clock: REAL_CLOCK,
    delegation: { assignmentId: task.sequenceId, birthContext: [...prepared.birthContext] },
    model: registry.resolveModel(prepared.model),
    tools: withEffectClaims(workspaceTools(workspace, prepared, { id: task.sequenceId, live, capture, database }), {
      actor: actor.handle,
      sql: actor.runtime.storage.sql,
      turnId: () => task.sequenceId,
      durable: (callId, signal) => actor.session.durableCall(callId, signal),
    }),
    framing: { system: prepared.framing.system, messages: prepared.framing.messages },
    capture,
    workspaceLayout: 'shared-workspace',
    isAborted: () => stop.aborted,
    signal: stop,
    profile: async ({ availableTools, workMode }) => {
      const resolved = await workspace.profile(task.sequenceId, availableTools, workMode);

      live.dynamic = resolved.dynamic;

      return resolved;
    },
    advise: async (turn, reachable, mode) => await workspace.advise({ turnId: task.sequenceId, turn, reachable, mode }),
    dynamic: () => live.dynamic,
    observeStream: async (chunks, call) => { await workspace.observe(lines(chunks), call); },
  };

  openTurnRun(actor.stores.eventRecorder, runId, {
    agentId: actor.record.actorId, causedBy: 'subordinate_task', userMessage: task.body,
    turnIndex: actor.session.orchestrator.sessionTurnIndex,
  });

  const report = await runHeadInference(prepared.input, inference);

  closeTurnRun(actor.stores.eventRecorder, runId, {
    turnIndex: actor.session.orchestrator.sessionTurnIndex,
    usage: report.usage,
    workMode: task.mode,
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

  await workspace.finishTurn(task.sequenceId, {
    activity: database.takeActivity(),
    status: TURN_END[report.status],
    summary: report.summary,
    errorMessage: report.errorMessage ?? null,
    narration: narration.join('\n'),
  });
}
