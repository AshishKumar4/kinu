/**
 * Workspace model spend by producer from `step_finish` (as `agent`), `model_call` and `head_journal`, summed in SQL
 * over the whole log. A measured head report replaces its attempt's step usage only. `producers`, `missions` and
 * `accounts` overlap; never sum them.
 */

import type { RunEventRecorder, StepSpendSource } from '../events/recorder';
import { SPEND_SOURCES, type AccountSpend, type SpendSource, type SpendTally } from '../events/model-call';
import type { SqlExecutor } from '../types/primitives';
import { addUsage, usageReported, usageTotal, type Usage } from '../usage';
import { storedUsage } from '../heads/journal';
import type { StoredHeadUsage } from '../heads/schema';
import { listMissionSpend, type MissionBudgetSnapshot } from '../mission-budget';
import type { ActorHandle } from '../identity/actor-handle';
import { sortAccountSpend } from './account-usage';

export interface ProducerSpend extends SpendTally {
  readonly source: SpendSource;
}

export interface SpendCoverage {
  readonly calls: number;
  readonly measured: number;
  readonly reported: number | null;
  /** Producers with calls and no reported usage, always including Workers AI utility bindings (`platform`). */
  readonly silent: readonly SpendSource[];
  readonly partial: readonly SpendSource[];
}

export interface WorkspaceSpend {
  /** Producers with calls, largest token total first, unmeasured last. */
  readonly producers: readonly ProducerSpend[];
  readonly total: SpendTally;
  readonly coverage: SpendCoverage;
  /** Share of measured tokens not spent by `agent` turns; null when nothing was measured. */
  readonly offTurnShare: number | null;
  /** Per mission label, dearest first; a call sits in one producer row and every label above it. */
  readonly missions: readonly MissionBudgetSnapshot[];
  /** Absent when an older deployment answered: not reported, not none. */
  readonly accounts?: readonly AccountSpend[];
}

interface Tally {
  calls: number;
  callsWithoutUsage: number;
  usage: Usage;
  usd: number | undefined;
  unpricedCalls: number;
}

/** `usd` stays undefined until a call carries one ("unpriced" is not "$0"). */
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

type Tallies = Map<SpendSource, Tally>;

function tallyFor(tallies: Tallies, source: SpendSource): Tally {
  const existing = tallies.get(source);

  if (existing) return existing;

  const fresh: Tally = {
    calls: 0, callsWithoutUsage: 0, usage: {}, usd: undefined,
    unpricedCalls: 0,
  };

  tallies.set(source, fresh);

  return fresh;
}

function openTally(tally: SpendTally): Tally {
  return { ...tally, usd: tally.usd };
}

export interface WorkspaceSpendDeps {
  readonly events: RunEventRecorder;
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
}

export function workspaceSpend(deps: WorkspaceSpendDeps): WorkspaceSpend & { readonly accounts: readonly AccountSpend[] } {
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

  // Absent totals read as -1 so unmeasured producers sort last.
  const producers = SPEND_SOURCES
    .flatMap((source) => {
      const row = tallies.get(source);

      return row && row.calls > 0 ? [{ source, row }] : [];
    })
    .sort((a, b) => (usageTotal(b.row.usage) ?? -1) - (usageTotal(a.row.usage) ?? -1))
    .map(({ source, row }) => ({ source, ...finishTotal(row) }));

  const total: Tally = {
    calls: 0, callsWithoutUsage: 0, usage: {}, usd: undefined,
    unpricedCalls: 0,
  };

  for (const p of producers) {
    total.calls += p.calls;
    total.callsWithoutUsage += p.callsWithoutUsage;
    total.unpricedCalls += p.unpricedCalls;
    total.usage = addUsage(total.usage, p.usage);

    if (p.usd !== undefined) total.usd = (total.usd ?? 0) + p.usd;
  }

  const measured = total.calls - total.callsWithoutUsage;
  const measuredTokens = usageTotal(total.usage);
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
    accounts: sortAccountSpend(deps.events.spendByAccount()),
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

/** One row per head, its steps summed in. A NULL usage column was never reported; decode via `storedUsage`. */
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
