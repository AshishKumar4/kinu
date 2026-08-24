/**
 * The named adapters a production call site uses to write one row.
 *
 * ## Why adapters rather than the writer
 *
 * Three things have to be true at every emit site and none of them should be
 * that site's problem:
 *
 *   1. EVERY SLOT IS FILLED. `AnalyticsRow` requires all of them, so a turn row
 *      still has to say something about `tool` and a tool row about `steps`. That
 *      is the point — position N always means one thing — but it means a call
 *      site spelling a literal row would be twenty fields of noise around the
 *      five it cares about. `agentRow` supplies the rest.
 *   2. THE IDENTIFIERS ARE DIGESTED. A workspace id is mission-derived user text.
 *      Leaving that to the call site is leaving it to be forgotten once.
 *   3. NOTHING THROWS. Every one of these runs inside a turn, a route handler or
 *      a `.catch()`. A telemetry write that can fail a turn is worse than no
 *      telemetry, so the one call that could throw is classified and reported
 *      through the same seam every other handled failure in this codebase uses.
 *
 * ## Why they take `env` rather than reading an installed sink
 *
 * A Durable Object is a different isolate from the Worker that routes to it, with
 * its own module-level state. A sink installed in `fetch` is NOT installed inside
 * `OrchestratorAgent`, so an implementation that reached for an installed
 * singleton would write nothing from the very sites that produce the most
 * valuable rows — with a green test suite, because a test installs the sink in
 * the same isolate it asserts in. Taking the environment makes correctness
 * independent of which isolate the call happens in, which is the only way to be
 * sure of it.
 */
import type { Usage } from '@kinu.run/core';
import { diagnostics, toKinuError, type ErrorCode } from '@kinu.run/core/obs';
import { boundaryOf, eventFamily } from './boundaries';
import { analyticsDigest } from './privacy';
import {
  AGENT_METRICS_SCHEMA, CONTROL_PLANE_OPS_SCHEMA,
  type AnalyticsRow, type AnalyticsSchema,
} from './schemas';
import { analyticsPlane, type AnalyticsEnv, type AnalyticsWriter } from './writer';

/**
 * Which kind of actor produced a row. A closed union because the alternative —
 * each call site spelling a string — is how a dataset ends up with
 * `'orchestrator'`, `'Orchestrator'` and `'cf-orchestrator'` as three values of
 * one dimension. Empty is legal and means the row is not attributable to one
 * actor, which a route handler's row is not.
 */
export type AgentKind = 'orchestrator' | 'subordinate' | 'exploration' | 'node' | '';

/**
 * How an operation ended. `refused` and `failed` are separate for the reason
 * `CODE_IS_REFUSAL` exists in core: a rate that pools a correct refusal with a
 * defect is worse than no rate.
 */
export type RowOutcome = 'ok' | 'refused' | 'failed' | 'denied';

/** What an agent-metrics row is about. Blob 1, because it is the first predicate
 *  of every query over this dataset. */
export type AgentRowKind = 'turn' | 'model' | 'tool' | 'ttft' | 'event';

type AgentRow = AnalyticsRow<typeof AGENT_METRICS_SCHEMA>;
type OpsRow = AnalyticsRow<typeof CONTROL_PLANE_OPS_SCHEMA>;

/**
 * A complete agent-metrics row from the fields a call site actually has.
 *
 * Defaults are the empty string and zero, never a plausible stand-in: a tool row
 * whose `steps` read 1 would be indistinguishable from a one-step turn under an
 * aggregate that forgot to filter on `kind`.
 */
function agentRow(input: {
  kind: AgentRowKind;
  event: string;
  workspace: string;
  outcome?: RowOutcome;
  code?: ErrorCode | '';
  agentKind?: AgentKind;
  provider?: string;
  model?: string;
  tool?: string;
  source?: string;
  durationMs?: number;
  ttftMs?: number;
  steps?: number;
  toolCalls?: number;
  usage?: Usage;
  usd?: number;
}): AgentRow {
  const usage = input.usage ?? {};
  return {
    workspace: analyticsDigest(input.workspace),
    kind: input.kind,
    family: eventFamily(input.event),
    event: input.event,
    outcome: input.outcome ?? 'ok',
    code: input.code ?? '',
    boundary: boundaryOf(input.event),
    agentKind: input.agentKind ?? '',
    provider: input.provider ?? '',
    model: input.model ?? '',
    tool: input.tool ?? '',
    source: input.source ?? '',
    // Structurally empty here. A typed row's verdict is already fully carried by
    // `outcome` plus `code`; the slot exists for the diagnostics path, where a
    // refusal's deciding ARM is a fact neither of those two can hold.
    reason: '',
    count: 1,
    durationMs: input.durationMs ?? 0,
    ttftMs: input.ttftMs ?? 0,
    steps: input.steps ?? 0,
    toolCalls: input.toolCalls ?? 0,
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    reasoning: usage.reasoning ?? 0,
    neurons: usage.neurons ?? 0,
    usd: input.usd ?? 0,
    priced: input.usd === undefined ? 0 : 1,
  };
}

/**
 * Hand one row to one writer, reporting a failure rather than raising it.
 *
 * The `catch` classifies and reports, which is the same discipline
 * `reportModelCall` follows one layer up: a telemetry write is exactly the kind
 * of side effect whose failure must not become the caller's.
 */
function emit<S extends AnalyticsSchema>(writer: AnalyticsWriter<S>, row: AnalyticsRow<S>): void {
  try {
    writer.write(row);
  } catch (err) {
    diagnostics.failure('analytics.write_failed', toKinuError({
      doing: 'writing an analytics data point',
      cause: err,
      otherwise: 'unavailable',
    }));
  }
}

/** A settled turn: what it cost, how long it took, and how it ended. */
export interface TurnRowInput {
  readonly workspace: string;
  readonly agentKind: AgentKind;
  readonly provider: string;
  readonly model: string;
  readonly outcome: RowOutcome;
  readonly code: ErrorCode | '';
  readonly durationMs: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly usage: Usage;
  /** Absent when the call could not be priced at a rate that was its own. */
  readonly usd: number | undefined;
}

export function recordTurnRow(env: AnalyticsEnv, input: TurnRowInput): void {
  emit(analyticsPlane(env).agent, agentRow({ kind: 'turn', event: 'turn.settled', ...input }));
}

/**
 * Time to first token, from the turn's own start to its first streamed chunk.
 *
 * A separate row rather than a field on the turn row, because it is known
 * hundreds of milliseconds into a turn that may run for minutes and a turn that
 * never streamed anything must be visibly absent here rather than present with a
 * zero.
 */
export interface TtftRowInput {
  readonly workspace: string;
  readonly agentKind: AgentKind;
  readonly provider: string;
  readonly model: string;
  readonly ttftMs: number;
}

export function recordTtftRow(env: AnalyticsEnv, input: TtftRowInput): void {
  emit(analyticsPlane(env).agent, agentRow({ kind: 'ttft', event: 'turn.first_token', ...input }));
}

/** One model request: the turn loop's steps and every producer outside it. */
export interface ModelRowInput {
  readonly workspace: string;
  readonly agentKind: AgentKind;
  readonly provider: string;
  readonly model: string;
  /** Which producer asked — the turn loop, a judge, the fast tier, evolution. */
  readonly source: string;
  readonly usage: Usage;
  readonly usd: number | undefined;
}

export function recordModelRow(env: AnalyticsEnv, input: ModelRowInput): void {
  emit(analyticsPlane(env).agent, agentRow({ kind: 'model', event: 'model.call', ...input }));
}

/**
 * One finished tool call. Name, verdict, duration — never arguments and never a
 * result: those are whatever the user's workspace contains.
 */
export interface ToolRowInput {
  readonly workspace: string;
  readonly agentKind: AgentKind;
  readonly tool: string;
  readonly failed: boolean;
  readonly durationMs: number;
}

export function recordToolRow(env: AnalyticsEnv, input: ToolRowInput): void {
  emit(analyticsPlane(env).agent, agentRow({
    kind: 'tool',
    event: 'tool.settled',
    workspace: input.workspace,
    agentKind: input.agentKind,
    tool: input.tool,
    outcome: input.failed ? 'failed' : 'ok',
    durationMs: input.durationMs,
    toolCalls: 1,
  }));
}

/** A background job's lifecycle operation and whether it took effect. */
export interface JobRowInput {
  readonly workspace: string;
  readonly agentKind: AgentKind;
  /** `cancel` | `retry` | `dismiss` | `clear` — the operation, not the job id: a
   *  job id is high-cardinality and answers no fleet question. */
  readonly operation: string;
  readonly outcome: RowOutcome;
}

export function recordJobSettled(env: AnalyticsEnv, input: JobRowInput): void {
  emit(analyticsPlane(env).agent, agentRow({
    kind: 'event',
    event: 'job.settled',
    workspace: input.workspace,
    agentKind: input.agentKind,
    source: input.operation,
    outcome: input.outcome,
  }));
}

/**
 * A release change moving status, or a deployment recorded against one.
 *
 * On the control-plane dataset rather than the agent one: a release is an
 * operator action over a user's account, and it belongs beside the audit rows a
 * reader compares it with.
 */
export interface ReleaseRowInput {
  /** The acting user's id or address. Digested here — never written raw. */
  readonly actor: string;
  /** `transition` or `deployment`. */
  readonly operation: string;
  /** The status moved to, or the environment deployed to. A closed vocabulary
   *  from the release store, never free text. */
  readonly reason: string;
  /** The change id. Digested: it identifies one user's work. */
  readonly target: string;
  readonly outcome: RowOutcome;
  readonly code: ErrorCode | '';
}

export function recordReleaseTransition(env: AnalyticsEnv, input: ReleaseRowInput): void {
  emit(analyticsPlane(env).ops, {
    actor: analyticsDigest(input.actor),
    kind: 'op',
    operation: `release_${input.operation}`,
    outcome: input.outcome,
    code: input.code,
    targetKind: 'release_change',
    reason: input.reason,
    target: analyticsDigest(input.target),
    count: 1,
    durationMs: 0,
    affected: 1,
  } satisfies OpsRow);
}
