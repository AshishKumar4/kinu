/**
 * Named row adapters: fill every slot, digest identifiers, never throw. They take `env` rather
 * than an installed sink because a DO is a separate isolate where the Worker's sink is absent.
 */
import type { Usage } from '../../usage';
import { toKinuError, type ErrorCode } from '../error';
import { diagnostics } from '../log';
import { boundaryOf, eventFamily } from './boundaries';
import { analyticsDigest } from './privacy';
import {
  AGENT_METRICS_SCHEMA, CONTROL_PLANE_OPS_SCHEMA,
  type AnalyticsRow, type AnalyticsSchema,
} from './schemas';
import { analyticsPlane, type AnalyticsEnv, type AnalyticsWriter } from './writer';

/**
 * `''` means not attributable to one actor. Only the root writes rows: subordinates, heads and
 * branches run `runHeadInference` and record nothing, so fleet metrics omit their spend.
 */
export type AgentKind = 'orchestrator' | '';

/** `refused` and `failed` stay separate: pooling a correct refusal with a defect ruins the rate. */
export type RowOutcome = 'ok' | 'refused' | 'failed' | 'denied';

export type AgentRowKind = 'turn' | 'model' | 'tool' | 'ttft' | 'event';

type AgentRow = AnalyticsRow<typeof AGENT_METRICS_SCHEMA>;

type OpsRow = AnalyticsRow<typeof CONTROL_PLANE_OPS_SCHEMA>;

/** Absent fields default to `''`/0, never a plausible stand-in value. */
interface AgentRowInput {
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
  attempts?: number;
  usage?: Usage;
  usd?: number;
}

function agentRow(input: AgentRowInput): AgentRow {
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
    // Only the diagnostics path fills `reason`; typed rows carry the verdict in `outcome` + `code`.
    reason: '',
    count: 1,
    durationMs: input.durationMs ?? 0,
    ttftMs: input.ttftMs ?? 0,
    steps: input.steps ?? 0,
    toolCalls: input.toolCalls ?? 0,
    attempts: input.attempts ?? 0,
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

function recordAgentRow(env: AnalyticsEnv, row: AgentRowInput): void {
  emit(analyticsPlane(env).agent, agentRow(row));
}

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
  recordAgentRow(env, { kind: 'turn', event: 'turn.settled', ...input });
}

/** Its own row, so a turn that never streamed is absent rather than a zero. */
export interface TtftRowInput {
  readonly workspace: string;
  readonly agentKind: AgentKind;
  readonly provider: string;
  readonly model: string;
  readonly ttftMs: number;
}

export function recordTtftRow(env: AnalyticsEnv, input: TtftRowInput): void {
  recordAgentRow(env, { kind: 'ttft', event: 'turn.first_token', ...input });
}

export interface ModelRowInput {
  readonly workspace: string;
  readonly agentKind: AgentKind;
  readonly provider: string;
  readonly model: string;
  readonly source: string;
  readonly usage: Usage;
  readonly usd: number | undefined;
}

export function recordModelRow(env: AnalyticsEnv, input: ModelRowInput): void {
  recordAgentRow(env, { kind: 'model', event: 'model.call', ...input });
}

/** Never arguments or results: those carry workspace content. */
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

export interface JobRowInput {
  readonly workspace: string;
  readonly agentKind: AgentKind;
  /** `cancel` | `retry` | `dismiss` | `clear`; never the job id. */
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

/** One delivery of a durable container-failure announcement; success is a row too. */
export interface RecoveryRowInput {
  readonly workspace: string;
  /** `attach` | `checkpoint` | `process` | `port`; `''` when refused before a stage was read. */
  readonly stage: string;
  readonly outcome: RowOutcome;
  readonly code: ErrorCode | '';
  /** The producer's own count; an evicted Worker cannot derive it. */
  readonly attempts: number;
  /** Since the incident's first report; 0 for a refused envelope. */
  readonly durationMs: number;
}

export function recordSandboxRecovery(env: AnalyticsEnv, input: RecoveryRowInput): void {
  emit(analyticsPlane(env).agent, agentRow({
    kind: 'event',
    event: 'sandbox.recovery_settled',
    workspace: input.workspace,
    agentKind: 'orchestrator',
    source: input.stage,
    outcome: input.outcome,
    code: input.code,
    attempts: input.attempts,
    durationMs: input.durationMs,
  }));
}

/** Written to the control-plane dataset, beside the audit rows it is compared with. */
export interface ReleaseRowInput {
  /** Digested; never written raw. */
  readonly actor: string;
  /** `transition` | `deployment`. */
  readonly operation: string;
  /** Status or environment; a closed vocabulary, never free text. */
  readonly reason: string;
  /** The change id, digested. */
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
