// Backend-agnostic run of a reporting agent (a head, or a swarm node via
// strategy/node-agent.ts). Every turn is a claimed actor turn on `ActorSession`.
// Inherited context: docs/EXPLORATION.md "Inherited context".

import type { ServedStores } from '../tools/actor-stores';
import { operationTool } from '../tools/operation-surfaces';
import { defineOperation, serve } from '../operations/operation';
import { type ToolSet, type ModelMessage, type StepResult } from 'ai';
import type { ObserveStream } from '../chat';
import type { HostedActor, SeatedActor } from '../state/actor-host';
import type { WorkMode } from '../types/turn';
import {
  EVIDENCE_KINDS,
  HeadStepPartsSchema, type HeadInput, type HeadReport, type HeadId, type HeadStep, type SerializedMessage,
  type Evidence, type Decision, type ArtifactRef,
} from './types';
import type { ToolCallRecord } from '../evolution/types';
import { missionGate, type MissionBudgetRefusal, type MissionGate, type MissionScope, type MissionSeam, type SpendGate } from '../mission-budget';
import { addUsage, normalizeUsage, usageReported, type Usage } from '../usage';
import { nanoid } from '../utils/nanoid';
import { extractFinalText, synthesizeHeadSummary } from './head-summary';
import { drawnStep } from '../session/transcript';
import { encodeModelMessageValues } from '../session/message-codec';
import { HeadFileChanges } from './file-changes';
import type { ReportHeadDelta } from './head-stream';
import * as v from 'valibot';
import { attempt, diagnostics, hold, renderThrownChain, settle, toKinuError, type KinuError } from '../obs/index';
import { Cause, Effect, Exit } from 'effect';
import { BUILTIN_TOOL_NAMES } from '../tools/registry';
import { assembleActorTurn, withCompactionTrigger, type RunTurnSources, type TurnAssemblySources } from '../orchestrator/turn-assembly';
import type { CompactionTriggerReader } from '../orchestrator/turn-context';
import { improvementLanesOpen } from '../orchestrator/evolution-lanes';
import type { ActorTurnClaim, ClaimOutcome, PreparingClaim } from '../orchestrator/actor-claims';
import type { ActorExecutionInput, ActorExecutionResult, ActorSession, ActorTurnLease } from '../orchestrator/actor-session';
import type { ChatEvent } from '../chat';
import type { MessageReference, MessagePartReference } from '../session/messages';
import { recordExecutionEvent, settleExecutionContext, snapshotCompletedTurn, type CompactionTriggerState } from '../orchestrator/turn-lifecycle';
import { driveExecution, type AssembledRound } from '../orchestrator/execution-driver';
import type { TurnCapability } from '../orchestrator/execution';
import { OVERFLOW_RETRY_TEXT } from '../turn-failure';
import type { CompletedTurn } from '../evolution/types';

/** A run's round as it assembled: what its projection reads of its preparation. */
interface HeadRound extends AssembledRound {
  readonly execution: Omit<ActorExecutionInput, 'task'>;
  readonly historyLength: number;
  readonly contextWindow: number | null;
}

/** The claim a run's answer is recorded under: its newest round's that claimed. */
interface CanonicalAnswer {
  claim: ActorTurnClaim | null;
}

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
}

import type { Clock } from '../types/clock';

/** A head's accumulators: what it gathered and decided, for the merge synthesis to read. Plan heads keep both. */
const HEAD_RECORDS = {
  evidence: defineOperation({
    ns: 'head', name: 'recordEvidence', slate: false, impact: 'mutate', plan: true,
    help: "Record a piece of evidence you've gathered. Use this for facts you want surfaced in the merge synthesis.",
    input: v.strictObject({
      kind: v.picklist(EVIDENCE_KINDS), body: v.string(), ref: v.optional(v.string()),
      // Shown, not checked: an out-of-range confidence is still evidence.
      confidence: v.optional(v.pipe(v.number(), v.metadata({ minimum: 0, maximum: 1 }))),
    }),
    output: v.string(),
  }),
  decision: defineOperation({
    ns: 'head', name: 'recordDecision', slate: false, impact: 'mutate', plan: true,
    help: 'Record a decision the head considered.',
    input: v.strictObject({ question: v.string(), choice: v.string(), rationale: v.string(), supportingEvidence: v.optional(v.array(v.string())) }),
    output: v.string(),
  }),
} as const;

export function buildHeadAccumulatorTools(capture: HeadCapture): ToolSet {
  return {
    record_evidence: operationTool(HEAD_RECORDS.evidence.help, serve(HEAD_RECORDS.evidence, async ({ kind, body, ref, confidence }) => {
      const ev: Evidence = { id: `ev-${nanoid(6)}`, kind, body, ref, confidence };

      capture.recordEvidence(ev);

      return `evidence recorded (id=${ev.id})`;
    })),
    record_decision: operationTool(HEAD_RECORDS.decision.help, serve(HEAD_RECORDS.decision, async ({ question, choice, rationale, supportingEvidence }) => {
      const d: Decision = { question, choice, rationale, supportingEvidence };

      capture.recordDecision(d);

      return 'decision recorded';
    })),
  };
}

const HEAD_PROMPT_TOOL_NAMES = ['record_evidence', 'record_decision', 'split_subheads'] as const;

/**
 * Each head writes in a checkout of its own: concurrent commits in one checkout fail on its index lock. The cloud
 * workspace's git has no `git worktree` and clones only over http(s), so a head copies the repository into its own
 * folder there; a real git (the computer, a device, the CLI's machine) takes a linked worktree. Measured on staging,
 * 2026-10-21: `git worktree` is "not a git command" on the workspace, a local-path clone fails, and `cp -r` then a
 * commit works; on the computer all three work.
 */
function gitIsolation(headId: string): string {
  const own = `head-${headId.slice(0, 8)}`;

  return 'Never commit in a git checkout a sibling may also write: commits from several heads in one checkout fail on '
    + 'its index lock, so make your own before you change anything. Where git has no worktrees (the cloud workspace\'s '
    + `git has none and clones only over http), copy the repository into your own folder: \`cp -r <repo> ~/${own}\`, `
    + `then work there. Where git is real (the computer, a device), add a worktree: \`git worktree add ../${own} <branch>\`.`;
}

/** Only what is a head's own: the tools every agent has are described by the system prompt and their schemas. */
function renderHeadConventions(input: HeadInput, availableToolNames?: readonly string[]): string[] {
  const tools = new Set(availableToolNames ?? HEAD_PROMPT_TOOL_NAMES);
  const lines: string[] = ['Conventions:'];

  if (tools.has('record_evidence')) lines.push('- record_evidence whenever you learn something worth surfacing in the merge.');

  if (tools.has('record_decision')) lines.push('- record_decision when you make a substantive choice the parent might want to reconcile.');

  lines.push(tools.has('split_subheads')
    ? '- split_subheads to recursively explore deeper if needed (depth-budgeted).'
    : '- Do not propose recursive subheads; split_subheads is not available in this run.');

  lines.push(
    '- Final text response: 2-4 sentences summarizing what you found + recommending what should happen next.',
    '- Stay focused on YOUR task. Don\'t try to do sibling heads\' work.',
  );

  return [...lines, '', input.mode === 'plan'
    ? 'You are ONE OF SEVERAL Plan research heads with read access to the parent workspace. Inspect it read-only, do not create scratch files or worktrees, and return evidence and recommendations to the parent plan.'
    : `You are ONE OF SEVERAL heads running concurrently against the same agent's resources. When you touch a SHARED MUTABLE resource, isolate yourself so you don't race a sibling. ${gitIsolation(input.id)} For shared files, write under your own head-namespaced path (\`shared/findings/${input.id}/...\` in the parent workspace). Read-only inspection of shared resources is always fine.`];
}

export function buildHeadSystemPrompt(input: HeadInput, availableToolNames?: readonly string[]): string {
  return [
    `You are a "head": one of several parallel reasoning threads in a self-evolving agent runtime.`,
    ``,
    `Your task: ${input.task}`,
    `Why you were spawned: ${input.rationale}`,
    `Merge strategy: ${input.mergeStrategy} (your work will be combined with sibling heads via this strategy).`,
    ``,
    ...renderHeadConventions(input, availableToolNames),
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
  /** The run brings only its tools and its brief (orchestrator/turn-assembly.ts). */
  sources: RunTurnSources;
  compaction: { readonly state: CompactionTriggerReader & CompactionTriggerState; readonly key: string };
  /** Accumulator tools plus the backend's scratch tools; the caller controls the surface. */
  tools: ToolSet;
  /** The store operations `tools` run, which its programs and scaffold run too; null in an agent's isolate, whose tools
   *  and programs the workspace runs. */
  stores: ServedStores | null;
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


function runTurnSources(deps: HeadInferenceDeps, gate: MissionGate | undefined, refused: (refusal: MissionBudgetRefusal) => void): TurnAssemblySources {
  const { brief } = deps;

  const guard = async (seam: MissionSeam): Promise<MissionBudgetRefusal | null> => {
    const ruled = await gate?.guard(seam) ?? null;

    if (ruled !== null) refused(ruled);

    return ruled;
  };

  return {
    ...deps.sources,
    ...(gate !== undefined && { budget: { guard, debit: (tokens: number, opts: Parameters<SpendGate['debit']>[1]) => { gate.debit(tokens, opts); } } }),
    toolset: () => ({ tools: deps.tools, stores: deps.stores }),
    externalTools: async () => ({}),
    wiredToolNames: () => Object.keys(deps.tools).filter((name) => !BUILTIN_TOOL_NAMES.has(name)),
    codemodeCapabilities: () => [],
    ...(brief !== undefined && { brief: (callable: readonly string[]) => ({ id: 'run', label: 'Your task', instructions: brief(callable) }) }),
  };
}

async function lastCharge(gate: MissionGate | undefined, id: string): Promise<KinuError | undefined> {
  if (gate === undefined) return undefined;
  const doing = `charge agent ${id}'s last step to its mission`;
  const charged = await hold(attempt({ doing, otherwise: 'unavailable' }, () => gate.settled()));

  return Exit.isFailure(charged) ? toKinuError({ doing, cause: Cause.squash(charged.cause), otherwise: 'unavailable' }) : undefined;
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
    failure: turn.outcome.failure,
    turnWasOverflowRetry: turn.overflowRetry,
    lastPromptTokens: deps.actor.session.orchestrator.acc.lastPromptTokens,
    historyLength: turn.historyLength,
    contextWindow: turn.contextWindow,
    model: chat.modelSpec,
  });
}

/** The seat supplies the compaction state where the actor lives, and runs it on the actor's session. */
export type RunInference = Omit<HeadInferenceDeps, 'compaction' | 'actor' | 'stores'> & { readonly actor: SeatedActor; readonly stores: ServedStores };

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

  if (!improvementLanesOpen('completed', input.mode)) return;

  await session.advisor.hire(session.advisor.snapshot(turn, Object.keys(deps.tools)));
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

/** A run as its host hands it over before its preparation: the key its first round is claimed under, and its seat. */
export interface HeadRun {
  readonly key: { readonly turnId: HeadId; readonly runId: string; readonly mode: WorkMode };
  readonly actor: HostedActor;
  /**
   * Under a round's capability: the first round's, claimed `preparing` before any of it (design v2 §2-§3), prepares the
   * run's input and what its first round assembles from, and a failure settles that claim `error`; each later round's,
   * claimed as it opens, binds what that round's calls carry (its input is the first's).
   */
  prepare(capability: TurnCapability): Promise<{ readonly input: HeadInput; readonly deps: HeadInferenceDeps }>;
}

/** A run whose host prepared it already, as one process holds both: its preparation is what it was handed. */
export function preparedHeadRun(input: HeadInput, deps: HeadInferenceDeps): HeadRun {
  return { key: { turnId: input.id, runId: deps.runId, mode: input.mode }, actor: deps.actor, prepare: async () => ({ input, deps }) };
}

/**
 * One reporting agent over the turns {@link HeadInferenceDeps.resume} grants, and its report. Its first round is
 * claimed before it is prepared; each round is then the common driver's ({@link driveExecution}), the run supplying its
 * assembly, the projection of each round into its report, and the next round's input. Never throws once prepared: a
 * failure is an `errored` report keeping the run's steps and usage. No turn reaches `AgentOrchestrator.recordTurn`
 * (tests/unit-headless-learning.test.ts).
 */
export async function runHeadInference(run: HeadRun): Promise<HeadReport> {
  const session = run.actor.session;
  const reserved = session.reserveExecution(run.key, run.key.mode);

  const capability = { actorId: session.actorId, turnId: reserved.turnId, runId: reserved.runId, epoch: reserved.epoch };

  // A preparation that failed settles the claim it was reserved under, and fails as it failed.
  return await settle(Effect.promise(() => run.prepare(capability)).pipe(
    Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => { session.settleReserved(reserved, 'error'); }))),
    Effect.flatMap((prepared) => Effect.promise(() => inferPrepared(prepared.input, prepared.deps, reserved, async (later) => (await run.prepare(later)).deps))),
  ));
}

/** What a round's calls run under: what its preparation bound to the round's capability, and its mission gate. */
interface BoundRound {
  readonly deps: HeadInferenceDeps;
  readonly gate: MissionGate | undefined;
  readonly sources: TurnAssemblySources;
}

async function inferPrepared(
  input: HeadInput, deps: HeadInferenceDeps, reserved: PreparingClaim, rebind: (capability: TurnCapability) => Promise<HeadInferenceDeps>,
): Promise<HeadReport> {
  const { capture, clock } = deps;
  const startedAt = clock.now();

  let refusal: MissionBudgetRefusal | null = null;

  const assertActive = (): void => {
    if (deps.isAborted()) throw new DOMException(deps.abortReason?.() ?? 'head was aborted', 'AbortError');
  };

  // One dense counter across every turn: `head_steps` is keyed by head and seq, so a per-turn
  // counter would overwrite earlier turns. Steps with no prose, reasoning or tool call are not recorded.
  let recorded = 0;
  let lastText = '';
  let lastReasoning = '';
  // Set by a round's projection, which the compiler does not follow into.
  const canonical: CanonicalAnswer = { claim: null };
  const canonicalOutput: MessageReference[] = [];
  const canonicalParts: MessagePartReference[] = [];

  const session = deps.actor.session;
  const seed = deps.opening ? [...deps.opening] : buildHeadMessages(input);

  // Bridged before the first await, so a cancel during seed restore still interrupts.
  const unbridgeCancel = bridgeCancel(deps.signal, session);

  const conversation: ModelMessage[] = [];

  const bindRound = (bound: HeadInferenceDeps): BoundRound => {
    const gate = bound.mission === undefined ? undefined : missionGate(bound.mission);

    return { deps: bound, gate, sources: runTurnSources(bound, gate, (ruled) => { refusal ??= ruled; }) };
  };

  // The first round's, prepared under the claim reserved for it; each later round's is bound under its own as it opens.
  let current = bindRound(deps);

  /** A stream that died before its first step settles nothing; half a conversation is worse than none. */
  let settled = false;
  /** Classified with the natural path so an abort reads the same between or inside steps. */
  let failure: KinuError | undefined;

  const onStep = async (step: StepResult<ToolSet>, messages: readonly ModelMessage[]): Promise<void> => {
    if (step.reasoningText?.trim()) lastReasoning = step.reasoningText;
    // Drawn as the transcript draws the recorded step, so a call keeps its id and a failure reads as one.
    const parts = v.parse(HeadStepPartsSchema, drawnStep(encodeModelMessageValues(messages)));

    if (parts.length > 0) {
      const seq = recorded++;

      // A failed trace write must not kill the work; the sink can be an RPC.
      try {
        await current.deps.reportStep?.(seq, { parts });
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

  // The round's calls as the session's own ledger recorded them, a refused one included; its next turn starts it over.
  const roundCalls = (): void => { capture.toolCalls.push(...session.orchestrator.acc.toolCalls); };

  try {
    // Restored while no round is active, so it replaces the history rather than staging a proposal. A run an execution
    // before this one answered keeps its branch, which holds the answer this one closes over without asking again.
    const answered = reserved.previous?.answered === true && reserved.previous.runId === reserved.runId;

    if (!answered) await session.restoreHistory(seed);

    await driveExecution<HeadRound>(session, {
      runId: deps.runId, turnId: input.id, mode: input.mode, isAborted: deps.isAborted, reserved,
      assemble: async (round) => {
        // A later round's calls carry its own opening: the run binds them under the round's claim.
        if (round.index > 0) current = bindRound(await rebind(round.capability));

        const { sources, deps: bound } = current;

        const assembled = await assembleActorTurn({
          ...sources,
          // Bound to the round as it resolves, then the host's own settle (a facet carries it on its first pace).
          settle: async (profile, inputs) => {
            round.bind(profile, inputs);
            await sources.settle?.(profile, inputs);
          },
        }, { userText: input.task, workMode: input.mode, ...(input.model !== undefined && { model: input.model }), ...(round.frozen !== null && { frozen: round.frozen }) });

        const historyLength = session.history.length;
        const execution = withCompactionTrigger(assembled.execution, bound.compaction.state, bound.compaction.key, historyLength);
        const stopWhen = (): boolean => deps.isAborted();

        return {
          execution, historyLength, contextWindow: assembled.window.contextWindow,
          input: {
            ...execution,
            task: input.task,
            chat: { ...execution.chat, stopWhen, onStep, ...streamRelay(bound) },
            assertActive,
            scaffoldStreamOptions: { onStep, stopWhen },
          },
          onEvent: (event: ChatEvent) => { settled = relayRunEvent(bound, event) || settled; },
        };
      },
      project: async ({ lease, assembled, outcome }) => {
        roundCalls();
        const retry = settleRunContext(current.deps, { outcome, execution: assembled.execution, historyLength: assembled.historyLength, contextWindow: assembled.contextWindow, overflowRetry });

        overflowRetry = retry;

        if (outcome.claim !== null) {
          canonical.claim = outcome.claim;
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

        if (!turnFailed && !outcome.interrupted) await adviseCompletedTurn({ session, input, deps: current.deps, lease, outcome });

        return { claim: turnClaimOutcome(turnFailed, outcome.interrupted), stop: failure !== undefined || refusal !== null };
      },
      failed: async ({ lease, failure: cause }) => {
        roundCalls();
        failure = toKinuError({ doing: `run agent ${input.id} to a report`, cause, otherwise: 'unavailable' });

        return lease.signal.aborted || deps.isAborted() ? 'aborted' : 'error';
      },
      next: async ({ index }) => {
        // The round's charges land under its own opening before a next round's is made.
        failure = await lastCharge(current.gate, input.id);

        if (failure !== undefined) return null;
        // Asked under the round that just ended, whose opening the next round's has not yet replaced.
        const next = await nextRunInput(current.deps, overflowRetry);

        if (next === null) return null;
        const turnId = `${input.id}#${index + 1}`;

        await appendNextTurnInput({ session, deps, conversation, turnId, ...next });

        return turnId;
      },
    });
  } catch (err) {
    failure = toKinuError({ doing: `run agent ${input.id} to a report`, cause: err, otherwise: 'unavailable' });
    // Its first round never began: its claim ends with it.
    session.settleReserved(reserved, 'error');
  } finally {
    unbridgeCancel();
  }

  // Joined on every path: a run never settles past a step its mission has not been charged for.
  failure ??= await lastCharge(current.gate, input.id);

  if (settled) failure = reportConversation(deps, input, conversation, failure);

  if (refusal) {
    return exhaustedMissionReport({ input, capture, refusal, wallClockMs: clock.now() - startedAt, stepCount: recorded });
  }

  const outcome = classifyHeadOutcome(deps, failure);
  const { status, stopReason } = outcome;
  const summary = headSummary({ input, capture, outcome, final: { text: lastText, reasoningText: lastReasoning } });

  const canonicalClaim = canonical.claim;

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
