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
 *   - if pending wins ≥ promoteThreshold (default 0.6 = 3/5 → promote)
 *   - else (default 0.4 = 2/5 → rollback)
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
}

export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  minTrials: 5,
  promoteThreshold: 0.6,
  rollbackThreshold: 0.4,
  maxTrials: 12,
  autoPromote: false,
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

  // Extend scaffold_versions with `status` if missing.
  try {
    // Probe — this may fail if scaffold_versions doesn't exist yet.
    execRaw(`ALTER TABLE scaffold_versions ADD COLUMN status TEXT DEFAULT 'current'`);
  } catch {
    // Either column already exists or table doesn't yet — bootstrap will
    // handle creation, and the next call after bootstrap will succeed on a
    // fresh schema (no-op if already present).
  }
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

/** Read the scaffold code for a specific version (from the versioned backup file). */
export async function readScaffoldVersion(
  rt: AgentRuntime,
  version: number,
): Promise<string | null> {
  try {
    if (version === (await rt.identity.scaffold.version())) {
      return await rt.identity.scaffold.read();
    }
    // Versioned backups live at scaffold/agent.js.v{N}
    const content = await rt.storage.vfs.readFile(`scaffold/agent.js.v${version}`, { encoding: 'utf8' });
    return typeof content === 'string' ? content : new TextDecoder().decode(content);
  } catch {
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
  if (pending.trialsSoFar >= config.minTrials) {
    if (winRate >= config.promoteThreshold) return { decision: 'promote', winRate };
    if (winRate <= config.rollbackThreshold) return { decision: 'rollback', winRate };
  }
  if (pending.trialsSoFar >= config.maxTrials) {
    // Force a decision — ties → rollback (safety bias).
    return { decision: winRate >= 0.5 ? 'promote' : 'rollback', winRate };
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
    // The pending version's code is already at scaffold/agent.js (it was
    // written by modifyScaffold's gate 4). Its predecessor was archived at
    // scaffold/agent.js.v{pending-1}. Just flip statuses.
    sql`UPDATE scaffold_versions SET status = 'historical'
        WHERE status = 'current' AND version != ${pending.version}`;
    sql`UPDATE scaffold_versions SET status = 'current'
        WHERE version = ${pending.version}`;
    return { newCurrentVersion: pending.version, action: 'promote' };
  }
  // Rollback: restore the previous version's code into scaffold/agent.js.
  const prevVersion = pending.version - 1;
  const prev = await readScaffoldVersion(rt, prevVersion);
  if (prev != null) {
    await rt.identity.scaffold.write(prev);
  }
  sql`UPDATE scaffold_versions SET status = 'rolled_back'
      WHERE version = ${pending.version}`;
  sql`UPDATE scaffold_versions SET status = 'current'
      WHERE version = ${prevVersion}`;
  return { newCurrentVersion: prevVersion, action: 'rollback' };
}
