/**
 * What the WHOLE workspace spent, grouped by which producer spent it.
 *
 * The step telemetry (`events/step-stats.ts`) answers a narrower question and
 * answers it well: what the orchestrator's own turns cost, over a window of
 * `step_finish` rows. The owner's question is bigger — "does this show ALL of
 * the usage, including any async models running and costing like judge models" —
 * and the honest answer used to be no, without the panel saying so. A workspace
 * runs judges, a fast tier, an evolution engine, exploration heads, MCTS
 * rollouts, compaction folds, a scaffold's own loop and an embedder, and none of
 * them was in the number.
 *
 * NOT A SECOND STORE. Three things that already exist are read here and nothing
 * new is written:
 *   `step_finish` rows  — the turn loop, as `agent`
 *   `model_call` rows   — every other producer, as itself (events/model-call.ts)
 *   `head_journal`      — exploration heads, whose usage comes back from another
 *                         Durable Object inside a `HeadReport` and is stored
 *                         per head; the parent's event log never sees the call
 *
 * Heads are read from the journal and NOT reported through the `model_call`
 * sink, deliberately: two writers for one call is how a total learns to
 * double-count. The journal row is the head's one durable cost record.
 *
 * COVERAGE IS PART OF THE ANSWER, not a footnote. A total that silently omits
 * four producers is worse than a per-agent number that is honest about its
 * scope, so this reports what it accounted for AND what it could not: calls the
 * provider reported nothing for, and calls no catalog could price. "100% of
 * known callers reported" and "92%, with the embedder silent" are different
 * facts and the owner has to be able to tell them apart.
 *
 * COMPLETE, NOT WINDOWED. The producer totals are summed IN SQL over every
 * `step_finish` and `model_call` row the log holds (`spendByProducer`), so no
 * bound stands between the owner and what the workspace spent. They used to be
 * folded over the same recent-rows window the step telemetry samples, which made
 * every total a floor as soon as the log outgrew the window — and the panel that
 * rendered it said "newest 2000 rows" in text a reader could pass over. A
 * percentile needs a sample; a sum does not. The step telemetry beside this keeps
 * its window and its `windowLimit`, because a cache-hit rate over the whole of
 * history answers nobody's question. Heads are read whole from their journal for
 * the same reason: a workspace has orders of magnitude fewer heads than steps.
 *
 * TWO AXES OVER ONE SUM. `producers` groups the spend by what KIND of work made
 * the call; `missions` groups it by which declared piece of work it was made
 * FOR, read out of the same ledger the budget caps are enforced against. Both
 * are now cumulative over the workspace's whole life, so they answer at the same
 * scope — but they still must not be added together, because one call appears in
 * exactly one producer row and in every mission label above it.
 */

import type { RunEventRecorder } from '../events/recorder';
import { SPEND_SOURCES, type SpendSource, type SpendTally } from '../events/model-call';
import type { SqlExecutor } from '../types/primitives';
import { addUsage, usageReported, usageTotal, type Usage } from '../usage';
import { storedUsage } from '../heads/journal';
import type { StoredHeadUsage } from '../heads/schema';
import { listMissionSpend, type MissionBudgetSnapshot } from '../mission-budget';

/**
 * What one producer spent, and what it could not account for.
 *
 * The five numbers are {@link SpendTally}'s, declared once so a producer row,
 * the workspace total and the SQL aggregate cannot describe the same fold in
 * three shapes.
 */
export interface ProducerSpend extends SpendTally {
  readonly source: SpendSource;
}

/** Whether the total can be trusted, stated in the total's own terms. */
export interface SpendCoverage {
  /** Calls seen across every producer. */
  readonly calls: number;
  /** Calls whose provider reported usage — the ones inside `usage`. */
  readonly measured: number;
  /** `measured / calls`, or null when the workspace has made no calls. 1 means
   *  every known caller reported; anything less is named in `silent`. */
  readonly reported: number | null;
  /** Producers that made calls and reported usage for NONE of them. The Workers
   *  AI utility bindings (`platform`) live here permanently: neither the
   *  embedder nor the markdown repair returns a usage field of any kind, so
   *  their spend can be counted in calls and never in tokens. */
  readonly silent: readonly SpendSource[];
  /** Producers with at least one measured call and at least one silent one. */
  readonly partial: readonly SpendSource[];
}

export interface WorkspaceSpend {
  /** Producers that actually spent something, largest token total first, with
   *  unmeasured-but-present producers last. A producer with no calls is absent:
   *  every producer reports through the same seam, so no rows means it never
   *  ran, not that it is unwired. */
  readonly producers: readonly ProducerSpend[];
  /** Every producer summed, over the whole log. Same absence rules as a producer
   *  row. There is no truncation state beside it any more: this IS the total, and
   *  a field saying so could never vary. */
  readonly total: SpendTally;
  readonly coverage: SpendCoverage;
  /**
   * Share of the measured tokens no turn of this agent spent — everything the
   * owner did not watch happen: judges, the fast tier, the evolution engine,
   * heads, rollouts, an embedder.
   *
   * Derived from the same producer rows rather than counted a second time, so
   * it cannot disagree with the table it sits under. Null when nothing was
   * measured: a share of no tokens is absent, never 0.
   */
  readonly offTurnShare: number | null;
  /**
   * What each mission label has spent, dearest first — the OTHER axis of the
   * same money. A producer row says what KIND of work spent it; a mission row
   * says which declared piece of work it was spent ON, including everything
   * that work delegated (the ledger rolls a debit up the whole label chain).
   *
   * Read from `mission_budget`, the ledger the caps are enforced against, so
   * this figure and a refusal can never disagree. Empty on the workspace that
   * declared no budget, which is every ordinary session.
   *
   * ONE SCOPE, TWO AXES: these and the producer rows are both cumulative over
   * the workspace's whole life, so neither is a floor. They still must not be
   * added, because a call sits in exactly one producer row and in every mission
   * label above it.
   */
  readonly missions: readonly MissionBudgetSnapshot[];
}

/** A producer's running tally. Mutable inside this module only. */
interface Tally {
  calls: number;
  callsWithoutUsage: number;
  usage: Usage;
  usd: number | undefined;
  unpricedCalls: number;
}

/**
 * Fold one call in.
 *
 * `usd` stays undefined until a call carries one, which is what keeps "nothing
 * here was priced" distinguishable from "everything here was priced at $0".
 * A call with usage but no price increments `unpricedCalls` — a call with no
 * usage at all cannot be priced either, and is already counted as unmeasured,
 * so it does not also count as unpriced.
 */
function record(tally: Tally, usage: Usage, usd: number | undefined): void {
  tally.calls++;
  if (usageReported(usage)) {
    tally.usage = addUsage(tally.usage, usage);
    if (usd === undefined) tally.unpricedCalls++;
    else tally.usd = (tally.usd ?? 0) + usd;
  } else {
    tally.callsWithoutUsage++;
  }
}

/** A producer's running tally, keyed on demand: a source that never ran gets no
 *  entry, which is what lets `producers` mean "spent something" rather than
 *  "exists in the enum". */
type Tallies = Map<SpendSource, Tally>;

function tallyFor(tallies: Tallies, source: SpendSource): Tally {
  const existing = tallies.get(source);
  if (existing) return existing;
  const fresh: Tally = { calls: 0, callsWithoutUsage: 0, usage: {}, usd: undefined, unpricedCalls: 0 };
  tallies.set(source, fresh);
  return fresh;
}

/** The aggregate's finished row as a fold still in progress, so the head journal
 *  can be added to it without a second accumulator shape. */
function openTally(tally: SpendTally): Tally {
  return { ...tally, usd: tally.usd };
}

export interface WorkspaceSpendDeps {
  readonly events: RunEventRecorder;
  readonly sql: SqlExecutor;
}

/**
 * Every model call this workspace can account for, grouped by producer, over the
 * whole log.
 *
 * Two reads, both unbounded, and neither is a sample. `spendByProducer` sums the
 * `step_finish` and `model_call` rows in SQL — one pass over the table for every
 * producer at once, rather than a fold over rows carried into memory a window at
 * a time. The head journal is then folded in through the same accumulator: a
 * head's usage never reaches the parent's event log (it comes back inside a
 * `HeadReport` from another Durable Object), so the journal is its one durable
 * cost record and the two sources meet here rather than in two totals.
 */
export function workspaceSpend(deps: WorkspaceSpendDeps): WorkspaceSpend {
  const tallies: Tallies = new Map();
  for (const [source, tally] of deps.events.spendByProducer()) tallies.set(source, openTally(tally));
  for (const head of readHeadSpend(deps.sql)) record(tallyFor(tallies, 'head'), head, undefined);

  // Largest measured token total first: the panel's first job is to show where
  // the tokens went. A producer with nothing measured sorts last however many
  // calls it made, which is why the absent total reads as -1 rather than 0.
  const producers = SPEND_SOURCES
    .flatMap((source) => {
      const row = tallies.get(source);
      return row && row.calls > 0 ? [{ source, row }] : [];
    })
    .sort((a, b) => (usageTotal(b.row.usage) ?? -1) - (usageTotal(a.row.usage) ?? -1))
    .map(({ source, row }) => ({ source, ...finishTotal(row) }));

  const total: Tally = { calls: 0, callsWithoutUsage: 0, usage: {}, usd: undefined, unpricedCalls: 0 };
  for (const p of producers) {
    total.calls += p.calls;
    total.callsWithoutUsage += p.callsWithoutUsage;
    total.unpricedCalls += p.unpricedCalls;
    total.usage = addUsage(total.usage, p.usage);
    if (p.usd !== undefined) total.usd = (total.usd ?? 0) + p.usd;
  }

  const measured = total.calls - total.callsWithoutUsage;
  const measuredTokens = usageTotal(total.usage);
  // The turn loop's own tokens, absent when it measured none. `agent` is the one
  // producer the owner watched happen, so everything else is the off-turn half.
  const turnTokens = usageTotal(producers.find((p) => p.source === 'agent')?.usage ?? {}) ?? 0;
  return {
    producers,
    total: finishTotal(total),
    coverage: {
      calls: total.calls,
      measured,
      reported: total.calls === 0 ? null : measured / total.calls,
      silent: producers.filter((p) => p.callsWithoutUsage === p.calls).map((p) => p.source),
      partial: producers
        .filter((p) => p.callsWithoutUsage > 0 && p.callsWithoutUsage < p.calls)
        .map((p) => p.source),
    },
    offTurnShare: measuredTokens === undefined || measuredTokens === 0
      ? null
      : (measuredTokens - turnTokens) / measuredTokens,
    missions: listMissionSpend(deps.sql),
  };
}

function finishTotal(tally: Tally): SpendTally {
  const out = {
    calls: tally.calls,
    callsWithoutUsage: tally.callsWithoutUsage,
    usage: tally.usage,
    unpricedCalls: tally.unpricedCalls,
  };
  return tally.usd === undefined ? out : { ...out, usd: tally.usd };
}

/**
 * Each head's own usage, as its journal row stored it.
 *
 * One row per head rather than per step: a head's steps are summed into its
 * report before the parent ever sees them (`heads/head-inference.ts`), so a head
 * IS the unit of accounting here. Every `Usage` field has a column; NULL means
 * the head's provider never reported that count — the columns carry no default
 * for exactly this reason — and a row with every count NULL comes back as `{}`,
 * landing in `callsWithoutUsage` where an aborted or silent head belongs.
 *
 * Decoded by the journal's own `storedUsage` rather than a second reader here.
 * A fork's cache reads and its Workers AI `neurons` are among the fields this
 * total exists to stop losing, and two decoders over one storage shape is how
 * one surface keeps a field the other drops.
 *
 * `head_journal` is created by `initWorkspaceSchema`, so an unreadable journal is
 * a broken workspace rather than an empty one and the error belongs at the
 * surface.
 */
function readHeadSpend(sql: SqlExecutor): Usage[] {
  return sql<StoredHeadUsage>`
    SELECT token_input, token_output, token_cache_read, token_cache_write,
           token_cache_write_1h, token_reasoning, neurons
    FROM head_journal`.map(storedUsage);
}
