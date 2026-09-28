/** Behavioural scorers over run events; each reports a denominator separately from passes. */
import {
  censusToolFailures, classifyToolFailure, parseStoredRunEvent, type ActorHandle, type RunEvent, type SqlExecutor,
} from '@kinu.run/core';

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
  asserts: 'a broken failure streak stayed broken: the finding took',
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
  asserts: 'the run finished on an honest claim: the gate found no work left',
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


/** The label the failure mix is written behind in a `tool_outcomes` detail. */
const FAILURE_MIX_LABEL = 'failed: ';

export function formatFailureMix(byKey: readonly (readonly [string, number])[]): string {
  return FAILURE_MIX_LABEL + byKey.map(([key, n]) => `${key}×${String(n)}`).join(', ');
}

/** A call fails if its outcome or an inner call failed; a row with no outcome suppresses the rate. */
export function scoreToolOutcomes(events: readonly RunEvent[]): BehaviourScore {
  const rows = events.filter((event): event is Extract<RunEvent, { type: 'tool_call_end' }> => event.type === 'tool_call_end');
  const census = censusToolFailures(rows);
  const failed = rows.filter((row) => classifyToolFailure(row) !== null).length;
  const succeeded = rows.filter((row) => row.outcome?.success === true && !row.outcome.failures?.length).length;
  const unmeasured = rows.length - succeeded - failed;

  const detail = [
    `${String(succeeded)} succeeded, ${String(failed)} failed, ${String(unmeasured)} unmeasured / ${String(rows.length)} observed calls`,
    `${String(census.failures.length)} failures: ${String(census.refused)} refused, ${String(census.workFailed)} work failed, `
      + `${String(census.runtimeMissing)} runtime absent, ${String(census.broke)} broke or unclassified`,
  ];

  if (census.byKey.length > 0) detail.push(formatFailureMix(census.byKey));

  return {
    eligible: rows.length, passed: succeeded,
    rate: rows.length === 0 || unmeasured > 0 ? null : succeeded / rows.length,
    detail: detail.join('; '),
    measured: {
      succeeded, failed, unmeasured,
      refused: census.refused, workFailed: census.workFailed, runtimeAbsent: census.runtimeMissing, broke: census.broke,
    },
  };
}

export const toolOutcomes: BehaviourScorer = {
  name: 'tool_outcomes',
  asserts: 'producer-attributed tool outcomes, codemode calls included, with complete attribution required for a rate',
  score: (sql, actor) => scoreToolOutcomes(eventsOfType(sql, actor, 'tool_call_end')),
};

/** The behavioural panel, in reporting order; the single list run records, suites and comparison iterate. */
export const BEHAVIOUR_SCORERS: readonly BehaviourScorer[] = [
  steeringConversion, craftReuse, editLanding,
  recoveryDurability, completionHonesty, spillRetrieval, toolOutcomes,
];
