/**
 * Behavioural scorers: did the agent USE the mechanism, use it PROPERLY, and
 * did the mechanism WORK.
 *
 * These are the measurement instruments the live suites assert with. Three
 * rules shape every one of them.
 *
 *   1. THEY READ THROUGH THE PRODUCTION READER. `listForkRuns` is what the
 *      Exploration pane calls, so that is what these call. A hand-written query
 *      beside the real one can agree with the write path while the pane stays
 *      empty — which is how an empty Exploration pane shipped twice, once
 *      because the writer wrote `search_nodes` and the reader read
 *      `head_journal`, and once the other way round.
 *   2. THEY CARRY A DENOMINATOR. Every score reports how many ELIGIBLE things
 *      it looked at, separately from how many passed. `0 of 0 runs failed` is
 *      the shape of a check that cannot fail, so a caller can assert the
 *      denominator is non-zero and mean it.
 *   3. THEY ARE PURE OVER `SqlExecutor`. Runner-agnostic, credential-free, and
 *      therefore self-testable: `packages/test-utils/tests/agent-evals.test.ts`
 *      drives each one to a known non-zero score AND to a failing score, so a
 *      green assertion in a live suite is known to be capable of being red.
 */
import {
  listForkRuns, STEER_BRANCH_RUN_ID_PREFIX, tableExists,
  type ForkRunSummary, type SqlExecutor,
} from '@proteus/core';

// ── (a) MCTS reached, branched, and ranked ───────────────────────

/** One competed (`settle=mcts`) run as the reader sees it, plus the durable
 *  winner marks the reader's summary does not carry. */
export interface CompetedRunScore {
  readonly id: string;
  /** Non-root nodes the search opened, per the reader. */
  readonly branches: number;
  /** The reader's winning score, or null when it found no terminal node. */
  readonly winnerScore: number | null;
  /** `search_nodes` rows this root marked `terminal`. Exactly one is correct:
   *  convergence marks the winner terminal and every other open node pruned. */
  readonly terminalNodes: number;
  /**
   * The `alternate_takes` winner recorded for this search, or null.
   *
   * Reported, never asserted: `captureAlternateTakes` writes a row ONLY when
   * the winner had a genuinely near-tied rival, so a decisive search correctly
   * has none. `alternate_takes` also carries no `root_id` — it is keyed by
   * `winner_node_id` — so this is resolved by joining back through
   * `search_nodes`, which is the only thing that ties a take to a search.
   */
  readonly takeWinnerId: string | null;
}

export interface ExplorationScore {
  /** Competed runs the reader can see — the denominator. */
  readonly competedRuns: number;
  /** Of those, runs that opened more than one branch. A one-branch search
   *  ranked nothing: there was no competition to win. */
  readonly branchedRuns: number;
  /** Of those, runs the reader can hand a winning score for. */
  readonly rankedRuns: number;
  /** Of those, runs whose ranking survived into the store as exactly one
   *  terminal node. A run can return a `winnerId` in memory while no row was
   *  ever marked — that run reads as ranked to the caller and unranked to
   *  every later reader. */
  readonly durablyRankedRuns: number;
  readonly runs: readonly CompetedRunScore[];
}

/**
 * Score every competed fork run the Exploration reader can see.
 *
 * `limit` defaults high enough to cover the whole store rather than the pane's
 * window: `listForkRuns` slices AFTER merging its two halves, so a burst of
 * merged runs can push competed runs out of a 20-row list and make a real
 * search read as absent.
 */
export function scoreExploration(sql: SqlExecutor, limit = 1000): ExplorationScore {
  const competed = listForkRuns(sql, limit).filter((run) => run.settle === 'competed');
  const runs = competed.map<CompetedRunScore>((run) => {
    const terminal = sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM search_nodes
      WHERE root_id = ${run.id} AND status = 'terminal'`[0]?.n ?? 0;
    const take = sql<{ winner_node_id: string }>`
      SELECT t.winner_node_id FROM alternate_takes t
      JOIN search_nodes n ON n.id = t.winner_node_id
      WHERE n.root_id = ${run.id}`[0];
    return {
      id: run.id,
      branches: run.branches,
      winnerScore: run.winnerScore,
      terminalNodes: terminal,
      takeWinnerId: take?.winner_node_id ?? null,
    };
  });
  return {
    competedRuns: runs.length,
    branchedRuns: runs.filter((r) => r.branches > 1).length,
    rankedRuns: runs.filter((r) => r.winnerScore !== null).length,
    durablyRankedRuns: runs.filter((r) => r.terminalNodes === 1).length,
    runs,
  };
}

// ── (b) Every settle mode writes where the reader reads ──────────

/** A write store, the settle mode that fills it, and how much of it the reader
 *  can actually see. */
export interface SettleStoreScore {
  /** The settle vocabulary the reader reports for this store. */
  readonly settle: ForkRunSummary['settle'];
  /** The table the strategy writes. Named so a failure says where to look. */
  readonly store: string;
  /**
   * The table exists in this store.
   *
   * Reported rather than assumed, because a query against a missing table
   * THROWS, and a thrown SQLiteError is not a measurement — it is
   * indistinguishable from a broken scorer. Measured live: a workspace built by
   * `createWorkspace` has `search_nodes` but not `head_journal`, and the
   * unguarded version died mid-eval. Treating a missing table as zero roots is
   * WORSE, because "0 of 0 roots invisible" is then a pass over a table that is
   * not there.
   */
  readonly present: boolean;
  /** Distinct run roots present in the write store — this store's denominator. */
  readonly rootsWritten: number;
  /** Of those, roots the reader returns. */
  readonly rootsVisible: number;
  /** The roots it cannot see. Empty is the only acceptable value. */
  readonly invisibleRoots: readonly string[];
}

export interface SettleVisibilityScore {
  readonly stores: readonly SettleStoreScore[];
  /** Total run roots written across every store — the denominator. */
  readonly rootsWritten: number;
  /** Every root no reader can reach, across every store. */
  readonly invisibleRoots: readonly string[];
}

/**
 * For each settle mode's write store, does the Exploration reader return what
 * was written?
 *
 * This is the assertion the twice-shipped empty pane needed. It is directional
 * in both senses: a new settle mode that writes a third store shows up here as
 * `rootsWritten` the reader cannot see, and a reader that stops reading one
 * half shows up as that half going invisible.
 *
 * Two kinds of root are excluded in SQL rather than missed. Steer-as-Branch
 * runs journal through the same seam but are deliberately filtered out of the
 * fork list by their id prefix, and a legacy NULL root is invisible to every
 * root-scoped query — counting either would report a permanent, unfixable
 * failure and teach everyone to ignore this score.
 *
 * `read` defaults to the production reader and exists so the scorer's own tests
 * can hand it the reader as it was WHEN THE BUG SHIPPED — one that reads a
 * single half. Without that, this scorer has no way to demonstrate it can go
 * red: today's reader returns any root that exists in either store, so a green
 * result would be indistinguishable from a scorer that never looks.
 */
export function scoreSettleVisibility(
  sql: SqlExecutor,
  read: (sql: SqlExecutor, limit: number) => readonly ForkRunSummary[] = listForkRuns,
): SettleVisibilityScore {
  const notSteerBranch = `${STEER_BRANCH_RUN_ID_PREFIX}%`;
  const mergedPresent = tableExists(sql, 'head_journal');
  const competedPresent = tableExists(sql, 'search_nodes');
  const written = [
    {
      settle: 'merged' as const,
      store: 'head_journal',
      present: mergedPresent,
      roots: !mergedPresent ? [] : sql<{ root: string }>`
        SELECT DISTINCT root_id AS root FROM head_journal
        WHERE root_id IS NOT NULL AND root_id NOT LIKE ${notSteerBranch}`.map((r) => r.root),
    },
    {
      settle: 'competed' as const,
      store: 'search_nodes',
      present: competedPresent,
      roots: !competedPresent ? [] : sql<{ root: string }>`
        SELECT DISTINCT root_id AS root FROM search_nodes
        WHERE root_id IS NOT NULL AND root_id NOT LIKE ${notSteerBranch}`.map((r) => r.root),
    },
  ];

  const rootsWritten = written.reduce((total, half) => total + half.roots.length, 0);
  // Ask for more than was written: `listForkRuns` slices AFTER merging its two
  // halves, so the reader's own window must not be mistaken for a missing row.
  // The reader queries BOTH stores, so it only runs when both exist.
  const visible = new Set(
    mergedPresent && competedPresent ? read(sql, rootsWritten + 1).map((run) => run.id) : [],
  );

  const stores = written.map<SettleStoreScore>(({ settle, store, present, roots }) => {
    const invisibleRoots = roots.filter((root) => !visible.has(root));
    return {
      settle,
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

// ── (c) Delegation rate over eligible turns ──────────────────────

/** The two delegation steers, which are the two arms of the A/B. */
export const DELEGATION_TRIGGERS = ['turn_start_no_delegation', 'long_turn_no_delegation'] as const;
export type DelegationTrigger = typeof DELEGATION_TRIGGERS[number];

/**
 * Why this scorer does NOT count `agents` tool calls.
 *
 * The obvious independent signal would be a `tool_call_start` row naming the
 * `agents` tool, narrowed to the actions that actually spawn (`fork`, `staff`)
 * — because the steer's own conversion test accepts ANY `agents` call, so
 * `agents({action:'list'})` converts it without delegating anything.
 *
 * That signal does not exist. NO production code emits `tool_call_start`: the
 * type is declared in the event union, filtered by the run-events route, and
 * read by two readers, but both backends' sinks emit only `tool_call_end` and
 * `step_finish`. A scorer built on it would have returned 0 forever, on every
 * backend, and reported that as "the agent never delegated" — the precise
 * false-zero this harness exists to eliminate, shipped inside the harness.
 *
 * `head_split` is what a fork actually writes (`{ rootId, headIds, rationale }`),
 * and its producer exists because local runs "left no trace of a fork". So
 * that is the signal.
 */
export const DELEGATION_EVENT_TYPE = 'head_split';

export interface DelegationArmScore {
  readonly trigger: DelegationTrigger;
  /** Steering rows written for this trigger. A row exists only when the
   *  eligibility predicate fired, so this IS the count of eligible turns. */
  readonly eligible: number;
  /** Of those, rows the harness marked converted. */
  readonly converted: number;
  /** converted / eligible, or null when nothing was eligible. Never 0 for an
   *  empty arm: a rate over no turns is absent, not zero. */
  readonly rate: number | null;
}

export interface DelegationScore {
  /** Reported per arm and never pooled: the step-25 arm only fires on turns the
   *  turn-start arm did not convert, so the two are sequentially dependent. */
  readonly arms: readonly DelegationArmScore[];
  /** Eligible turns across both arms — the denominator. */
  readonly eligible: number;
  readonly converted: number;
  /**
   * Runs that actually forked, counted from `head_split` — independent of the
   * steers, and the honest answer to "did it delegate at all".
   *
   * Not the same as `converted`: the steer's conversion test accepts any
   * `agents` call, so a turn can convert by listing the roster. This counts
   * only turns that opened heads.
   */
  readonly forkedRuns: number;
  /** Heads opened across all forks. A fork that opened one head delegated
   *  nothing to compare. */
  readonly headsOpened: number;
  /** Completed turns in the store. Delegation rows are written when a turn
   *  settles, so a turn killed by a timeout contributes to neither. */
  readonly completedTurns: number;
  /**
   * Tool calls the eligible turns actually made — the PRECONDITION, not a
   * result.
   *
   * A turn can settle, be eligible, and have done nothing: a recorded bench run
   * fired evolution 14 times over 14 turns and every one read "ungraded, 0 tool
   * calls, 1 step". Over turns like those this scorer would report a delegation
   * rate of 0%, and that number would be read as "the agent chose not to
   * delegate" when the truth is that nothing happened at all. Those are
   * completely different findings and only one of them is about delegation.
   *
   * So a caller must assert this is non-zero BEFORE reading `rate`. Zero here
   * makes the rate UNDECIDABLE rather than 0.
   */
  readonly toolCalls: number;
}

export function scoreDelegation(sql: SqlExecutor): DelegationScore {
  const rows = sql<{ trigger: string; converted: number }>`
    SELECT json_extract(payload, '$.trigger') AS trigger,
           json_extract(payload, '$.converted') AS converted
    FROM run_events WHERE type = 'turn_steering'`;

  const arms = DELEGATION_TRIGGERS.map<DelegationArmScore>((trigger) => {
    const forArm = rows.filter((row) => row.trigger === trigger);
    const converted = forArm.filter((row) => row.converted === 1).length;
    return {
      trigger,
      eligible: forArm.length,
      converted,
      rate: forArm.length === 0 ? null : converted / forArm.length,
    };
  });

  const splits = sql<{ run_id: string; heads: number }>`
    SELECT run_id,
           json_array_length(json_extract(payload, '$.headIds')) AS heads
    FROM run_events WHERE type = ${DELEGATION_EVENT_TYPE}`;
  const forkedRuns = new Set(splits.map((row) => row.run_id));

  const completedTurns = sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE type = 'turn_end'`[0]?.n ?? 0;

  // `tool_call_end` rather than `tool_call_start`: nothing in production emits
  // the latter. See DELEGATION_EVENT_TYPE above for the same trap.
  const toolCalls = sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE type = 'tool_call_end'`[0]?.n ?? 0;

  return {
    arms,
    eligible: arms.reduce((total, arm) => total + arm.eligible, 0),
    converted: arms.reduce((total, arm) => total + arm.converted, 0),
    forkedRuns: forkedRuns.size,
    headsOpened: splits.reduce((total, row) => total + (row.heads ?? 0), 0),
    completedTurns,
    toolCalls,
  };
}
