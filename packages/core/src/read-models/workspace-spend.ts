/**
 * What the WHOLE workspace spent, grouped by which producer spent it.
 *
 * The step telemetry (`events/step-stats.ts`) answers a narrower question and
 * answers it well: what the orchestrator's own turns cost, over a window of
 * `step_finish` rows. The owner's question is bigger — "does this show ALL of
 * the usage, including any async models running and costing like judge models" —
 * and a per-agent number cannot answer it: a workspace runs judges, a fast tier,
 * an evolution engine, exploration heads, MCTS rollouts, compaction folds, a
 * scaffold's own loop and an embedder, and none of them is in the step
 * telemetry's number.
 *
 * NOT A SECOND STORE. Three things that already exist are read here and nothing
 * new is written:
 *   `step_finish` rows  — the turn loop, as `agent`
 *   `model_call` rows   — every other producer, as itself (events/model-call.ts)
 *   `head_journal`      — completed head reports, correlated with the producing
 *                         actor and the attempt's start time
 *
 * A measured head report replaces that attempt's step usage, not its recorded
 * prices or auxiliary model calls. Running and earlier interrupted steps remain
 * visible. A report with no usage does not erase measured steps.
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
 * bound stands between the owner and what the workspace spent. Folded over the
 * same recent-rows window the step telemetry samples, every total would be a
 * floor as soon as the log outgrew the window — and "newest 2000 rows" is text a
 * reader passes over. A percentile needs a sample; a sum does not. The step
 * telemetry beside this keeps its window and its `windowLimit`, because a
 * cache-hit rate over the whole of
 * history answers nobody's question. Heads are read whole from their journal for
 * the same reason: a workspace has orders of magnitude fewer heads than steps.
 *
 * `producers` covers the workspace. `missions` reads the requesting actor's
 * declared budget ledger. These views overlap and must not be added together.
 */

import type { RunEventRecorder, StepSpendSource } from '../events/recorder';
import { SPEND_SOURCES, type SpendSource, type SpendTally } from '../events/model-call';
import type { SqlExecutor } from '../types/primitives';
import { addUsage, usageReported, usageTotal, type Usage } from '../usage';
import { storedUsage } from '../heads/journal';
import type { StoredHeadUsage } from '../heads/schema';
import { listMissionSpend, type MissionBudgetSnapshot } from '../mission-budget';
import type { ActorHandle } from '../identity/actor-handle';

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
   *  row. There is no truncation state beside it: this IS the total, and a field
   *  saying so could never vary. */
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
  floorPricedCalls: number;
}

/**
 * Fold one call in.
 *
 * `usd` stays undefined until a call carries one, which is what keeps "nothing
 * here was priced" distinguishable from "everything here was priced at $0".
 * A call with usage but no price increments `unpricedCalls` — a call with no
 * usage at all cannot be priced either, and is already counted as unmeasured,
 * so it does not also count as unpriced.
 *
 * A call that WAS priced but only to a floor increments `floorPricedCalls`
 * instead: it is in `usd`, and `usd` is short. `floorTokens` is the per-call
 * marker `priceCall` produced, absent on an exact price, which is why presence
 * rather than a threshold decides here.
 */
function record(
  tally: Tally, usage: Usage, usd: number | undefined, floorTokens?: number,
): void {
  tally.calls++;

  if (usageReported(usage)) {
    tally.usage = addUsage(tally.usage, usage);

    if (usd === undefined) tally.unpricedCalls++;
    else {
      tally.usd = (tally.usd ?? 0) + usd;

      if (floorTokens !== undefined) tally.floorPricedCalls++;
    }
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

  const fresh: Tally = {
    calls: 0, callsWithoutUsage: 0, usage: {}, usd: undefined,
    unpricedCalls: 0, floorPricedCalls: 0,
  };

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
  /** The actor whose mission budgets accompany the workspace-wide producer totals. */
  readonly actor: ActorHandle;
}

/**
 * Every model call this workspace can account for, grouped by producer, over the
 * whole log.
 *
 * Two reads, both unbounded, and neither is a sample. `spendByProducer` sums the
 * `step_finish` and `model_call` rows in SQL — one pass over the table for every
 * producer at once, rather than a fold over rows carried into memory a window at
 * a time. Completed head reports replace only their own attempt's step usage.
 * The actor directory supplies identity; a sibling's report cannot cover it.
 */
export function workspaceSpend(deps: WorkspaceSpendDeps): WorkspaceSpend {
  deps.actor.assertCurrent();
  const tallies: Tallies = new Map();
  const heads = readHeadSpend(deps.sql);

  const stepSources = heads.flatMap((head): StepSpendSource[] => head.headActorId === null ? [] : [{
    actorId: head.headActorId,
    source: 'head',
    coveredSince: head.completedAt !== null && usageReported(storedUsage(head))
      ? new Date(head.spawnedAt).toISOString() : null,
  }]);

  for (const [source, tally] of deps.events.spendByProducer(stepSources)) tallies.set(source, openTally(tally));

  for (const head of heads) {
    const usage = storedUsage(head);

    if (head.completedAt !== null && (usageReported(usage) || head.hasSteps === 0)) {
      record(tallyFor(tallies, 'head'), usage, undefined);
    }
  }

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

  const total: Tally = {
    calls: 0, callsWithoutUsage: 0, usage: {}, usd: undefined,
    unpricedCalls: 0, floorPricedCalls: 0,
  };

  for (const p of producers) {
    total.calls += p.calls;
    total.callsWithoutUsage += p.callsWithoutUsage;
    total.unpricedCalls += p.unpricedCalls;
    total.floorPricedCalls += p.floorPricedCalls;
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
    missions: listMissionSpend(deps.sql, deps.actor),
  };
}

function finishTotal(tally: Tally): SpendTally {
  const out = {
    calls: tally.calls,
    callsWithoutUsage: tally.callsWithoutUsage,
    usage: tally.usage,
    unpricedCalls: tally.unpricedCalls,
    floorPricedCalls: tally.floorPricedCalls,
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
interface HeadSpendRow extends StoredHeadUsage {
  readonly headActorId: string | null;
  readonly spawnedAt: number;
  readonly completedAt: number | null;
  readonly hasSteps: number;
}

function readHeadSpend(sql: SqlExecutor): HeadSpendRow[] {
  return sql<HeadSpendRow>`
    SELECT h.token_input, h.token_output, h.token_cache_read, h.token_cache_write,
           h.token_cache_write_1h, h.token_reasoning, h.neurons,
           a.actor_id AS headActorId, h.spawned_at AS spawnedAt, h.completed_at AS completedAt,
           EXISTS(SELECT 1 FROM run_events e
             WHERE e.actor_id = a.actor_id AND e.type = 'step_finish'
               AND e.ts >= strftime('%Y-%m-%dT%H:%M:%fZ', h.spawned_at / 1000.0, 'unixepoch')) AS hasSteps
    FROM head_journal h LEFT JOIN workspace_actors a
      ON a.parent_actor_id = h.actor_id AND a.creation_id = h.id AND a.kind IN ('head', 'branch')`;
}
