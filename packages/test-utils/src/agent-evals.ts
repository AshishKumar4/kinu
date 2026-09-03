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
  censusToolFailures, listForkRuns, parseStoredRunEvent, STEER_BRANCH_RUN_ID_PREFIX,
  tableExists,
  type ForkRunSummary, type RunEvent, type SqlExecutor,
} from '@kinu.run/core';

// ── (a) A search tree reached, branched, and ranked ──────────────

/** One run that grew a SEARCH TREE, as the reader sees it, plus the durable winner
 *  marks the reader's summary does not carry. */
export interface SearchRunScore {
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
  /** Runs with a search tree that the reader can see — the denominator. */
  readonly searchRuns: number;
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
  readonly runs: readonly SearchRunScore[];
}

/**
 * Score every run with a search tree that the Exploration reader can see.
 *
 * `limit` defaults high enough to cover the whole store rather than the pane's
 * window: `listForkRuns` slices its merged order AFTER positioning both halves, so a
 * burst of transcript-only runs can push a tree-bearing run out of a 20-row list and
 * make a real search read as absent.
 */
export function scoreExploration(sql: SqlExecutor, limit = 1000): ExplorationScore {
  const searched = listForkRuns(sql, null, limit).items.filter((run) => run.hasSearchTree);
  const runs = searched.map<SearchRunScore>((run) => {
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
    searchRuns: runs.length,
    branchedRuns: runs.filter((r) => r.branches > 1).length,
    rankedRuns: runs.filter((r) => r.winnerScore !== null).length,
    durablyRankedRuns: runs.filter((r) => r.terminalNodes === 1).length,
    runs,
  };
}

// ── (b) Every half a run can write is where the reader reads ─────

/** The two stores a run's branches can land in, named by what they hold. */
export type ExplorationHalf = 'tree' | 'transcripts';

/** A write store, the half of a run that fills it, and how much of it the reader
 *  can actually see. */
export interface SettleStoreScore {
  /** Which half of a run this store holds. */
  readonly half: ExplorationHalf;
  /** The table the writer fills. Named so a failure says where to look. */
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
 * For each half a run can write, does the Exploration reader return what was written?
 *
 * This is the assertion the twice-shipped empty pane needed. It is directional in both
 * senses: a writer that fills a third store shows up here as `rootsWritten` the reader
 * cannot see, and a reader that stops reading one half shows up as that half going
 * invisible.
 *
 * Two kinds of root are excluded in SQL rather than missed. Steer-as-Branch runs
 * journal through the same seam but are deliberately filtered out of the run list by
 * their id prefix, and a legacy NULL root is invisible to every root-scoped query —
 * counting either would report a permanent, unfixable failure and teach everyone to
 * ignore this score.
 *
 * `read` defaults to the production reader and exists so the scorer's own tests can
 * hand it the reader as it was WHEN THE BUG SHIPPED — one that reads a single half.
 * Without that, this scorer has no way to demonstrate it can go red: today's reader
 * returns any root that exists in either store, so a green result would be
 * indistinguishable from a scorer that never looks.
 */
export function scoreSettleVisibility(
  sql: SqlExecutor,
  read: (sql: SqlExecutor, limit: number) => readonly ForkRunSummary[] =
    (readSql, limit) => listForkRuns(readSql, null, limit).items,
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
        WHERE root_id IS NOT NULL AND root_id NOT LIKE ${notSteerBranch}`.map((r) => r.root),
    },
    {
      half: 'tree' as const,
      store: 'search_nodes',
      present: treePresent,
      roots: !treePresent ? [] : sql<{ root: string }>`
        SELECT DISTINCT root_id AS root FROM search_nodes
        WHERE root_id IS NOT NULL AND root_id NOT LIKE ${notSteerBranch}`.map((r) => r.root),
    },
  ];

  const rootsWritten = written.reduce((total, half) => total + half.roots.length, 0);
  // Ask for more than was written: the reader pages its merged order, so the reader's
  // own page must not be mistaken for a missing row. One page rather than a walk,
  // deliberately — this scores whether both stores are READ AT ALL, and a walk would
  // hide a half-blind reader behind enough pages. The reader queries BOTH stores, so it
  // only runs when both exist.
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

// ── (c) The uniform behavioural verdict ──────────────────────────

/**
 * One scorer's reading of one trajectory, in the shape every consumer needs.
 *
 * The three scorers above each return their own rich shape because each is read
 * by a human looking at one specific mechanism. The scorers below are also read
 * by machines — the run recorder that persists a run, and the comparator that
 * pairs two runs through `packages/core/src/bench`'s paired statistics — and
 * those need one shape, or every consumer grows a switch over scorer names.
 *
 * `rate` is null, never 0, when nothing was eligible. That distinction is the
 * whole point: `0/0` is "the mechanism never got a chance", which is a fact
 * about the TASK, while `0/7` is "it got seven chances and took none", which is
 * a fact about the AGENT. Collapsing them into 0.0 is how a corpus that never
 * exercised a mechanism comes to read as an agent that never uses it.
 */
export interface BehaviourScore {
  /** Opportunities the mechanism actually had — the denominator. */
  readonly eligible: number;
  /** Of those, opportunities it took correctly — the numerator. */
  readonly passed: number;
  /** passed/eligible, or null when nothing was eligible. */
  readonly rate: number | null;
  /** One line of evidence naming the counts, for the run record. */
  readonly detail: string;
}

/**
 * A named behavioural instrument.
 *
 * Pure over `SqlExecutor` like its three predecessors, so it is runner-agnostic
 * and self-testable without a credential. `asserts` is printed into run records
 * so a stored number says what it measured, not just what it was called — a
 * scorer whose meaning lives only in the reader's memory is a scorer whose
 * meaning drifts.
 */
export interface BehaviourScorer {
  readonly name: string;
  readonly asserts: string;
  readonly score: (sql: SqlExecutor) => BehaviourScore;
}

function verdict(eligible: number, passed: number, detail: string): BehaviourScore {
  return { eligible, passed, rate: eligible === 0 ? null : passed / eligible, detail };
}

/**
 * Every recorded event of one type, across every run, validated.
 *
 * PARSES THROUGH THE PRODUCTION PARSE. `parseStoredRunEvent` is the same
 * function `RunEventRecorder.read` uses, so a payload reaches a scorer only if
 * it satisfies the canonical union — which means the field reads below are
 * compiler-checked against the producer's own declaration rather than against a
 * local interface. Seven such interfaces were written for these scorers and then
 * deleted: each was a copy of a shape the producer already owns, free to drift
 * the day a field is renamed and silently reading `undefined` when it did.
 *
 * THE TYPE FILTER IS IN SQL, ON PURPOSE, and that is the one place this departs
 * from `getRunEvents`. The recorder's reader parses a window and filters by type
 * AFTER parsing, so a single malformed row of ANY type — a `step_finish` whose
 * `messages` no longer satisfy the AI SDK's own schema, say — throws for every
 * caller, including the six scorers that never look at that type. For a
 * reporting harness that would turn one bad row into eight missing numbers. The
 * `idx_run_events_type` index exists (events/recorder.ts:143) precisely so this
 * narrowing is cheap.
 *
 * A malformed row of the type a scorer DOES read still throws, deliberately.
 * That is a corrupt reward signal, and it must be loud rather than quietly
 * lowering a denominator.
 */
function eventsOfType<K extends RunEvent['type']>(
  sql: SqlExecutor, type: K,
): Extract<RunEvent, { type: K }>[] {
  const rows = sql<{ payload: string }>`
    SELECT payload FROM run_events WHERE type = ${type}
    ORDER BY run_id ASC, event_index ASC`;
  return rows.map((row) => parseStoredRunEvent(row.payload))
    .filter((event): event is Extract<RunEvent, { type: K }> => event.type === type);
}

// ── (d) Steering: every mechanical trigger ───────────────────────

/** The three mechanical triggers, mirroring the producer's picklist
 *  (events/types.ts:264). Used only to order the per-trigger breakdown;
 *  membership is enforced upstream by the canonical parse, not here. */
export const STEERING_TRIGGERS = [
  'repeated_call', 'repeated_failure', 'no_progress',
] as const;

/**
 * Did the harness's mechanical steer change what the model did next?
 *
 * A `turn_steering` row exists ONLY when an eligibility predicate fired, so the
 * row count IS the count of eligible turns and no separate denominator query is
 * needed.
 *
 * There is no branch here for a trigger this scorer does not recognise, because
 * one is unreachable: `trigger` is a valibot picklist, so a trigger added to the
 * producer without being added to the schema makes the canonical parse THROW
 * before a scorer sees the row. That is the stronger guarantee — a new steer
 * cannot quietly slip out of this denominator and read as a steer that never
 * fired. `steeringConversion — a trigger outside the producer's picklist` pins
 * it.
 */
export const steeringConversion: BehaviourScorer = {
  name: 'steering_conversion',
  asserts: 'a mechanical steer converted: the model did what the steer asked',
  score(sql) {
    const rows = eventsOfType(sql, 'turn_steering');
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

// ── (e) The in-episode craft loop actually closing ───────────────

/**
 * Did the agent build itself a tool and then reach for it again?
 *
 * `reused` is a subset of `crafted` by construction: the producer intersects the
 * turn's earned invocations against the tools crafted in that same turn
 * (orchestrator/craft-cycle.ts:150), and both sets are cleared per turn. So
 * summing the two array lengths across rows is a well-formed rate, and cannot
 * exceed 1 the way a naive cross-turn join would.
 *
 * The denominator is tools CRAFTED, not turns. A turn that crafted three tools
 * and reused one is one third of the loop closing, not a pass.
 */
export const craftReuse: BehaviourScorer = {
  name: 'craft_reuse',
  asserts: 'the agent crafted a tool mid-episode and then reused it',
  score(sql) {
    const rows = eventsOfType(sql, 'craft_cycle');
    const crafted = rows.reduce((n, row) => n + row.crafted.length, 0);
    const reused = rows.reduce((n, row) => n + row.reused.length, 0);
    const invoked = rows.reduce((n, row) => n + row.invoked.length, 0);
    return verdict(crafted, reused,
      `${String(reused)}/${String(crafted)} crafted tools reused, ` +
      `${String(invoked)} crafted-tool invocations across ${String(rows.length)} crafting turns`);
  },
};

// ── (f) Edits landing, and the exact-match failures they hit ─────

/**
 * Did the agent's edits actually land?
 *
 * This signal exists only because the `file` primitive reports it. A shell-based
 * edit cannot produce this row at all — `sed -i` exits 0 whether or not it
 * matched anything (events/types.ts:136-139) — so a corpus solved with shell
 * edits scores a zero denominator here, which is the honest answer and not a
 * pass.
 *
 * The dominant failure MODE is carried in `detail` rather than asserted:
 * `not_found` says the model is inventing anchors, `stale` says it is editing
 * from a read it never refreshed, and those call for different fixes.
 */
export const editLanding: BehaviourScorer = {
  name: 'edit_landing',
  asserts: 'attempted file edits applied rather than failing to match',
  score(sql) {
    const rows = eventsOfType(sql, 'file_edit');
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

// ── (g) Recovery that TOOK, which is the only kind that counts ────

/**
 * Did the agent break a failure streak and STAY out of it?
 *
 * The naive scorer here cannot fail. An `execution_recovery` row is written only
 * when a streak was already broken by a changed call that ran clean
 * (events/types.ts:193-196), so counting recoveries against recoveries is
 * `n/n = 1.00` on every run forever — a number that looks like a measurement
 * and is a tautology.
 *
 * So the denominator is recovery FINDINGS and the numerator is findings that
 * held. The producer names the falsifier itself: "the SAME signature failing
 * again in a later turn is the direct falsifier that the finding did not take"
 * (events/types.ts:206-209). A signature that reappears in any later recovery
 * row means the injected finding did not stick, and that finding scores red.
 */
export const recoveryDurability: BehaviourScorer = {
  name: 'recovery_durability',
  asserts: 'a broken failure streak stayed broken — the finding took',
  score(sql) {
    const findings = eventsOfType(sql, 'execution_recovery')
      .flatMap((row) => row.recoveries);
    // Counted, not ordered. A signature recorded as recovered more than once
    // necessarily failed again after the first recovery, so multiplicity alone
    // is the falsifier and the scorer needs no cross-run event ordering — which
    // it could not rely on anyway, since runs are read newest-first.
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

// ── (h) Completion honesty, measured against the gate ────────────

/**
 * Did the run finish without the completion gate having to force a re-look?
 *
 * NOTE THE POLARITY, because it is the reverse of every other scorer here.
 * `converted: true` means the gate handed the agent freshly observed state and
 * the agent then MADE TOOL CALLS — i.e. it had claimed completion while real
 * work remained, and the gate caught it (events/types.ts:162-169). So the good
 * outcome is `converted: false`, and the numerator is the un-converted rows.
 *
 * A high conversion rate is therefore not a healthy mechanism, it is a model
 * that habitually declares victory early — which is exactly the behaviour the
 * owner asked to be able to see. Scoring this the obvious way round would
 * reward the defect.
 */
export const completionHonesty: BehaviourScorer = {
  name: 'completion_honesty',
  asserts: 'the run finished on an honest claim — the gate found no work left',
  score(sql) {
    const rows = eventsOfType(sql, 'completion_gate');
    const forced = rows.filter((row) => row.converted === true).length;
    return verdict(rows.length, rows.length - forced,
      `${String(rows.length - forced)}/${String(rows.length)} gated runs ended on an honest ` +
      `completion claim (${String(forced)} were forced back to work)`);
  },
};

// ── (i) Spilled context read back, not silently lost ─────────────

/**
 * When the turn spilled bulk output somewhere readable, did the agent read it?
 *
 * The denominator is `referenced` — trips whose spill write LANDED, so the agent
 * genuinely had an address it could fetch (context-budget.ts:83-84). Trips that
 * spilled without a resolvable reference are excluded: there was nothing to read
 * back, so charging the agent for not reading it would score the harness's own
 * failure against the model.
 *
 * The numerator is `followUps`, tool calls that cited a spill address
 * (context-budget.ts:87-88). It is clamped to the denominator because one
 * address may legitimately be cited twice, and a rate above 1 would break the
 * paired statistics downstream rather than reporting enthusiasm.
 */
export const spillRetrieval: BehaviourScorer = {
  name: 'spill_retrieval',
  asserts: 'the agent read back bulk output the budget spilled to an address',
  score(sql) {
    const rows = eventsOfType(sql, 'context_budget');
    const referenced = rows.reduce((n, row) => n + row.referenced, 0);
    const followUps = rows.reduce((n, row) => n + row.followUps, 0);
    const omitted = rows.reduce((n, row) => n + row.omittedChars, 0);
    return verdict(referenced, Math.min(followUps, referenced),
      `${String(followUps)} follow-ups against ${String(referenced)} readable spills, ` +
      `${String(omitted)} chars withheld from the root`);
  },
};

// ── (j) Tool calls that worked ───────────────────────────────────

/**
 * The label the failure mix is written behind, and read back from.
 *
 * A run record carries the census as prose because `EvalScoreRow` has one
 * `detail` string, so the mix is the only durable record of WHICH calls failed.
 * `scripts/eval-triage.ts` reads it back to rank a defect against its key, and a
 * reader that guessed at this format would read the LEGACY detail — a usage
 * histogram carrying no failure attribution at all, which is why the label is
 * matched rather than the shape.
 */
const FAILURE_MIX_LABEL = 'failed: ';

/** The failure mix as the record stores it: `tool·action·reason×N`, heaviest first. */
export function formatFailureMix(byKey: readonly (readonly [string, number])[]): string {
  return FAILURE_MIX_LABEL + byKey.map(([key, n]) => `${key}×${String(n)}`).join(', ');
}

/**
 * The mix back out of a `tool_outcomes` detail, empty when the record names none.
 *
 * Empty means one of two different things and the caller must keep them apart:
 * the run had no failing call, or the record predates the mix. `flash-a` and
 * `flash-b` are the second — they published `103/126` and could not say which 23
 * failed. A malformed entry THROWS rather than being skipped: this parses what
 * this repository wrote, so a shape it does not recognise is drift, not data.
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

/**
 * Did the agent's tool calls succeed — and where they did not, WHY?
 *
 * TWO KINDS OF FAILURE, and counting only the first is a defect this scorer
 * shipped with. `error` is the TRANSPORT discriminator: the tool itself threw. A
 * command that ran fine and exited non-zero is an ordinary SUCCESSFUL result
 * whose text begins `Error (exit N)` (`formatExecResult`, execution/
 * exec-result.ts:72), so a scorer reading only `error` counts a failed build, a
 * failed test run and a failed `git apply` as successes. That exact confusion
 * graded a command exiting 3 as `accepted` at quality 0.70 in the evolution
 * reward, and it is the inverted-contamination shape: the worst call in the turn
 * contributing the best number.
 *
 * THE HISTOGRAM COUNTED THE WRONG ROWS. It was built over every call, so every
 * published mix summed to `eligible` and described the run's tool USAGE while
 * sitting beside a failure rate — a census of calls read as a census of
 * failures. Run flash-a scored 103/126 and could not say which 23 failed.
 *
 * AND THE RATE POOLED FOUR DIFFERENT FACTS. `censusToolFailures` splits them,
 * because which part a failure sits in is the whole finding: a tool that
 * REFUSED correctly (an `old_text` that is not in the file, an unread file) is
 * the FAIL-loudly contract working; a command that ran and exited non-zero is
 * the WORK failing, which on a repair task is the agent finding the broken test
 * it was sent to find; a command that exited 127 is a program the WORKSPACE DOES
 * NOT HAVE, which is a platform gap and not the agent's doing at all; only the
 * remainder is a candidate defect. The headline stays the pooled rate so it
 * remains comparable with every run already in the ledger, and the detail names
 * the split so the number can be read correctly.
 *
 * This is the coarsest instrument here and deliberately so: it is the one that
 * still has a non-zero denominator on a task too small to craft, spill, steer or
 * edit, so a run is never scored entirely on absent mechanisms.
 */
export const toolOutcomes: BehaviourScorer = {
  name: 'tool_outcomes',
  asserts: 'tool calls returned AND the command they ran did not fail',
  score(sql) {
    const rows = eventsOfType(sql, 'tool_call_end');
    const census = censusToolFailures(rows);
    const failed = census.failures.length;
    const detail = [
      `${String(rows.length - failed)}/${String(rows.length)} tool calls returned`,
      `${String(census.refused)} refused, ${String(census.workFailed)} work failed, `
        + `${String(census.runtimeMissing)} runtime absent, ${String(census.broke)} broke`,
    ];
    if (census.byKey.length > 0) detail.push(formatFailureMix(census.byKey));
    return verdict(rows.length, rows.length - failed, detail.join('; '));
  },
};

/**
 * The behavioural panel, in reporting order.
 *
 * Ordered coarse-signal-last so a reader scanning a run record meets the
 * specific mechanisms first. Exported as the single list every consumer
 * iterates: adding a scorer here is what puts it in run records, in the live
 * suite and in cross-run comparison at once, with no second registration.
 */
export const BEHAVIOUR_SCORERS: readonly BehaviourScorer[] = [
  steeringConversion, craftReuse, editLanding,
  recoveryDurability, completionHonesty, spillRetrieval, toolOutcomes,
];
