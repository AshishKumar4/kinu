/**
 * Execution-recovery findings — the step clock's KNOWLEDGE channel, beside the
 * craft cycle's artifact channel.
 *
 * Every other lesson in this repo binds post-hoc to a graded turn, and inside
 * one long autonomous episode there are no graded turns — so however much the
 * episode learns about this task, this codebase, this environment, nothing
 * accumulates: it lives in the context window until compaction or a
 * continuation boundary takes it. This module is where the one thing the
 * runtime can PROVE the episode learned gets written down, durably, without
 * asking the model anything.
 *
 * ── The observation ─────────────────────────────────────────────────────
 *
 * A tool's failure streak — the same per-tool, no-success-in-between ledger
 * the mechanical steer fires on (orchestrator/turn-steering.ts) — reaches the
 * steer threshold and is then broken by a CHANGED call of the same tool that
 * ran clean. Both halves are the runtime's own records: the failing results
 * and the clean result are read by the same predicate the steer trusts, and
 * the arguments are what the hook carried, not what the model claims. The
 * model cannot write this record, only provoke it.
 *
 * The changed-call condition is load-bearing: a streak broken by the SAME
 * call finally working is a retry that got lucky, and writing "keep grinding"
 * into durable context is the exact misevolution the steer exists to prevent.
 * Only an approach that changed and then ran is worth a line.
 *
 * ── The ceiling, stated plainly ─────────────────────────────────────────
 *
 * Two limits, and the rendered line claims neither away:
 *
 *   1. "Ran clean" is not "did the right thing" — the same ceiling every
 *      execution signal in this repo carries (craft/in-episode.ts,
 *      outcomes.ts executionVerdict).
 *   2. The pairing is TEMPORAL, not causal. The clean call is the first clean
 *      call of that tool after the streak; the actual fix may have happened
 *      between the calls (an edit, a different tool). The line records both
 *      halves verbatim and lets the reader — a model with the full transcript
 *      in front of it — judge whether the pairing means anything.
 *
 * That is why a finding gates NOTHING. It is injected as a bounded hint plane
 * (prompting/volatile-context.ts), displaced by newer findings, and it is
 * structurally barred from every wider surface: recorded provisional and bound
 * to no turn, so the corroboration gate that admits lessons into MEMORY.md can
 * never fire for it, and the experience library (corroborated-only) can never
 * export it. The blast radius of a junk pairing is one line of hint text.
 *
 * ── Why the lessons ledger, and why durable ─────────────────────────────
 *
 * One store: findings ARE lessons — prose observations with provenance — and
 * `source = 'execution_recovery'` is the provenance that says machine, not
 * reflection. A second table would be the parallel path this repo keeps
 * deleting. Durable because the episode outlives instances: a Durable Object
 * is evicted mid-run, a long task is stitched from continuation turns, and an
 * in-memory note dies exactly when it was about to matter.
 */

import type { SqlExecutor } from '../types/primitives.js';
import { listLessons, recordLesson } from './outcomes.js';

/**
 * One execution-proven recovery, as the failure ledger observed it. The arg
 * echoes arrive bounded from the detector (turn-steering's own echo cap) —
 * nothing here re-reads the calls.
 */
export interface RecoveryFinding {
  readonly tool: string;
  /** Consecutive failures before the changed call. */
  readonly failures: number;
  /** Bounded echo of the LAST failing call's arguments. */
  readonly failedArgs: string;
  /** Bounded echo of the changed call that then ran clean. */
  readonly succeededArgs: string;
  /** Stable signature (tool + canonicalized-args hash) of the failing call.
   *  The same signature failing again later is the direct falsifier: a
   *  finding that took should prevent its own repeat. */
  readonly failedSignature: string;
}

/** Findings injected per step, newest first. Also the dedup window: a finding
 *  already riding the context is not re-recorded — but one that recurred
 *  after falling out of it is, because the recurrence itself is signal. */
export const MAX_RECOVERY_FINDINGS = 5;

/** The rendered line — both halves verbatim, no causal claim. */
export function recoveryFindingText(f: RecoveryFinding): string {
  return `\`${f.tool}\` failed ${f.failures}x in a row with ${f.failedArgs}; `
    + `the first \`${f.tool}\` call that then ran clean was ${f.succeededArgs}`;
}

/**
 * Record one finding into the lessons ledger. Returns false when the identical
 * finding is already inside the injection window — the context already says it,
 * and a duplicate row would spend one of the five slots saying it twice.
 * Throws only what the ledger throws; callers on the turn path absorb that
 * (a lost finding must never fail the turn that produced it).
 */
export function recordRecoveryFinding(sql: SqlExecutor, finding: RecoveryFinding, now?: number): boolean {
  const text = recoveryFindingText(finding);
  if (listRecoveryFindings(sql).includes(text)) return false;
  recordLesson(sql, {
    turnIds: [],
    text,
    source: 'execution_recovery',
    status: 'provisional',
    now,
  });
  return true;
}

/** The injectable findings, newest first — what the dynamic-context snapshot
 *  reads per step. Empty on a runtime without the ledger (listLessons already
 *  absorbs the missing table). */
export function listRecoveryFindings(sql: SqlExecutor, limit = MAX_RECOVERY_FINDINGS): string[] {
  return listLessons(sql, { source: 'execution_recovery', limit }).map((lesson) => lesson.text);
}
