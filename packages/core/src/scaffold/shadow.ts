/**
 * Shadow-mode scaffold rollout.
 *
 * When the EvolutionEngine writes a new scaffold version via modifyScaffold,
 * we don't immediately switch the agent's loop to it. Instead, the new
 * version enters SHADOW MODE: for the next N turns, both the current and
 * the pending scaffold run in parallel (the user only sees the current's
 * output; the pending runs silently). A judge LLM compares per-turn quality.
 *
 * After enough trials (default N=5), we aggregate:
 *   - any decisive trial the pending LOSES beyond maxRegressions (default 0) →
 *     rollback (the hard regression veto — gates promotion regardless of win-rate)
 *   - else if ≥ minDecisiveTrials decisive trials and win-rate ≥ promoteThreshold
 *     (default 0.6) → promote
 *   - else (in between → keep observing, extend trial window)
 *
 * Schema:
 *   scaffold_evaluations         — one row per shadow turn
 *   scaffold_versions.status     — 'current' | 'pending' | 'rolled_back' | 'historical'
 *
 * Auto-promotion is off by default — agent shows the evaluation results in
 * memory + UI and the user manually promotes via the RPC. To enable
 * autopilot, set AgentConfig.scaffold.autoPromote = true.
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { RawSqlExec, SqlExecutor } from '../types/primitives.js';
import { nowMs } from '../utils/date.js';
import { nanoid } from '../utils/nanoid.js';

export type ScaffoldStatus = 'current' | 'pending' | 'rolled_back' | 'historical';

export interface ShadowEvaluationRow {
  id: string;
  current_version: number;
  pending_version: number;
  task: string;
  current_score: number | null;
  pending_score: number | null;
  winner: 'current' | 'pending' | 'tie' | null;
  judge_rationale: string | null;
  evaluated_at: number;
}

export interface PendingScaffold {
  version: number;
  writtenAt: number;
  rationale: string;
  trialsSoFar: number;
  pendingWins: number;
  currentWins: number;
  ties: number;
}

export interface JudgeFn {
  (opts: {
    task: string;
    currentOutput: string;
    pendingOutput: string;
  }): Promise<{
    winner: 'current' | 'pending' | 'tie';
    rationale: string;
    currentScore: number;
    pendingScore: number;
  }>;
}

export interface ShadowConfig {
  /** Required trials before promotion decision. Default 5. */
  minTrials: number;
  /** Win-rate fraction at which to promote pending. Default 0.6. */
  promoteThreshold: number;
  /** Win-rate fraction at which to rollback pending. Default 0.4. */
  rollbackThreshold: number;
  /** Hard ceiling on trials before forcing a decision. Default 12. */
  maxTrials: number;
  /** Auto-promote/rollback without user confirmation. Default false. */
  autoPromote: boolean;
  /** Max decisive trials the pending may LOSE before it's rolled back. 0 =
   *  any regression rolls it back (the safe default for auto-promotion). */
  maxRegressions: number;
  /** Minimum decisive (non-tie) trials required before a promote — guards
   *  against promoting on one lucky trial. Default 3. */
  minDecisiveTrials: number;
}

export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  minTrials: 5,
  promoteThreshold: 0.6,
  rollbackThreshold: 0.4,
  maxTrials: 12,
  autoPromote: false,
  maxRegressions: 0,
  minDecisiveTrials: 3,
};

export function initShadowTables(execRaw: RawSqlExec): void {
  // Add `status` column to scaffold_versions if missing.
  // (initScaffoldTables creates scaffold_versions with (version, written_at,
  //  rationale). We extend with status to drive shadow-mode rollout.)
  execRaw(`CREATE TABLE IF NOT EXISTS scaffold_evaluations (
    id TEXT PRIMARY KEY,
    current_version INTEGER NOT NULL,
    pending_version INTEGER NOT NULL,
    task TEXT NOT NULL,
    current_output TEXT,
    pending_output TEXT,
    current_score REAL,
    pending_score REAL,
    winner TEXT,
    judge_rationale TEXT,
    evaluated_at INTEGER NOT NULL
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_scaffold_eval_pending ON scaffold_evaluations(pending_version)`);
  // scaffold_versions.status is now created natively by initScaffoldTables
  // (in scaffold/schemas.ts); no ALTER fallback needed here.
}

/**
 * Look up the currently-pending scaffold version, or null if no rollout is
 * in flight. Pending is the version with status='pending' (we only allow
 * one in flight at a time).
 */
export function getPendingScaffold(sql: SqlExecutor): PendingScaffold | null {
  try {
    type Row = { version: number; written_at: number; rationale: string };
    const rows = sql<Row>`
      SELECT version, written_at, rationale FROM scaffold_versions
      WHERE status = 'pending'
      ORDER BY version DESC LIMIT 1`;
    if (rows.length === 0) return null;
    const r = rows[0];
    type CountRow = { winner: string | null; n: number };
    const counts = sql<CountRow>`
      SELECT winner, COUNT(*) AS n FROM scaffold_evaluations
      WHERE pending_version = ${r.version}
      GROUP BY winner`;
    let trials = 0, pendingWins = 0, currentWins = 0, ties = 0;
    for (const c of counts) {
      trials += c.n;
      if (c.winner === 'pending') pendingWins = c.n;
      else if (c.winner === 'current') currentWins = c.n;
      else if (c.winner === 'tie') ties = c.n;
    }
    return {
      version: r.version, writtenAt: r.written_at, rationale: r.rationale,
      trialsSoFar: trials, pendingWins, currentWins, ties,
    };
  } catch {
    return null;
  }
}

export interface ShadowVerdictTrial {
  id: string;
  task: string;
  currentScore: number | null;
  pendingScore: number | null;
  winner: 'current' | 'pending' | 'tie' | null;
  rationale: string | null;
  evaluatedAt: number;
}

export interface ShadowVerdict {
  version: number | null;
  trials: ShadowVerdictTrial[];
  summary: { trials: number; pendingWins: number; currentWins: number; ties: number; winRate: number };
}

/**
 * The per-trial shadow-eval verdict for a pending version — the data behind the
 * promote/rollback decision grid. Reads `scaffold_evaluations` (the table
 * shadow-mode actually populates), ordered regressions-first (current beat
 * pending → top) so the operator sees risk first. `winRate` is over decisive
 * (non-tie) trials. Returns an empty verdict when no pending version is given.
 */
export function readShadowVerdict(sql: SqlExecutor, version: number | null): ShadowVerdict {
  if (version == null) {
    return { version: null, trials: [], summary: { trials: 0, pendingWins: 0, currentWins: 0, ties: 0, winRate: 0 } };
  }
  type Row = {
    id: string; task: string; current_score: number | null; pending_score: number | null;
    winner: 'current' | 'pending' | 'tie' | null; judge_rationale: string | null; evaluated_at: number;
  };
  const rows = sql<Row>`
    SELECT id, task, current_score, pending_score, winner, judge_rationale, evaluated_at
    FROM scaffold_evaluations WHERE pending_version = ${version}
    ORDER BY CASE winner WHEN 'current' THEN 0 WHEN 'tie' THEN 1 ELSE 2 END, evaluated_at DESC`;
  let pendingWins = 0, currentWins = 0, ties = 0;
  for (const r of rows) {
    if (r.winner === 'pending') pendingWins++;
    else if (r.winner === 'current') currentWins++;
    else if (r.winner === 'tie') ties++;
  }
  const decisive = pendingWins + currentWins;
  return {
    version,
    trials: rows.map((r) => ({
      id: r.id, task: r.task,
      currentScore: r.current_score, pendingScore: r.pending_score,
      winner: r.winner, rationale: r.judge_rationale, evaluatedAt: r.evaluated_at,
    })),
    summary: { trials: rows.length, pendingWins, currentWins, ties, winRate: decisive === 0 ? 0 : pendingWins / decisive },
  };
}

/** Read the scaffold code for a specific version.
 *
 * Prefers the versioned backup file `scaffold/agent.js.v{N}` because it's the
 * canonical per-version source — the live `scaffold/agent.js` is just an
 * alias for whatever version currently has status='current'. Falls back to
 * the live file only when no versioned backup exists (cold-start v0). This
 * ordering matters: after `modifyScaffold` writes a pending v{N+1}, the live
 * file still holds the current's content, so `readScaffoldVersion(rt, N+1)`
 * MUST read the versioned file to recover the pending code (used by
 * `applyPromotionDecision('promote')` to swap the live file).
 */
export async function readScaffoldVersion(
  rt: AgentRuntime,
  version: number,
): Promise<string | null> {
  try {
    const content = await rt.storage.vfs.readFile(`scaffold/agent.js.v${version}`, { encoding: 'utf8' });
    return typeof content === 'string' ? content : new TextDecoder().decode(content);
  } catch {
    // No versioned backup — happens for v0 (the bootstrap writes the live
    // file but not a versioned backup). Fall back to live ONLY when the
    // requested version matches what `rt.identity.scaffold.version()` reports.
    try {
      if (version === (await rt.identity.scaffold.version())) {
        return await rt.identity.scaffold.read();
      }
    } catch { /* nop */ }
    return null;
  }
}

/**
 * Record one shadow-mode trial. Called by the orchestrator after running
 * both the current and pending scaffold for a given turn.
 */
export function recordShadowEvaluation(
  sql: SqlExecutor,
  args: {
    currentVersion: number;
    pendingVersion: number;
    task: string;
    currentOutput: string;
    pendingOutput: string;
    judgeResult: Awaited<ReturnType<JudgeFn>>;
  },
): ShadowEvaluationRow {
  const id = `eval-${nanoid()}`;
  const row: ShadowEvaluationRow = {
    id,
    current_version: args.currentVersion,
    pending_version: args.pendingVersion,
    task: args.task,
    current_score: args.judgeResult.currentScore,
    pending_score: args.judgeResult.pendingScore,
    winner: args.judgeResult.winner,
    judge_rationale: args.judgeResult.rationale,
    evaluated_at: nowMs(),
  };
  sql`INSERT INTO scaffold_evaluations
    (id, current_version, pending_version, task, current_output, pending_output,
     current_score, pending_score, winner, judge_rationale, evaluated_at)
    VALUES (${row.id}, ${row.current_version}, ${row.pending_version},
            ${row.task}, ${args.currentOutput}, ${args.pendingOutput},
            ${row.current_score}, ${row.pending_score},
            ${row.winner}, ${row.judge_rationale}, ${row.evaluated_at})`;
  return row;
}

/**
 * Decide whether to promote or rollback a pending scaffold based on the
 * accumulated trial results. Returns:
 *   { decision: 'promote' | 'rollback' | 'continue', winRate: number }
 */
export function decidePromotion(
  pending: PendingScaffold,
  config: ShadowConfig,
): { decision: 'promote' | 'rollback' | 'continue'; winRate: number } {
  const decisiveTrials = pending.pendingWins + pending.currentWins;
  if (decisiveTrials === 0) {
    return { decision: 'continue', winRate: 0.5 };
  }
  const winRate = pending.pendingWins / decisiveTrials;

  // Regression veto (hard, checked first): if the pending has LOST more decisive
  // trials than allowed, roll it back immediately. With maxRegressions=0 (the
  // safe default) a single loss is decisive — the owner's "auto-rollback on
  // regression". This gates promotion no matter how high the win-rate is.
  if (pending.currentWins > config.maxRegressions) {
    return { decision: 'rollback', winRate };
  }

  if (pending.trialsSoFar >= config.minTrials && decisiveTrials >= config.minDecisiveTrials) {
    if (winRate >= config.promoteThreshold) return { decision: 'promote', winRate };
    if (winRate <= config.rollbackThreshold) return { decision: 'rollback', winRate };
  }
  if (pending.trialsSoFar >= config.maxTrials) {
    // Hard ceiling. The regression veto already passed (currentWins ≤
    // maxRegressions), so promote iff genuinely ahead, else rollback.
    return { decision: winRate > 0.5 ? 'promote' : 'rollback', winRate };
  }
  return { decision: 'continue', winRate };
}

/**
 * Apply a promotion decision. For 'promote': the pending becomes current
 * and the previous current is archived. For 'rollback': the pending is
 * removed from disk and marked rolled_back; the agent's scaffold/agent.js
 * is restored from the version before the pending was written.
 *
 * Returns the new current version number.
 */
export async function applyPromotionDecision(
  rt: AgentRuntime,
  pending: PendingScaffold,
  decision: 'promote' | 'rollback',
): Promise<{ newCurrentVersion: number; action: 'promote' | 'rollback' }> {
  const sql = rt.storage.sql;
  if (decision === 'promote') {
    // Copy the pending version's code (versioned file written by
    // modifyScaffold gate 4) into the live `scaffold/agent.js`. The previous
    // current's content is already archived at `scaffold/agent.js.v{pending-1}`,
    // so rollback can recover.
    const pendingCode = await readScaffoldVersion(rt, pending.version);
    if (pendingCode == null) {
      throw new Error(`promote failed: no scaffold code found for v${pending.version}`);
    }
    await rt.identity.scaffold.write(pendingCode);
    sql`UPDATE scaffold_versions SET status = 'historical'
        WHERE status = 'current' AND version != ${pending.version}`;
    sql`UPDATE scaffold_versions SET status = 'current'
        WHERE version = ${pending.version}`;
    return { newCurrentVersion: pending.version, action: 'promote' };
  }
  // Rollback: the live `scaffold/agent.js` already holds the current version's
  // code (modifyScaffold no longer overwrites it on proposal), so flipping the
  // pending to rolled_back reverts the user-visible behaviour. Derive the
  // version to keep from the status='current' row — robust to non-contiguous
  // numbering (after rollback cycles the pending is NOT necessarily current+1).
  const currentRows = sql<{ version: number }>`
    SELECT version FROM scaffold_versions WHERE status = 'current' ORDER BY version DESC LIMIT 1`;
  const currentVersion = currentRows[0]?.version ?? (pending.version - 1);
  // Re-write the live file from the current version defensively, in case it
  // was tampered with mid-trial.
  const currentCode = await readScaffoldVersion(rt, currentVersion);
  if (currentCode != null) {
    await rt.identity.scaffold.write(currentCode);
  }
  sql`UPDATE scaffold_versions SET status = 'rolled_back'
      WHERE version = ${pending.version}`;
  return { newCurrentVersion: currentVersion, action: 'rollback' };
}
