/**
 * Execution-recovery findings: a tool's failure streak reaching the steer threshold,
 * then broken by a changed call of the same tool that ran clean. The same call finally
 * succeeding is a lucky retry and is not recorded. The pairing is temporal, not causal,
 * so a finding gates nothing: it is a provisional, turn-unbound lesson
 * (`source = 'execution_recovery'`) that the corroboration gate never admits.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { listLessons, recordLesson } from './outcomes';

/** Arg echoes arrive already bounded by the detector. */
export interface RecoveryFinding {
  readonly tool: string;
  readonly failures: number;
  /** Bounded echo of the last failing call's arguments. */
  readonly failedArgs: string;
  readonly succeededArgs: string;
  /** The same signature failing again later falsifies the finding. */
  readonly failedSignature: string;
}

/** Findings injected per step, newest first; also the dedup window, so a recurrence after falling out is re-recorded. */
export const MAX_RECOVERY_FINDINGS = 5;

export function recoveryFindingText(f: RecoveryFinding): string {
  return `\`${f.tool}\` failed ${f.failures}x in a row with ${f.failedArgs}; `
    + `the first \`${f.tool}\` call that then ran clean was ${f.succeededArgs}`;
}

/** Returns false when the identical finding is inside the injection window. Turn-path callers must absorb throws. */
export function recordRecoveryFinding(
  sql: SqlExecutor, actor: ActorHandle, finding: RecoveryFinding, now?: number,
): boolean {
  const text = recoveryFindingText(finding);

  if (listRecoveryFindings(sql, actor).includes(text)) return false;
  recordLesson(sql, actor, {
    turnIds: [],
    text,
    source: 'execution_recovery',
    status: 'provisional',
    now,
  });

  return true;
}

/** Newest first. `lessons` is part of the workspace schema, so a failed read is a fault. */
export function listRecoveryFindings(
  sql: SqlExecutor, actor: ActorHandle, limit = MAX_RECOVERY_FINDINGS,
): string[] {
  return listLessons(sql, actor, { source: 'execution_recovery', limit }).map((lesson) => lesson.text);
}
