/**
 * A model call that is not a turn step — WHO made it, and what it cost.
 *
 * The step telemetry answers "what did this agent's own turns cost". It cannot
 * answer "what did this WORKSPACE cost", because a workspace runs models the
 * turn loop never sees: the outcome-ensemble judges, the fast tier behind every
 * classification and title, the evolution engine's own reflection and GEPA,
 * exploration heads, MCTS rollout branches, compaction folds, an evolved
 * scaffold's own inference loop, a sandbox program's `llm.query`, and the memory
 * embedder. Every one of them used to discard the provider's usage report on the
 * line that received it, so the panel's figure was the orchestrator's own turns
 * and said nothing about the rest — while looking like it said everything.
 *
 * NOT A SECOND STORE. This is one more row type in the durable run-event log the
 * step telemetry already reads, carrying the same {@link Usage} the step rows
 * carry plus the one field they have no need for: which producer spent it.
 * `step_finish` is deliberately left alone rather than given a `source` — a
 * judge's cold prompt folded into the turn loop's prefix-cache EMA would corrupt
 * exactly the measurement that EMA exists for.
 *
 * A call whose provider reported nothing STILL WRITES A ROW, with `usage`
 * absent. That is the point: unmeasured spend is visible as unmeasured
 * (`callsWithoutUsage`), never as free. A producer that cannot report at all —
 * Workers AI embeddings and `toMarkdown` return no usage field of any kind — is
 * therefore counted, and its silence is what the coverage fraction is made of.
 */

import type { Usage } from '../usage';
import { nanoid } from '../utils/nanoid';
import { renderThrownChain } from '../obs/index';

/**
 * Which producer issued a model call. The attribution axis of a workspace's
 * spend: "where did $12 go" is a group-by over this.
 *
 * One entry per producer the census found, collapsed to the granularity a
 * reader can act on — a reader who sees `judge` does not need to know whether it
 * was the ensemble, the replay judge or a branch score, but a reader who sees
 * `head` vs `mcts` is looking at two different delegation strategies with two
 * different cost profiles, and that distinction changes what they do next.
 *
 * `agent` is here even though the turn loop writes `step_finish` rather than
 * `model_call`: the workspace total groups both row kinds by this axis, so the
 * main agent needs a seat in it.
 */
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
  'sandbox',
  'platform',
  'advisor',
] as const;

export type SpendSource = (typeof SPEND_SOURCES)[number];

/** What each producer is, for a reader who did not write it. Keyed by the union
 *  so a source added above cannot reach a surface unlabelled. */
export const SPEND_SOURCE_LABEL = {
  agent: 'Main agent',
  scaffold: 'Scaffold loop',
  compaction: 'Compaction',
  judge: 'Judges',
  fast: 'Fast tier',
  reflection: 'Evolution',
  head: 'Exploration heads',
  mcts: 'MCTS rollouts',
  swarm: 'Swarm expansions',
  sandbox: 'Sandbox llm.query',
  platform: 'Platform AI',
  advisor: 'Advisor',
} as const satisfies Readonly<Record<SpendSource, string>>;

/** One sentence per producer saying what actually fires it — the difference
 *  between a legend and an answer. */
export const SPEND_SOURCE_DETAIL = {
  agent: 'every step of every turn — chat, wake, reactor drain',
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
  sandbox: 'llm.query issued by a codemode or scaffold program',
  platform: 'Workers AI utility bindings: memory embeddings and HTML→markdown '
    + 'repair. Neither returns a usage field of any kind, so these are counted '
    + 'and never measured — which is what the coverage fraction below is made of',
  advisor: 'the turn reviewer: one call after a turn ends, when it is switched on',
} as const satisfies Readonly<Record<SpendSource, string>>;


/**
 * One model call, as the producer that made it can report it.
 *
 * `usage` is the provider's own words, normalized, absent field by absent field.
 * An entirely absent report is `{}` — the producer still reports the CALL, which
 * is what keeps a silent provider distinguishable from a free one.
 *
 * `spec` is the `<provider>/<modelId>` the caller resolved, which is what the
 * catalog prices against; `modelId` is what the provider said served it. They
 * differ (a spec names a gateway route, the id names the model behind it) and
 * both are worth keeping: one prices, the other identifies.
 */
export interface ModelCallReport {
  readonly source: SpendSource;
  readonly usage: Usage;
  readonly spec?: string;
  readonly modelId?: string;
}

/**
 * What a SET of model calls cost, and what it could not account for.
 *
 * One declaration for the fold, wherever the folding happens. A producer's row
 * in the workspace total, that total itself, and the per-producer aggregate the
 * recorder sums straight out of the event log are the same five numbers, and the
 * two that make them trustworthy are absences: a `usage` field no call reported
 * stays ABSENT rather than summing to a zero that reads as measured, and `usd`
 * stays absent until some call carried a catalog rate, so "nothing here was
 * priced" never renders as "all of this was free".
 */
export interface SpendTally {
  /** Model calls attributed here. */
  readonly calls: number;
  /** Of those, how many the provider reported no usage at all for. Their spend
   *  is real and unmeasured; `usage` below omits them entirely. */
  readonly callsWithoutUsage: number;
  /** Accumulated field by field, so a field no call reported stays ABSENT
   *  rather than summing to a zero that reads as measured. */
  readonly usage: Usage;
  /** Catalog-priced spend over the calls that carried a rate. Absent when none
   *  did — unpriced, never free. */
  readonly usd?: number;
  /** Calls with a usage report but no catalog rate: measured in tokens,
   *  invisible in dollars. This is why `usd` is a floor. */
  readonly unpricedCalls: number;
}

/**
 * Where a producer sends its report.
 *
 * Injected at construction rather than returned from `complete`, because the
 * consumer of a usage report is the ledger, not the caller: 15 judge/evolution
 * call sites want text and nothing else, and threading a report through all of
 * them is 15 chances to forget. The seam that holds the SDK result is the one
 * place that can see usage, so it is the one place that reports it.
 *
 * Optional everywhere it is accepted: a seam with no sink wired is a seam whose
 * spend is unattributed, and the coverage fraction is what says so.
 */
export type ModelCallSink = (report: ModelCallReport) => void;

/**
 * The sink plus the label to file its calls under, for a seam SEVERAL producers
 * share.
 *
 * Two shapes exist and the difference is which layer knows the producer.
 * `createFastLLM` is one producer, so it takes a bare {@link ModelCallSink} and
 * supplies `'fast'` itself. `generateJson` is a substrate — the scaffold judge,
 * both head merges and the GEPA metric all ride it — so only its CALLER knows
 * what the call is, and passing the sink and the label as two independent
 * optional fields would let a caller supply one without the other and lose the
 * attribution silently. One field, both halves, no unlabelled row.
 */
export interface ModelCallSpend {
  readonly source: SpendSource;
  readonly report: ModelCallSink;
  /**
   * Where this seam's operation lifecycle goes, if anywhere.
   *
   * A third field rather than a second struct: the lifecycle and the cost are
   * two facts about ONE call, produced on the same line, and a caller that
   * wired them separately could report a cost for an operation it never opened.
   */
  readonly operations?: ModelOperationSink;
}

// ── The operation lifecycle ──────────────────────────────────────

/**
 * What kind of direct model operation ran.
 *
 * Coarse on purpose. The seam that holds the SDK result knows the SHAPE of the
 * call it issued and nothing about why it was issued; WHICH producer wanted it
 * is {@link SpendSource}, and the pair is the producer lane a reader needs —
 * `fast`+`complete` is a mechanical classification, `judge`+`generate_json` is
 * a graded verdict. A per-call-site name would have to be threaded from every
 * caller, and a name nobody threads is a name that lies.
 */
export const MODEL_OPERATION_KINDS = ['complete', 'stream', 'generate_json'] as const;
export type ModelOperationKind = (typeof MODEL_OPERATION_KINDS)[number];

export const MODEL_OPERATION_PHASES = ['start', 'end'] as const;
export type ModelOperationPhase = (typeof MODEL_OPERATION_PHASES)[number];

/**
 * How an operation ended.
 *
 * `failed` covers a provider throw and a cancellation alike: an aborted call
 * arrives at this seam as a thrown abort, and the recorded error text is what
 * separates the two. NOTHING here reads a clock — an operation with no end row
 * is a fact about the process that died, never a verdict about how long the
 * call was taking.
 */
export const MODEL_OPERATION_OUTCOMES = ['ok', 'failed'] as const;
export type ModelOperationOutcome = (typeof MODEL_OPERATION_OUTCOMES)[number];

/**
 * One end of one direct model operation.
 *
 * WHY A START ROW EXISTS. {@link ModelCallReport} is written after a call
 * returns, so a process that dies mid-call leaves nothing at all: the durable
 * trail could not name which operation was in flight, and a killed evolution
 * pass was indistinguishable from one that never ran. The pair here is the
 * shape `run_start`/`run_end` already uses one level up, and it is read the
 * same way — a start with no end is the visible signature of a frame the
 * platform destroyed (`RunEventRecorder.unterminatedModelOperations`).
 *
 * `operationId` joins the two rows. Minted at the start, so it is stable for
 * the operation's whole life and unique within the log.
 *
 * `usage` rides the END row alone, because usage does not exist until the
 * provider has answered. It is the same normalized report
 * {@link ModelCallReport} carries — `{}` where the provider said nothing, so an
 * unmeasured operation stays distinguishable from a free one.
 */
export interface ModelOperationEvent {
  readonly operationId: string;
  readonly source: SpendSource;
  readonly op: ModelOperationKind;
  readonly phase: ModelOperationPhase;
  /** End rows only. */
  readonly outcome?: ModelOperationOutcome;
  /** End rows only, and only what the provider reported. */
  readonly usage?: Usage;
  readonly spec?: string;
  readonly modelId?: string;
  /** Failed end rows only: the cause chain, bounded. */
  readonly error?: string;
}

/**
 * Where a seam sends its operation lifecycle.
 *
 * A separate sink from {@link ModelCallSink} rather than more arms on it,
 * because one of the two readers is a census: `model_call` is what the
 * workspace spend total counts, and start rows entering that stream would count
 * every operation twice and halve the window the coverage fraction is measured
 * over.
 *
 * Optional wherever it is accepted, for the same reason `report` is: a seam
 * with no lifecycle wired is a seam whose in-flight work cannot be attributed,
 * and saying so beats pretending the frame was never opened.
 */
export type ModelOperationSink = (event: ModelOperationEvent) => void;

/** Characters of a failure's cause chain kept on the end row. Enough to name
 *  the provider fault; never a whole prompt echoed back inside an error. */
const OPERATION_ERROR_MAX_CHARS = 300;
/** The stable id one operation is known by, start row to end row. Random
 *  rather than counted: an activation's counter restarts at eviction and would
 *  hand the second life's first operation the first life's id, which then reads
 *  as its missing end. */
function newModelOperationId(): string {
  return `op-${nanoid(10)}`;
}

/**
 * An open operation frame. Exactly one end row is written, whichever way the
 * call leaves — and a frame that is never closed is the evidence, not a leak.
 */
export interface ModelOperation {
  /** The call returned. `usage` is the provider's own report, normalized. */
  completed(result: { usage?: Usage; modelId?: string }): void;
  /** The call threw — a provider fault, or an abort the caller asked for.
   *  The thrown value rides as `{ cause }`, the same shape
   *  `renderThrownChain` and every diagnostics call site already speak. */
  failed(into: { readonly cause: unknown }): void;
}

/** A frame nobody is watching. Shared rather than allocated per call: a seam
 *  with no lifecycle sink takes this path on every model call it makes. */
const UNWATCHED_OPERATION: ModelOperation = {
  completed(): void { /* no sink wired: nothing to record */ },
  failed(): void { /* no sink wired: nothing to record */ },
};

/**
 * Open a durable frame around one direct model operation.
 *
 * Called immediately BEFORE the provider call, so the start row is written
 * while the call is in flight — which is the whole point: the row exists to be
 * found by a LATER activation asking what the previous one was doing when it
 * stopped.
 */
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
  // One end row per frame. A stream whose consumer drains it and then throws
  // would otherwise close the same operation twice, and two ends for one start
  // is a shape no reader can interpret.
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
 * The run id a model call is filed under when no run is open.
 *
 * Half of a workspace's producers fire between runs: an evolution pass on a
 * fiber, a workspace title before the first turn exists, an embedding backfill
 * at DO boot. The run-event log is keyed by run, so those calls need somewhere
 * to go, and the alternative — dropping them — is the exact dishonesty the row
 * type exists to remove.
 *
 * A reserved id rather than a nullable column: the log's primary key is
 * `(run_id, event_index)` and every reader is keyed by run, so a NULL would
 * have to be special-cased in each of them. `RunEventRecorder.listRuns` hides
 * it, which is the one place a reader would otherwise mistake it for a run.
 */
export const WORKSPACE_RUN_ID = '_workspace';
