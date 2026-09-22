/**
 * Behavioural scorers over `SqlExecutor`. They read through the production reader (`listForkRuns`),
 * and report a denominator separately from passes so a caller can assert it is non-zero.
 */
import {
  censusToolFailures, listForkRuns, parseStoredRunEvent, STEER_BRANCH_RUN_ID_PREFIX,
  tableExists,
  type ActorHandle, type ForkRunSummary, type RunEvent, type SqlExecutor,
} from '@kinu.run/core';


/** One run with a search tree as the reader sees it, plus the durable winner marks. */
export interface SearchRunScore {
  readonly id: string;
  readonly branches: number;
  readonly winnerScore: number | null;
  /** `search_nodes` rows this root marked `terminal`; convergence leaves exactly one. */
  readonly terminalNodes: number;
  /**
   * The `alternate_takes` winner for this search, or null. Reported, never asserted: a take is
   * written only for a near-tied rival, and is joined back through `search_nodes` (no `root_id`).
   */
  readonly takeWinnerId: string | null;
}

export interface ExplorationScore {
  readonly searchRuns: number;
  readonly branchedRuns: number;
  readonly rankedRuns: number;
  readonly durablyRankedRuns: number;
  readonly runs: readonly SearchRunScore[];
}

/**
 * Score every run with a search tree the Exploration reader can see. `limit` defaults to the whole
 * store: `listForkRuns` pages after merging, so transcript-only runs can push a tree off a short page.
 */
export function scoreExploration(sql: SqlExecutor, actor: ActorHandle, limit = 1000): ExplorationScore {
  const searched = listForkRuns(sql, actor, null, limit).items.filter((run) => run.hasSearchTree);

  const runs = searched.map<SearchRunScore>((run) => {
    const terminal = sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM search_nodes
      WHERE actor_id = ${actor.actorId} AND root_id = ${run.id} AND status = 'terminal'`[0]?.n ?? 0;

    const take = sql<{ winner_node_id: string }>`
      SELECT t.winner_node_id FROM alternate_takes t
      JOIN search_nodes n ON n.id = t.winner_node_id
      WHERE n.actor_id = ${actor.actorId} AND t.actor_id = ${actor.actorId}
        AND n.root_id = ${run.id}`[0];

    return {
      id: run.id,
      branches: run.branches,
      winnerScore: run.winnerScore,
      terminalNodes: terminal,
      takeWinnerId: take?.winner_node_id ?? null,
    };
  });

  return {
    searchRuns: runs.length,
    branchedRuns: runs.filter((r) => r.branches > 1).length,
    rankedRuns: runs.filter((r) => r.winnerScore !== null).length,
    durablyRankedRuns: runs.filter((r) => r.terminalNodes === 1).length,
    runs,
  };
}


export type ExplorationHalf = 'tree' | 'transcripts';

export interface SettleStoreScore {
  readonly half: ExplorationHalf;
  readonly store: string;
  /**
   * The table exists in this store. A query against a missing table throws, and counting it as
   * zero roots would pass vacuously (`createWorkspace` has `search_nodes` but not `head_journal`).
   */
  readonly present: boolean;
  readonly rootsWritten: number;
  readonly rootsVisible: number;
  /** The roots the reader cannot see. Empty is the only acceptable value. */
  readonly invisibleRoots: readonly string[];
}

export interface SettleVisibilityScore {
  readonly stores: readonly SettleStoreScore[];
  readonly rootsWritten: number;
  readonly invisibleRoots: readonly string[];
}

/**
 * For each half a run can write, does the Exploration reader return what was written?
 * Steer-as-Branch roots and NULL roots are excluded in SQL: the run list filters them by design.
 * `read` is injectable so the scorer's own tests can prove it goes red against a one-half reader.
 */
export function scoreSettleVisibility(
  sql: SqlExecutor,
  actor: ActorHandle,
  read: (sql: SqlExecutor, limit: number) => readonly ForkRunSummary[] =
    (readSql, limit) => listForkRuns(readSql, actor, null, limit).items,
): SettleVisibilityScore {
  const notSteerBranch = `${STEER_BRANCH_RUN_ID_PREFIX}%`;
  const transcriptsPresent = tableExists(sql, 'head_journal');
  const treePresent = tableExists(sql, 'search_nodes');

  const written = [
    {
      half: 'transcripts' as const,
      store: 'head_journal',
      present: transcriptsPresent,
      roots: !transcriptsPresent ? [] : sql<{ root: string }>`
        SELECT DISTINCT root_id AS root FROM head_journal
        WHERE actor_id = ${actor.actorId}
          AND root_id IS NOT NULL AND root_id NOT LIKE ${notSteerBranch}`.map((r) => r.root),
    },
    {
      half: 'tree' as const,
      store: 'search_nodes',
      present: treePresent,
      roots: !treePresent ? [] : sql<{ root: string }>`
        SELECT DISTINCT root_id AS root FROM search_nodes
        WHERE actor_id = ${actor.actorId}
          AND root_id IS NOT NULL AND root_id NOT LIKE ${notSteerBranch}`.map((r) => r.root),
    },
  ];

  const rootsWritten = written.reduce((total, half) => total + half.roots.length, 0);

  // One oversized page, not a walk: a walk would hide a reader that skips a whole store.
  const visible = new Set(
    transcriptsPresent && treePresent ? read(sql, rootsWritten + 1).map((run) => run.id) : [],
  );

  const stores = written.map<SettleStoreScore>(({ half, store, present, roots }) => {
    const invisibleRoots = roots.filter((root) => !visible.has(root));

    return {
      half,
      store,
      present,
      rootsWritten: roots.length,
      rootsVisible: roots.length - invisibleRoots.length,
      invisibleRoots,
    };
  });

  return {
    stores,
    rootsWritten,
    invisibleRoots: stores.flatMap((store) => store.invisibleRoots),
  };
}


/**
 * One scorer's reading of one trajectory, the shape run records and the comparator consume.
 * `rate` is null, never 0, when nothing was eligible: 0/0 is a fact about the task, 0/7 about the agent.
 */
export interface BehaviourScore {
  readonly eligible: number;
  readonly passed: number;
  readonly rate: number | null;
  readonly measured?: Readonly<Record<string, number>>;
  readonly detail: string;
}

/** A named behavioural instrument; `asserts` is printed into run records so a number says what it measured. */
export interface BehaviourScorer {
  readonly name: string;
  readonly asserts: string;
  readonly score: (sql: SqlExecutor, actor: ActorHandle) => BehaviourScore;
}

function verdict(eligible: number, passed: number, detail: string): BehaviourScore {
  return { eligible, passed, rate: eligible === 0 ? null : passed / eligible, detail };
}

/**
 * Every recorded event of one type, parsed through `parseStoredRunEvent`. The type filter runs in SQL
 * so a malformed row of another type cannot break unrelated scorers; a malformed row of this type throws.
 */
function eventsOfType<K extends RunEvent['type']>(
  sql: SqlExecutor, actor: ActorHandle, type: K,
): Extract<RunEvent, { type: K }>[] {
  actor.assertCurrent();

  const rows = sql<{ payload: string }>`
    SELECT payload FROM run_events
    WHERE actor_id = ${actor.actorId} AND type = ${type}
    ORDER BY run_id ASC, event_index ASC`;

  return rows.map((row) => parseStoredRunEvent(row.payload))
    .filter((event): event is Extract<RunEvent, { type: K }> => event.type === type);
}


export const STEERING_TRIGGERS = [
  'repeated_call', 'repeated_failure', 'no_progress',
] as const;

/**
 * Did the harness's mechanical steer change what the model did next? A `turn_steering` row exists only
 * when a trigger fired, so the row count is the denominator; unknown triggers fail the canonical parse.
 */
export const steeringConversion: BehaviourScorer = {
  name: 'steering_conversion',
  asserts: 'a mechanical steer converted: the model did what the steer asked',
  score(sql, actor) {
    const rows = eventsOfType(sql, actor, 'turn_steering');
    const converted = rows.filter((row) => row.converted === true).length;

    const byTrigger = STEERING_TRIGGERS
      .map((trigger) => ({ trigger, n: rows.filter((r) => r.trigger === trigger).length }))
      .filter((entry) => entry.n > 0)
      .map((entry) => `${entry.trigger}×${String(entry.n)}`);

    return verdict(rows.length, converted,
      `${String(converted)}/${String(rows.length)} steers converted` +
      (byTrigger.length > 0 ? ` (${byTrigger.join(', ')})` : ''));
  },
};


/**
 * Did the agent build itself a tool and then reuse it? `reused` is a per-turn subset of `crafted`,
 * so summed lengths form a rate that cannot exceed 1. The denominator is tools crafted, not turns.
 */
export const craftReuse: BehaviourScorer = {
  name: 'craft_reuse',
  asserts: 'the agent crafted a tool mid-episode and then reused it',
  score(sql, actor) {
    const rows = eventsOfType(sql, actor, 'craft_cycle');
    const crafted = rows.reduce((n, row) => n + row.crafted.length, 0);
    const reused = rows.reduce((n, row) => n + row.reused.length, 0);
    const invoked = rows.reduce((n, row) => n + row.invoked.length, 0);

    return verdict(crafted, reused,
      `${String(reused)}/${String(crafted)} crafted tools reused, ` +
      `${String(invoked)} crafted-tool invocations across ${String(rows.length)} crafting turns`);
  },
};


/**
 * Did the agent's edits land? Only the `file` primitive reports this; shell edits score a zero
 * denominator. `detail` carries the dominant failure mode (`not_found` vs `stale`).
 */
export const editLanding: BehaviourScorer = {
  name: 'edit_landing',
  asserts: 'attempted file edits applied rather than failing to match',
  score(sql, actor) {
    const rows = eventsOfType(sql, actor, 'file_edit');
    const attempts = rows.reduce((n, row) => n + row.attempts, 0);
    const applied = rows.reduce((n, row) => n + row.applied, 0);
    const abandoned = rows.reduce((n, row) => n + row.abandonedPaths, 0);
    const modes = new Map<string, number>();

    for (const row of rows) {
      for (const [mode, count] of Object.entries(row.failures)) {
        if (count != null && count > 0) modes.set(mode, (modes.get(mode) ?? 0) + count);
      }
    }

    const worst = [...modes.entries()].sort((a, b) => b[1] - a[1])
      .map(([mode, n]) => `${mode}×${String(n)}`);

    return verdict(attempts, applied,
      `${String(applied)}/${String(attempts)} edits applied, ` +
      `${String(abandoned)} paths abandoned` +
      (worst.length > 0 ? `; failures ${worst.join(', ')}` : ''));
  },
};


/**
 * Did a broken failure streak stay broken? Every `execution_recovery` row is already a recovery, so the
 * numerator is findings whose signature never recurs in a later recovery row.
 */
export const recoveryDurability: BehaviourScorer = {
  name: 'recovery_durability',
  asserts: 'a broken failure streak stayed broken — the finding took',
  score(sql, actor) {
    const findings = eventsOfType(sql, actor, 'execution_recovery')
      .flatMap((row) => row.recoveries);

    // A signature recovered more than once necessarily failed again, so multiplicity is the falsifier.
    const seen = new Map<string, number>();

    for (const finding of findings) {
      const key = `${finding.tool}\u0000${finding.failedSignature}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    const held = [...seen.values()].filter((n) => n === 1).length;
    const recurring = [...seen.values()].filter((n) => n > 1).length;
    const streak = findings.reduce((n, f) => n + f.failures, 0);

    return verdict(seen.size, held,
      `${String(held)}/${String(seen.size)} recovery findings held ` +
      `(${String(recurring)} signatures failed again later), ` +
      `${String(streak)} consecutive failures absorbed`);
  },
};


/**
 * Did the run finish without the completion gate forcing a re-look? Reverse polarity: `converted: true`
 * means the agent claimed completion with work left, so the numerator is the un-converted rows.
 */
export const completionHonesty: BehaviourScorer = {
  name: 'completion_honesty',
  asserts: 'the run finished on an honest claim — the gate found no work left',
  score(sql, actor) {
    const rows = eventsOfType(sql, actor, 'completion_gate');
    const forced = rows.filter((row) => row.converted === true).length;

    return verdict(rows.length, rows.length - forced,
      `${String(rows.length - forced)}/${String(rows.length)} gated runs ended on an honest ` +
      `completion claim (${String(forced)} were forced back to work)`);
  },
};


/**
 * When a turn spilled output to a readable address, did the agent read it back? The denominator is
 * `referenced` spills; `followUps` is clamped to it since one address may be cited twice.
 */
export const spillRetrieval: BehaviourScorer = {
  name: 'spill_retrieval',
  asserts: 'the agent read back bulk output the budget spilled to an address',
  score(sql, actor) {
    const rows = eventsOfType(sql, actor, 'context_budget');
    const referenced = rows.reduce((n, row) => n + row.referenced, 0);
    const followUps = rows.reduce((n, row) => n + row.followUps, 0);
    const omitted = rows.reduce((n, row) => n + row.omittedChars, 0);

    return verdict(referenced, Math.min(followUps, referenced),
      `${String(followUps)} follow-ups against ${String(referenced)} readable spills, ` +
      `${String(omitted)} chars withheld from the root`);
  },
};


/**
 * The label the failure mix is written behind; `scripts/eval-triage.ts` matches it to tell a failure
 * mix from a plain usage histogram.
 */
const FAILURE_MIX_LABEL = 'failed: ';

export function formatFailureMix(byKey: readonly (readonly [string, number])[]): string {
  return FAILURE_MIX_LABEL + byKey.map(([key, n]) => `${key}×${String(n)}`).join(', ');
}

/**
 * The mix parsed from a `tool_outcomes` detail. Empty means no failing call or a record that predates
 * the mix. A malformed entry throws: this parses what this repository wrote.
 */
export function parseFailureMix(detail: string): readonly (readonly [string, number])[] {
  const segment = detail.split('; ').find((part) => part.startsWith(FAILURE_MIX_LABEL));

  if (segment === undefined) return [];

  return segment.slice(FAILURE_MIX_LABEL.length).split(', ').map((entry) => {
    const separator = entry.lastIndexOf('×');
    const count = Number.parseInt(entry.slice(separator + 1), 10);

    if (separator <= 0 || !Number.isInteger(count)) {
      throw new Error(`tool_outcomes failure mix is not "key×N": ${entry}`);
    }

    return [entry.slice(0, separator), count] as const;
  });
}

/** Tool health is attributed by producer outcome, not returned text; a row with no outcome suppresses the rate. */
export const toolOutcomes: BehaviourScorer = {
  name: 'tool_outcomes',
  asserts: 'producer-attributed tool outcomes, with complete attribution required for a rate',
  score(sql, actor) {
    const rows = eventsOfType(sql, actor, 'tool_call_end');
    const census = censusToolFailures(rows);
    const succeeded = rows.filter((row) => row.outcome?.success === true).length;
    const failed = census.failures.length;
    const unmeasured = rows.length - succeeded - failed;

    const detail = [
      `${String(succeeded)} succeeded, ${String(failed)} failed, ${String(unmeasured)} unmeasured / ${String(rows.length)} observed calls`,
      `${String(census.refused)} refused, ${String(census.workFailed)} work failed, `
        + `${String(census.runtimeMissing)} runtime absent, ${String(census.broke)} broke or unclassified`,
    ];

    if (census.byKey.length > 0) detail.push(formatFailureMix(census.byKey));

    return {
      eligible: rows.length, passed: succeeded,
      rate: rows.length === 0 || unmeasured > 0 ? null : succeeded / rows.length,
      detail: detail.join('; '), measured: { succeeded, failed, unmeasured },
    };
  },
};

/** The behavioural panel, in reporting order; the single list run records, suites and comparison iterate. */
export const BEHAVIOUR_SCORERS: readonly BehaviourScorer[] = [
  steeringConversion, craftReuse, editLanding,
  recoveryDurability, completionHonesty, spillRetrieval, toolOutcomes,
];
