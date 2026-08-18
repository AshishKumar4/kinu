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
 * WINDOWED, AND IT SAYS SO. `step_finish` and `model_call` are read over the
 * same bounded recent-rows window the step telemetry uses, because the event log
 * is a log and not a roll-up. `windowLimit` comes back on the result for the
 * same reason it does there: a total whose window you cannot see is a total you
 * cannot check. Heads are per-run rather than per-step, so the journal is read
 * whole — a workspace has orders of magnitude fewer heads than steps.
 */

import type { RunEventRecorder } from '../events/recorder.js';
import { SPEND_SOURCES, type SpendSource } from '../events/model-call.js';
import type { SqlExecutor } from '../types/primitives.js';
import { addUsage, usageReported, usageTotal, type Usage } from '../usage.js';
import { storedUsage } from '../heads/journal.js';
import type { StoredHeadUsage } from '../heads/schema.js';

/** What one producer spent, and what it could not account for. */
export interface ProducerSpend {
  readonly source: SpendSource;
  /** Model calls attributed to this producer in the window. */
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
  /** Every producer summed. Same absence rules as a producer row. */
  readonly total: Omit<ProducerSpend, 'source'>;
  readonly coverage: SpendCoverage;
  /** The bound on `step_finish` and `model_call` rows read. */
  readonly windowLimit: number;
  /**
   * The window reached the end of the log rather than filling up.
   *
   * `windowLimit` alone says how much this was willing to read, not whether it
   * ran out of rows first, and those are the two states a reader has to tell
   * apart before trusting the total. Earned rather than inferred: the read asks
   * for `windowLimit + 1` rows and drops the extra, so a full window is direct
   * evidence that more exists. Comparing `rows.length` to `windowLimit` cannot
   * do this — an exactly-full log and a truncated one look identical that way.
   */
  readonly complete: boolean;
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

export interface WorkspaceSpendDeps {
  readonly events: RunEventRecorder;
  readonly sql: SqlExecutor;
}

/**
 * Every model call this workspace can account for, grouped by producer.
 *
 * `windowLimit` bounds the `step_finish` and `model_call` reads INDEPENDENTLY, so
 * a workspace whose turn loop has run 10k steps does not push its judge calls
 * out of the window: they are different row types and each gets the same depth.
 *
 * Each read asks for one row more than it will use. The extra row is never
 * counted — it exists only so `complete` is a fact about a read that actually
 * ran off the end of the data, rather than a guess from a row count that cannot
 * distinguish an exactly-full log from a truncated one.
 */
export function workspaceSpend(
  deps: WorkspaceSpendDeps,
  opts: { windowLimit: number },
): WorkspaceSpend {
  const tallies: Tallies = new Map();
  const probe = opts.windowLimit + 1;
  let complete = true;

  const steps = deps.events.readRecentByType('step_finish', probe);
  complete = complete && steps.length < probe;
  for (const e of steps.slice(-opts.windowLimit)) {
    if (e.type !== 'step_finish') continue;
    record(tallyFor(tallies, 'agent'), e.usage ?? {}, e.usd);
  }

  const calls = deps.events.readRecentByType('model_call', probe);
  complete = complete && calls.length < probe;
  for (const e of calls.slice(-opts.windowLimit)) {
    if (e.type !== 'model_call') continue;
    record(tallyFor(tallies, e.source), e.usage ?? {}, e.usd);
  }

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
    windowLimit: opts.windowLimit,
    complete,
  };
}

function finishTotal(tally: Tally): Omit<ProducerSpend, 'source'> {
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
