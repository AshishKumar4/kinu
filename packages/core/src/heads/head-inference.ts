// Backend-agnostic run of a reporting agent (a head, or a swarm node via
// strategy/node-agent.ts). Every turn is a claimed actor turn on `ActorSession`.
// Inherited context: docs/EXPLORATION.md "Inherited context".

import { z } from 'zod';
import { invalidToolCallRefusal, oneOf } from '../tools/tool-schema';
import {
  tool,
  type ToolSet, type ModelMessage, type StepResult, type ToolExecutionOptions,
} from 'ai';
import type { ObserveStream } from '../chat';
import type { HostedActor } from '../state/actor-host';
import type { WorkMode } from '../types/turn';
import {
  EVIDENCE_KINDS,
  HeadStepPartsSchema, type HeadInput, type HeadReport, type HeadId, type HeadStep, type SerializedMessage,
  type Evidence, type Decision, type ArtifactRef,
} from './types';
import type { ToolCallRecord } from '../evolution/types';
import { missionGate, type MissionBudgetRefusal, type MissionScope, type MissionSeam, type SpendGate } from '../mission-budget';
import { failedToolOutcome, type ToolOutcome } from '../tools/outcome';
import { addUsage, normalizeUsage, usageReported, type Usage } from '../usage';
import { nanoid } from '../utils/nanoid';
import { extractFinalText, synthesizeHeadSummary } from './head-summary';
import { drawnStep } from '../session/transcript';
import { encodeModelMessageValues } from '../session/message-codec';
import { HeadFileChanges } from './file-changes';
import type { ReportHeadDelta } from './head-stream';
import * as v from 'valibot';
import { isJsonObject, projectJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { diagnostics, renderThrownChain, toKinuError, type KinuError } from '../obs/index';
import { BUILTIN_TOOL_NAMES, type BuiltinToolName } from '../tools/registry';
import { assembleActorTurn, withCompactionTrigger, type RunTurnSources, type TurnAssemblySources } from '../orchestrator/turn-assembly';
import type { CompactionTriggerReader } from '../orchestrator/turn-context';
import type { ActorTurnClaim, ClaimOutcome } from '../orchestrator/actor-claims';
import type { ActorExecutionInput, ActorExecutionResult, ActorSession, ActorTurnLease } from '../orchestrator/actor-session';
import type { ChatEvent } from '../chat';
import type { MessageReference, MessagePartReference } from '../session/messages';
import { recordExecutionEvent, settleExecutionContext, snapshotCompletedTurn, type CompactionTriggerState } from '../orchestrator/turn-lifecycle';
import { OVERFLOW_RETRY_TEXT } from '../turn-failure';
import type { CompletedTurn } from '../evolution/types';

/** A head's mutable findings; the backend's tools mutate the same instance runHeadInference reads. */
export class HeadCapture {
  readonly evidence: Evidence[] = [];
  readonly decisions: Decision[] = [];
  readonly artifacts: ArtifactRef[] = [];
  readonly toolCalls: ToolCallRecord[] = [];
  readonly childHeadIds: HeadId[] = [];
  /** Unwired (no `observeWrites`), it stays empty. */
  readonly files = new HeadFileChanges();
  /** Gross provider spend; the only token figure. `{}` when the provider never reported. */
  usage: Usage = {};

  /** Takes a whole {@link Usage} so an omitted field stays omitted rather than becoming 0. */
  recordStepUsage(usage: Usage): void {
    this.usage = addUsage(this.usage, usage);
  }

  recordEvidence(e: Evidence): void { this.evidence.push(e); }
  recordDecision(d: Decision): void { this.decisions.push(d); }
  recordArtifact(a: ArtifactRef): void { this.artifacts.push(a); }
  /** `result` is the projected output. */
  recordToolCall(call: HeadToolCall): void {
    this.toolCalls.push(call);
  }
}

export interface HeadToolCall extends ToolCallRecord {
  toolCallId: string;
  args: JsonObject;
  result: JsonValue;
  outcome: ToolOutcome;
}

import { permitInPlan } from '../execution/work-mode';
import type { Clock } from '../types/clock';

const RecordEvidenceInputSchema = z.object({
  kind: oneOf(EVIDENCE_KINDS),
  body: z.string(),
  ref: z.string().optional(),
  confidence: z.number().meta({ minimum: 0, maximum: 1 }).optional(),
});

const RecordDecisionInputSchema = z.object({
  question: z.string(),
  choice: z.string(),
  rationale: z.string(),
  supportingEvidence: z.array(z.string()).optional(),
});

export function buildHeadAccumulatorTools(capture: HeadCapture): ToolSet {
  return {
    record_evidence: permitInPlan(tool({
      description:
        "Record a piece of evidence you've gathered. Use this for facts you want surfaced in the merge synthesis.",
      inputSchema: RecordEvidenceInputSchema,
      execute: async ({ kind, body, ref, confidence }) => {
        const ev: Evidence = { id: `ev-${nanoid(6)}`, kind, body, ref, confidence };
        capture.recordEvidence(ev);

        return `evidence recorded (id=${ev.id})`;
      },
    })),
    record_decision: permitInPlan(tool({
      description: 'Record a decision the head considered.',
      inputSchema: RecordDecisionInputSchema,
      execute: async ({ question, choice, rationale, supportingEvidence }) => {
        const d: Decision = { question, choice, rationale, supportingEvidence };
        capture.recordDecision(d);

        return 'decision recorded';
      },
    })),
  };
}

/** Records every call of `tools` into the HeadCapture, a refused one included when this wraps the input check. */
export function withHeadCaptureRecording(tools: ToolSet, capture: HeadCapture): ToolSet {
  const out: ToolSet = {};

  for (const [name, entry] of Object.entries(tools)) {
    out[name] = recordingTool(name, entry, capture);
  }

  return out;
}

/** A schema-refused call never reaches {@link recordingTool}. */
function recordRefusedCalls(step: StepResult<ToolSet>, capture: HeadCapture): void {
  for (const part of step.content) {
    if (part.type !== 'tool-call') continue;
    const refusal = invalidToolCallRefusal(part);

    if (refusal === undefined) continue;
    const value = projectJsonValue({ value: part.input });

    capture.recordToolCall({
      name: part.toolName, args: isJsonObject(value) ? value : { input: value }, result: renderThrownChain({ cause: refusal }),
      outcome: failedToolOutcome({ cause: refusal }), toolCallId: part.toolCallId,
    });
  }
}

function recordingTool<Entry extends ToolSet[string]>(
  name: string,
  entry: Entry,
  capture: HeadCapture,
): Entry {
  const execute = entry.execute;

  if (!execute) return entry;

  return Object.assign({}, entry, {
    execute: async (input: never, options: ToolExecutionOptions<unknown>) => {
      const value = projectJsonValue({ value: input });
      const args: JsonObject = isJsonObject(value) ? value : { input: value };

      try {
        const result = await execute(input, options);
        capture.recordToolCall({
          name, args, result: projectJsonValue({ value: result }),
          outcome: { success: true }, toolCallId: options.toolCallId,
        });

        return result;
      } catch (err) {
        capture.recordToolCall({
          name, args, result: renderThrownChain({ cause: err }),
          outcome: failedToolOutcome({ cause: err }), toolCallId: options.toolCallId,
        });
        throw err;
      }
    },
  });
}

const HEAD_PROMPT_TOOL_NAMES = [
  'record_evidence',
  'record_decision',
  'eval',
  'shell',
  'file',
  'web',
  'split_subheads',
] as const;

const HEAD_WORK_TOOLS = ['eval', 'shell', 'file'] as const satisfies readonly BuiltinToolName[];

export type HeadWorkspaceLayout = 'shared-workspace' | 'private-scratch';

function hasHeadTool(tools: ReadonlySet<string>, ...names: readonly string[]): boolean {
  return names.some((name) => tools.has(name));
}

function renderHeadToolConventions(
  input: HeadInput,
  workspaceLayout: HeadWorkspaceLayout,
  availableToolNames?: readonly string[],
): string[] {
  const tools = new Set(availableToolNames ?? HEAD_PROMPT_TOOL_NAMES);
  const lines: string[] = ['Conventions:'];

  if (hasHeadTool(tools, 'record_evidence')) {
    lines.push('- record_evidence whenever you learn something worth surfacing in the merge.');
  }

  if (hasHeadTool(tools, 'record_decision')) {
    lines.push('- record_decision when you make a substantive choice the parent might want to reconcile.');
  }

  if (hasHeadTool(tools, 'eval')) {
    const executionDoctrine = workspaceLayout === 'shared-workspace'
      ? '- eval runs JavaScript against the SAME resources your parent agent has. Each environment is its own filesystem in its own paths: '
        + '`workspace.*` is the canonical workspace you were forked from (start there: the code and data you were spawned to study usually live in it), '
        + '`sandbox.*` is its container, and `device.*` is the user\'s machine. '
        + '`workspace.exec` runs a real shell in the workspace, so `grep -rn X .` searches it in one call. '
        + '`web.*` is also in scope.'
      : '- eval runs JavaScript across the environments exposed to this local head: '
        + '`workspace.*` is your private scratch, `parent.*` is the canonical parent workspace containing the task\'s code and data, '
        + 'and `device.*` is the user\'s machine. Start with `parent.*` for project work; use `workspace.*` only for private scratch. '
        + '`web.*` is also in scope.';

    lines.push(
      executionDoctrine,
      ...(input.mode === 'plan'
        ? ['- This is a Plan research head: use eval only for read-only inspection. Do not call mutating workspace, process, port, release, or deployment operations.']
        : []),
    );
  }

  if (hasHeadTool(tools, 'shell')) {
    const runDoctrine = workspaceLayout === 'shared-workspace'
      ? '- run executes one shell command. Name the runtime: `sandbox` / `device` are the parent agent\'s separate environments, '
        + 'and the default `workspace` runtime is the canonical workspace you were forked from.'
      : '- run executes one shell command. The runtime `parent` is the canonical parent workspace, the default `workspace` runtime is private scratch, '
        + 'and runtime `device` is the user\'s machine.';

    lines.push(
      runDoctrine,
      ...(input.mode === 'plan'
        ? ['- In Plan mode, run only read-only inspection commands. Do not install, write, launch servers, expose ports, or change system state.']
        : []),
    );
  }

  if (hasHeadTool(tools, 'file')) {
    const filePlane = workspaceLayout === 'shared-workspace'
      ? 'the canonical workspace filesystem'
      : 'your private scratch filesystem; use parent.* inside eval for the canonical parent workspace';

    lines.push(input.mode === 'plan'
      ? `- file is available for reading ${filePlane}. Do not edit, write, or delete files in Plan mode.`
      : `- file reads and edits ${filePlane}. Read a file before you edit or overwrite it, and edit by replacing exact text you copied out of the read `
        + 'rather than rewriting the file or shelling out to sed.');
  }

  if (hasHeadTool(tools, 'web')) {
    lines.push('- Loop `web` action=search to gather, then action=fetch to read the promising results; record_evidence each finding worth surfacing.');
  }

  if (hasHeadTool(tools, 'split_subheads')) {
    lines.push('- split_subheads to recursively explore deeper if needed (depth-budgeted).');
  }

  lines.push(
    '- Final text response: 2-4 sentences summarizing what you found + recommending what should happen next.',
    '- Stay focused on YOUR task. Don\'t try to do sibling heads\' work.',
  );
  lines.push('- If you need to share findings but no shared scratch tool exists, put the finding in your final response and record_evidence if available.');

  if (!hasHeadTool(tools, ...HEAD_WORK_TOOLS)) {
    lines.push('- You have no filesystem or command tool in this run: reason from inherited context and the available accumulator tools only.');
  }

  if (!hasHeadTool(tools, 'split_subheads')) {
    lines.push('- Do not propose recursive subheads; split_subheads is not available in this run.');
  }

  return [...lines, '', renderIsolationDoctrine(input, workspaceLayout)];
}

function renderIsolationDoctrine(input: HeadInput, workspaceLayout: HeadWorkspaceLayout): string {
  if (input.mode === 'plan') {
    return 'You are ONE OF SEVERAL Plan research heads with read access to the parent workspace. Inspect it read-only, do not create scratch files or worktrees, and return evidence and recommendations to the parent plan.';
  }

  if (workspaceLayout === 'shared-workspace') {
    return `You are ONE OF SEVERAL heads running concurrently against the same agent's resources. When you touch a SHARED MUTABLE resource, isolate yourself so you don't race a sibling: for any git repo, create your own worktree (\`git worktree add ../head-${input.id.slice(0, 8)} <branch>\`) before working; for shared files, write under your own head-namespaced path (\`shared/findings/${input.id}/...\` in the parent workspace). Read-only inspection of shared resources is always fine.`;
  }

  return `Your workspace and file tools are private scratch. The canonical parent workspace exposed through parent.* is shared with sibling heads; isolate any mutation there (for a git repo, create a worktree such as \`git worktree add ../head-${input.id.slice(0, 8)} <branch>\`). Read-only inspection is always fine.`;
}

export function buildHeadSystemPrompt(
  input: HeadInput,
  availableToolNames?: readonly string[],
  workspaceLayout: HeadWorkspaceLayout = 'shared-workspace',
): string {
  return [
    `You are a "head": one of several parallel reasoning threads in a self-evolving agent runtime.`,
    ``,
    `Your task: ${input.task}`,
    `Why you were spawned: ${input.rationale}`,
    `Merge strategy: ${input.mergeStrategy} (your work will be combined with sibling heads via this strategy).`,
    ``,
    ...renderHeadToolConventions(input, workspaceLayout, availableToolNames),
    ``,
    // At depth 0 split_subheads is not on the surface (head-tools.ts), so the clause is dropped.
    'Take the time the task needs: there is no time or token limit on this run.'
    + (input.budget.maxDepth > 0 ? ` You may split ${input.budget.maxDepth} more level(s) deep.` : ''),
  ].join('\n');
}

/**
 * Inherited messages keep their per-message structure, then the task. `inheritedContext` is
 * already capped per message by orchestrator/heads-support.ts.
 */
export function buildHeadMessages(input: HeadInput): ModelMessage[] {
  return [
    ...input.inheritedContext.map(inheritedAsModelMessage),
    // Last, so the task is the live instruction.
    { role: 'user', content: `Now focus on your assigned task: ${input.task}` },
  ];
}

/**
 * 'tool' cannot be role:'tool' (the SDK wants a matching tool-call id a SerializedMessage lacks) and 'system' would
 * compete with the head's system prompt, so both become user messages naming their role.
 */
export function inheritedAsModelMessage(m: SerializedMessage): ModelMessage {
  switch (m.role) {
    case 'user':
    case 'assistant':
      return { role: m.role, content: m.content };
    case 'tool':
      return { role: 'user', content: `[inherited tool result${m.toolName ? ` from ${m.toolName}` : ''}]\n${m.content}` };
    case 'system':
      return { role: 'user', content: `[inherited system note]\n${m.content}` };
  }
}

/** Ignores the head's last text: a mid-flight thought must not reach the parent as a finding. */
function incompleteHeadSummary(
  input: HeadInput,
  status: HeadReport['status'],
  capture: HeadCapture,
  abortReason: string | null,
): string {
  const recorded = synthesizeHeadSummary({
    decisions: capture.decisions, evidence: capture.evidence, toolCalls: capture.toolCalls,
  });

  return `Head ${input.id} did not complete (status=${status}${abortReason ? `; ${abortReason}` : ''}). `
    + (recorded ? `What it recorded before stopping: ${recorded}` : 'It produced no findings.');
}

interface ExhaustedMission {
  input: HeadInput;
  capture: HeadCapture;
  refusal: MissionBudgetRefusal;
  wallClockMs: number;
  stepCount: number;
}

function exhaustedMissionReport({ input, capture, refusal, wallClockMs, stepCount }: ExhaustedMission): HeadReport {
  return {
    id: input.id,
    status: 'budget_exceeded',
    summary: incompleteHeadSummary(input, 'budget_exceeded', capture, refusal.note),
    evidence: [...capture.evidence],
    decisions: [...capture.decisions],
    artifactRefs: [...capture.artifacts],
    fileChanges: capture.files.snapshot(),
    childHeadIds: [...capture.childHeadIds],
    toolCalls: [...capture.toolCalls],
    stepCount,
    usage: capture.usage,
    wallClockMs,
    errorMessage: refusal.note,
  };
}

export interface HeadInferenceDeps {
  /** The hosted actor this run is; heads and swarm nodes run on its session. */
  actor: HostedActor;
  /** Every turn is claimed under this run id, so a recovered re-admission is a new epoch of the same turn. */
  runId: string;
  delegation?: {
    readonly assignmentId: string;
    readonly birthContext: readonly ModelMessage[];
  };
  /** The run brings only its tools and its brief (orchestrator/turn-assembly.ts). */
  sources: RunTurnSources;
  compaction: { readonly state: CompactionTriggerReader & CompactionTriggerState; readonly key: string };
  /** Accumulator tools plus the backend's scratch tools; the caller controls the surface. */
  tools: ToolSet;
  /** In place of its role's section; it must name the file plane the tools reach. */
  brief?: (callable: readonly string[]) => string;
  capture: HeadCapture;
  /** Polled at step boundaries: an RPC boundary carries a flag, not an AbortSignal. */
  isAborted: () => boolean;
  /** Given to the SDK so an abort cuts the step in flight; a polled flag never sees a hang. */
  signal?: AbortSignal;
  /** Wall-time clock (D19). */
  clock: Clock;
  abortReason?: () => string | null;
  /**
   * The mission ledger this head charges; the only thing that stops a head for spending.
   * Omitted: the loop never asks, and an undeclared run must not touch the ledger.
   */
  mission?: MissionScope;
  /** The durable per-step trace; omitted only for a hosted recursive sub-head. */
  reportStep?: (seq: number, step: HeadStep) => Promise<void> | void;
  /** Live output while a step is produced: one call per provider delta, in order, never buffered. A cross-isolate transport must not await it. */
  reportDelta?: ReportHeadDelta;
  observeStream?: ObserveStream;
  /** Absent is the head's own. */
  opening?: readonly ModelMessage[];
  /**
   * The conversation this loop produced, handed over once for whatever settled. Absent for a head,
   * which merges findings rather than forking a conversation.
   */
  reportMessages?: (messages: readonly ModelMessage[]) => void;
  /** The next turn's messages, or `null` to end the run; absent is one turn (every head). A node's turn may end
   *  with detached work running; only `null` makes the run terminal. */
  resume?: () => Promise<readonly ModelMessage[] | null>;
  /** Hires a completed turn's advisor where the roster lives. Absent: this actor's own session hires it. */
  advise?: (turn: CompletedTurn, reachable: readonly string[], mode: WorkMode) => Promise<void>;
}


function runTurnSources(deps: HeadInferenceDeps, refused: (refusal: MissionBudgetRefusal) => void): TurnAssemblySources {
  const { mission, brief } = deps;
  const gate = mission === undefined ? undefined : missionGate(mission);

  const guard = async (seam: MissionSeam): Promise<MissionBudgetRefusal | null> => {
    const ruled = await gate?.guard(seam) ?? null;

    if (ruled !== null) refused(ruled);

    return ruled;
  };

  return {
    ...deps.sources,
    ...(gate !== undefined && { budget: { guard, debit: (tokens: number, opts: Parameters<SpendGate['debit']>[1]) => { gate.debit(tokens, opts); } } }),
    toolset: () => deps.tools,
    externalTools: async () => ({}),
    wiredToolNames: () => Object.keys(deps.tools).filter((name) => !BUILTIN_TOOL_NAMES.has(name)),
    codemodeCapabilities: () => [],
    ...(brief !== undefined && { brief: (callable: readonly string[]) => ({ id: 'run', label: 'Your task', instructions: brief(callable) }) }),
  };
}

/** Null ends the run. */
async function nextRunInput(
  deps: HeadInferenceDeps, overflowRetry: boolean,
): Promise<{ readonly kind: 'resume' | 'overflow-retry'; readonly messages: readonly ModelMessage[] } | null> {
  if (overflowRetry) return { kind: 'overflow-retry', messages: [{ role: 'user', content: OVERFLOW_RETRY_TEXT }] };
  const resumed = await deps.resume?.();

  return resumed ? { kind: 'resume', messages: resumed } : null;
}

/** True once the run's stream settled. */
function relayRunEvent(deps: HeadInferenceDeps, event: ChatEvent): boolean {
  recordExecutionEvent(deps.actor.stores.eventRecorder, deps.runId, event);

  if (event.type === 'text-delta') deps.reportDelta?.('text', event.delta);

  if (event.type === 'reasoning-delta') deps.reportDelta?.('reasoning', event.delta);

  return event.type === 'done';
}

function settleRunContext(deps: HeadInferenceDeps, turn: {
  readonly outcome: ActorExecutionResult;
  readonly execution: Omit<ActorExecutionInput, 'task'>;
  readonly historyLength: number;
  readonly contextWindow: number | null;
  readonly overflowRetry: boolean;
}): boolean {
  const { chat } = turn.execution;

  return settleExecutionContext({ ...deps.compaction, recorder: deps.actor.stores.eventRecorder }, {
    runId: deps.runId,
    failure: turn.outcome.failure === null ? null : renderThrownChain({ cause: turn.outcome.failure }),
    turnWasOverflowRetry: turn.overflowRetry,
    lastPromptTokens: deps.actor.session.orchestrator.acc.lastPromptTokens,
    historyLength: turn.historyLength,
    contextWindow: turn.contextWindow,
    model: chat.modelSpec ?? chat.modelContext?.id,
  });
}

/** The seat supplies the compaction state where the actor lives. */
export type RunInference = Omit<HeadInferenceDeps, 'compaction'>;

interface HeadOutcome {
  status: HeadReport['status'];
  stopReason: string | null;
}

/**
 * `status` and `stopReason` must name the same cut, so both come from one reading of the abort.
 * A throw the abort explains is not a failure; a real failure keeps its cause chain.
 */
function classifyHeadOutcome(
  deps: Pick<HeadInferenceDeps, 'isAborted' | 'abortReason'>,
  failure: KinuError | undefined,
): HeadOutcome {
  const aborted = deps.isAborted();

  if (failure !== undefined && !aborted) {
    return { status: 'errored', stopReason: renderThrownChain({ cause: failure }) };
  }

  const stopReason = deps.abortReason?.() ?? null;

  return { status: aborted ? 'aborted' : 'completed', stopReason };
}


interface CompletedTurnReview {
  session: ActorSession;
  input: HeadInput;
  deps: HeadInferenceDeps;
  lease: ActorTurnLease;
  outcome: ActorExecutionResult;
}

/** Hires the turn's advisor and returns: its note reaches this actor when it answers, after this turn. */
async function adviseCompletedTurn({ session, input, deps, lease, outcome }: CompletedTurnReview): Promise<void> {
  const turn = snapshotCompletedTurn(session.orchestrator, {
    userMessage: input.task, assistantResponse: outcome.text,
    turnId: `${deps.runId}:${lease.turnId}`, sessionId: input.id, origin: 'programmatic',
  });

  if (deps.advise !== undefined) return await deps.advise(turn, Object.keys(deps.tools), input.mode);

  if (!session.orchestrator.improvementLanesOpen('completed', input.mode)) return;

  await session.hireAdvisor(session.advisorSnapshot(turn, Object.keys(deps.tools)));
}

/** `kind` namespaces the canonical ids of the next turn's input. */
interface NextTurnInput {
  session: ActorSession;
  deps: HeadInferenceDeps;
  conversation: ModelMessage[];
  turnId: string;
  kind: 'resume' | 'overflow-retry';
  messages: readonly ModelMessage[];
}

async function appendNextTurnInput({ session, deps, conversation, turnId, kind, messages }: NextTurnInput): Promise<void> {
  for (const [part, message] of messages.entries()) {
    const reference = await session.canonical.append({ id: `${turnId}:${kind}:${part}`, message, origin: 'input', turnId, assertOwner: () => deps.actor.handle.assertCurrent() });
    conversation.push(await session.canonical.messages.materialize(reference));
  }
}

/** `interrupted` (cancel or budget cut) closes as aborted, not as a failure. */
function turnClaimOutcome(failed: boolean, interrupted: boolean): ClaimOutcome {
  if (failed) return 'error';

  if (interrupted) return 'aborted';

  return 'completed';
}

async function materializeMessages(session: ActorSession, references: readonly MessageReference[]): Promise<ModelMessage[]> {
  const messages: ModelMessage[] = [];

  for (const reference of references) messages.push(await session.canonical.messages.materialize(reference));

  return messages;
}

/** A report that fails becomes the run's failure, joined to any it already had. */
function reportConversation(deps: HeadInferenceDeps, input: HeadInput, conversation: readonly ModelMessage[], failure: KinuError | undefined): KinuError | undefined {
  try {
    deps.reportMessages?.(conversation);
  } catch (cause) {
    return toKinuError({
      doing: `report agent ${input.id} conversation`,
      cause: failure === undefined ? cause : new AggregateError([failure, cause], 'execution and conversation reporting failed'),
      otherwise: 'unavailable',
    });
  }

  return failure;
}

interface HeadSummaryInput {
  input: HeadInput;
  capture: HeadInferenceDeps['capture'];
  outcome: HeadOutcome;
  final: { text: string; reasoningText: string };
}

function headSummary({ input, capture, outcome, final }: HeadSummaryInput): string {
  const { status, stopReason } = outcome;

  if (status === 'errored') return `Head ${input.id} errored: ${stopReason ?? 'no reason reported'}`;

  if (status !== 'completed') return incompleteHeadSummary(input, status, capture, stopReason);

  // An empty final text: what the head recorded stands in for the answer.
  const finalText = extractFinalText(final);

  if (finalText !== '') return finalText;

  return synthesizeHeadSummary({ decisions: capture.decisions, evidence: capture.evidence, toolCalls: capture.toolCalls })
    ?? `Head ${input.id} completed without producing a textual summary.`;
}

/** The spawner's cancel becomes the session's own interrupt. Returns the bridge's release. */
function bridgeCancel(signal: AbortSignal | undefined, session: ActorSession): () => void {
  const cancelled = (): void => { session.interrupt(); };

  signal?.addEventListener('abort', cancelled, { once: true });

  return () => { signal?.removeEventListener('abort', cancelled); };
}

function streamRelay(deps: HeadInferenceDeps): { observeStream?: HeadInferenceDeps['observeStream'] } {
  return deps.observeStream === undefined ? {} : { observeStream: deps.observeStream };
}

/**
 * One reporting agent over the turns {@link HeadInferenceDeps.resume} grants, and its report. Never throws: a failure
 * is an `errored` report keeping the run's steps and usage. No turn reaches `AgentOrchestrator.recordTurn`
 * (tests/unit-headless-learning.test.ts).
 */
export async function runHeadInference(input: HeadInput, deps: HeadInferenceDeps): Promise<HeadReport> {
  const { capture, clock } = deps;
  const startedAt = clock.now();

  let refusal: MissionBudgetRefusal | null = null;

  const assertActive = (): void => {
    if (deps.isAborted()) throw new DOMException(deps.abortReason?.() ?? 'head was aborted', 'AbortError');
  };

  // One dense counter across every turn: `head_steps` is keyed `${id}-s${seq}`, so a per-turn
  // counter would overwrite earlier turns. Steps with no prose, reasoning or tool call are not recorded.
  let recorded = 0;
  let lastText = '';
  let lastReasoning = '';
  let canonicalClaim: ActorTurnClaim | null = null;
  const canonicalOutput: MessageReference[] = [];
  const canonicalParts: MessagePartReference[] = [];

  const session = deps.actor.session;
  const seed = deps.opening ? [...deps.opening] : buildHeadMessages(input);

  // Bridged before the first await, so a cancel during seed restore still interrupts.
  const unbridgeCancel = bridgeCancel(deps.signal, session);

  if (deps.delegation) await session.restoreWorkingHistory();
  else await session.restoreHistory(seed);
  const conversation: ModelMessage[] = [];

  const sources = runTurnSources(deps, (ruled) => { refusal ??= ruled; });

  /** A stream that died before its first step settles nothing; half a conversation is worse than none. */
  let settled = false;
  /** Classified with the natural path so an abort reads the same between or inside steps. */
  let failure: KinuError | undefined;

  const onStep = async (step: StepResult<ToolSet>, messages: readonly ModelMessage[]): Promise<void> => {
    if (step.reasoningText?.trim()) lastReasoning = step.reasoningText;
    recordRefusedCalls(step, capture);
    // Drawn as the transcript draws the recorded step, so a call keeps its id and a failure reads as one.
    const parts = v.parse(HeadStepPartsSchema, drawnStep(encodeModelMessageValues(messages)));

    if (parts.length > 0) {
      const seq = recorded++;

      // A failed trace write must not kill the work; the sink can be an RPC.
      try {
        await deps.reportStep?.(seq, { parts });
      } catch (err) {
        diagnostics.failure(
          'head.step_trace_failed',
          toKinuError({ doing: 'record a head step trace', cause: err, otherwise: 'io' }),
          { headId: input.id, seq },
        );
      }
    }

    const usage = normalizeUsage(step.usage);

    // An unreported step meters nothing.
    if (usageReported(usage)) capture.recordStepUsage(usage);
  };

  let overflowRetry = false;

  try {
    for (let index = 0; ; index++) {
      if (deps.isAborted()) break;

      // Derived, not minted: a recovered activation re-admits the same turn under the next epoch.
      const turnId = deps.delegation?.assignmentId ?? input.id;

      const lease = session.beginTurn(
        { runId: deps.runId, turnId: index === 0 ? turnId : `${turnId}#${index}` },
        input.mode, Date.now(),
      );

      try {
        if (index === 0 && deps.delegation) {
          const { birthContext } = deps.delegation;
          await session.openDelegatedTurn(lease, { messages: seed, birthContext: async () => birthContext });
        }

        // Per turn: a promotion or a moved profile lands between turns.
        const assembled = await assembleActorTurn(sources, { userText: input.task, workMode: input.mode, ...(input.model !== undefined && { model: input.model }) });
        session.bindProfile(lease, assembled.profile, assembled.profileInputs);

        const historyLength = session.history.length;

        const execution = withCompactionTrigger(assembled.execution, deps.compaction.state, deps.compaction.key, historyLength);

        const stopWhen = (): boolean => deps.isAborted();

        const outcome = await session.execute(lease, {
          ...execution,
          task: input.task,
          chat: { ...execution.chat, stopWhen, onStep, ...streamRelay(deps) },
          assertActive,
          scaffoldStreamOptions: { onStep, stopWhen },
        }, (event) => { settled = relayRunEvent(deps, event) || settled; });

        const retry = settleRunContext(deps, { outcome, execution, historyLength, contextWindow: assembled.window.contextWindow, overflowRetry });

        overflowRetry = retry;

        if (outcome.claim !== null) {
          canonicalClaim = outcome.claim;
          canonicalOutput.push(...outcome.outputReferences);
          canonicalParts.push(...outcome.outputPartReferences);
          conversation.push(...await materializeMessages(session, outcome.outputReferences));
        }

        const turnFailed = outcome.failure !== null;

        // A refused step is reported as over budget; an overflowed turn is retried.
        if (outcome.failure !== null && refusal === null && !retry) {
          failure = toKinuError({ doing: `run agent ${input.id} to a report`, cause: outcome.failure, otherwise: 'unavailable' });
        }

        // The runner's selected answer (chat.ts answerFromSteps), not `text`, which may be a synthesized stand-in.
        if (outcome.answer !== null) lastText = outcome.answer;

        if (!turnFailed && !outcome.interrupted) await adviseCompletedTurn({ session, input, deps, lease, outcome });

        session.settleTurnClaim(lease, turnClaimOutcome(turnFailed, outcome.interrupted));
      } finally {
        session.finishTurn(lease);
      }

      if (failure !== undefined || refusal !== null || deps.isAborted()) break;

      const next = await nextRunInput(deps, overflowRetry);

      if (next === null) break;
      await appendNextTurnInput({ session, deps, conversation, turnId: `${turnId}#${index + 1}`, ...next });
    }
  } catch (err) {
    failure = toKinuError({ doing: `run agent ${input.id} to a report`, cause: err, otherwise: 'unavailable' });
  } finally {
    unbridgeCancel();
  }

  if (settled) failure = reportConversation(deps, input, conversation, failure);

  if (refusal) {
    return exhaustedMissionReport({ input, capture, refusal, wallClockMs: clock.now() - startedAt, stepCount: recorded });
  }

  const outcome = classifyHeadOutcome(deps, failure);
  const { status, stopReason } = outcome;
  const summary = headSummary({ input, capture, outcome, final: { text: lastText, reasoningText: lastReasoning } });

  const canonicalCompletion = canonicalClaim === null ? undefined : {
    turnId: canonicalClaim.turnId, runId: canonicalClaim.runId, outputReferences: canonicalOutput, outputPartReferences: canonicalParts,
    finalTextReference: await session.recordTranscriptText(canonicalClaim, 'report', summary, canonicalOutput),
  };

  return {
    id: input.id, status, summary,
    canonicalCompletion,
    evidence: [...capture.evidence],
    decisions: [...capture.decisions],
    artifactRefs: [...capture.artifacts],
    fileChanges: capture.files.snapshot(),
    childHeadIds: [...capture.childHeadIds],
    toolCalls: [...capture.toolCalls],
    stepCount: recorded,
    usage: capture.usage,
    wallClockMs: clock.now() - startedAt,
    errorMessage: status === 'completed' ? undefined : stopReason ?? undefined,
  };
}
