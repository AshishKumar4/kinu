/**
 * Non-step model calls and their spend attribution. A call whose provider reported nothing still
 * writes a row, so unmeasured spend reads as unmeasured (`callsWithoutUsage`), never free.
 */

import type { Usage } from '../usage';
import { nanoid } from '../utils/nanoid';
import { renderThrownChain } from '../obs/index';

/** The attribution axis of workspace spend. `agent` covers `step_finish` rows in the total. */
export const SPEND_SOURCES = [
  'agent',
  'scaffold',
  'compaction',
  'judge',
  'fast',
  'reflection',
  'head',
  'mcts',
  'swarm',
  'platform',
  'advisor',
  'slate',
  'warming',
] as const;

export type SpendSource = (typeof SPEND_SOURCES)[number];

/** Keyed by the union so a new source cannot reach a surface unlabelled. */
export const SPEND_SOURCE_LABEL = {
  agent: 'Agents',
  scaffold: 'Scaffold loop',
  compaction: 'Compaction',
  judge: 'Judges',
  fast: 'Fast tier',
  reflection: 'Evolution',
  head: 'Exploration heads',
  mcts: 'MCTS rollouts',
  swarm: 'Swarm expansions',
  platform: 'Platform AI',
  advisor: 'Advisor',
  slate: 'Slates',
  warming: 'Cache warming',
} as const satisfies Readonly<Record<SpendSource, string>>;

export const SPEND_SOURCE_DETAIL = {
  agent: 'every step of every turn — chat, wake, reactor drain — of the main agent and every agent it hired',
  scaffold: 'an evolved scaffold driving its own inference loop',
  compaction: 'folding history when the context window fills',
  judge: 'grading this agent’s own work: ensemble, replay, branch scores, merge narrative',
  fast: 'the mechanical tier: outcome classification, extraction, titles, summaries',
  reflection: 'the evolution engine’s own reasoning, and GEPA',
  head: 'exploration heads, one loop per fork',
  mcts: 'rollout branches and their reflections',
  swarm: 'the expansion candidates of a configured search, and the measurements that '
    + 'score them — distinct from `mcts` because a swarm names its own axes and is '
    + 'scored by the objective\'s verifier rather than by a judge',
  platform: 'Workers AI utility bindings: memory embeddings and HTML→markdown '
    + 'repair. Neither returns a usage field of any kind, so these are counted '
    + 'and never measured — which is what the coverage fraction below is made of',
  advisor: 'the turn reviewer: one call after a turn ends, when it is switched on',
  slate: 'an authored slate\'s `ai` binding: one call per `shell`, at the tier the binding or the call named',
  warming: 'keeping an idle prompt-cache prefix alive: one zero-output replay of the last request, '
    + 'at most three per idle stretch (providers/cache-warming.ts)',
} as const satisfies Readonly<Record<SpendSource, string>>;

/**
 * `usage` is `{}` when the provider reported nothing. `spec` is the resolved `<provider>/<modelId>`
 * the catalog prices against; `modelId` is what the provider said served it.
 */
export interface ModelCallReport {
  readonly source: SpendSource;
  readonly usage: Usage;
  readonly spec?: string;
  readonly modelId?: string;
}

/** Aggregate spend; usage fields no call reported stay absent, and `usd` stays absent until some
 *  call was priced. */
export interface SpendTally {
  readonly calls: number;
  /** Real, unmeasured spend; omitted from `usage`. */
  readonly callsWithoutUsage: number;
  readonly usage: Usage;
  /** Absent when no call carried a rate: unpriced, never free. */
  readonly usd?: number;
  /** Measured in tokens, no catalog rate; one reason `usd` is a floor. */
  readonly unpricedCalls: number;
  /** Calls priced at a floor (`priceCall`'s `floorTokens`); nonzero means `usd` is under the
   *  real bill. Zero is a measurement here. */
  readonly floorPricedCalls: number;
}

/** Injected at construction so the seam holding the SDK result is the one place that reports. */
export type ModelCallSink = (report: ModelCallReport) => void;

/** Sink and label as one field so a shared seam (e.g. `generateJson`) cannot lose attribution. */
export interface ModelCallSpend {
  readonly source: SpendSource;
  readonly report: ModelCallSink;
  readonly operations?: ModelOperationSink;
}

/** Call shape only; paired with {@link SpendSource} it identifies the producer lane. */
export const MODEL_OPERATION_KINDS = ['complete', 'stream', 'generate_json'] as const;

export type ModelOperationKind = (typeof MODEL_OPERATION_KINDS)[number];

export const MODEL_OPERATION_PHASES = ['start', 'end'] as const;

export type ModelOperationPhase = (typeof MODEL_OPERATION_PHASES)[number];

/** `failed` covers throws and aborts alike. No clock is read: a missing end row means the process
 *  died, never a timeout verdict. */
export const MODEL_OPERATION_OUTCOMES = ['ok', 'failed'] as const;

export type ModelOperationOutcome = (typeof MODEL_OPERATION_OUTCOMES)[number];

/**
 * A start with no end is the signature of a destroyed frame
 * (`RunEventRecorder.unterminatedModelOperations`). `usage` rides the end row only.
 */
export interface ModelOperationEvent {
  readonly operationId: string;
  readonly source: SpendSource;
  readonly op: ModelOperationKind;
  readonly phase: ModelOperationPhase;
  readonly outcome?: ModelOperationOutcome;
  readonly usage?: Usage;
  readonly spec?: string;
  readonly modelId?: string;
  readonly error?: string;
}

/** Separate from {@link ModelCallSink}: start rows in the `model_call` census would double-count. */
export type ModelOperationSink = (event: ModelOperationEvent) => void;

const OPERATION_ERROR_MAX_CHARS = 300;

/** Random, not counted: a counter restarts at eviction and would collide with a prior life's ids. */
function newModelOperationId(): string {
  return `op-${nanoid(10)}`;
}

/** Exactly one end row is written; a frame never closed is evidence, not a leak. */
export interface ModelOperation {
  completed(result: { usage?: Usage; modelId?: string }): void;
  failed(into: { readonly cause: unknown }): void;
}

const UNWATCHED_OPERATION: ModelOperation = {
  completed(): void { /* no sink wired: nothing to record */ },
  failed(): void { /* no sink wired: nothing to record */ },
};

/** Call immediately before the provider call so the start row exists while it is in flight. */
export function beginModelOperation(
  spend: Pick<ModelCallSpend, 'source' | 'operations'> | ModelCallSpend | undefined,
  op: ModelOperationKind,
  detail?: { readonly spec?: string },
): ModelOperation {
  const sink = spend?.operations;

  if (!sink) return UNWATCHED_OPERATION;
  const operationId = newModelOperationId();
  const source = spend.source;
  const spec = detail?.spec;

  const base = spec === undefined
    ? { operationId, source, op }
    : { operationId, source, op, spec };

  sink({ ...base, phase: 'start' });
  // A stream consumer that drains then throws would otherwise close the frame twice.
  let settled = false;

  return {
    completed(result): void {
      if (settled) return;
      settled = true;
      const usage = result.usage ?? {};
      sink(result.modelId === undefined
        ? { ...base, phase: 'end', outcome: 'ok', usage }
        : { ...base, phase: 'end', outcome: 'ok', usage, modelId: result.modelId });
    },
    failed({ cause }): void {
      if (settled) return;
      settled = true;
      sink({
        ...base,
        phase: 'end',
        outcome: 'failed',
        error: renderThrownChain({ cause }).slice(0, OPERATION_ERROR_MAX_CHARS),
      });
    },
  };
}

/**
 * Run id for model calls made outside any run. Reserved rather than NULL because the log's key is
 * `(run_id, event_index)`; `RunEventRecorder.listRuns` hides it.
 */
export const WORKSPACE_RUN_ID = '_workspace';
