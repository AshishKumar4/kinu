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
 *   - any decisive trial the pending LOSES beyond maxRegressions (default 1) →
 *     rollback (the hard regression veto — gates promotion regardless of win-rate)
 *   - else if ≥ minDecisiveTrials decisive trials and win-rate ≥ promoteThreshold
 *     (default 0.6) → promote
 *   - else (in between → keep observing, extend trial window)
 *
 * A trial is EXPENSIVE — a whole candidate turn plus two judge calls — so it
 * never runs on the turn that sampled it. The turn writes one row into
 * `scaffold_trial_queue` and returns; the cadence lane runs the queue later
 * (evolution/control.ts `runQueuedShadowTrials`). A queued trial is evidence
 * that does not exist yet: it is deliberately in its own table, because
 * counting it in `scaffold_evaluations` would inflate `trialsSoFar` and walk
 * the calibrated ladder below on trials nobody ran.
 *
 * Schema:
 *   scaffold_evaluations         — one row per EXECUTED trial
 *   scaffold_trial_queue         — one row per trial awaiting execution
 *   scaffold_versions.status     — 'current' | 'pending' | 'rolled_back' | 'historical'
 *
 * Auto-promotion is ON by default at the agent level (agent_config
 * auto_promote_scaffold, config/store.ts): the misevolution gate + shadow
 * veto + archive are the safety net, and every promotion lands in the
 * Evolution Changelog where the operator can revert it. Set the key to
 * 'false' to require manual promotion via the RPC instead.
 */

import type { ModelMessage } from 'ai';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { RawSqlExec, SqlExecutor } from '../types/primitives.js';
import { nowMs } from '../utils/date.js';
import { nanoid } from '../utils/nanoid.js';
import { checkMisevolution, recordMisevolutionVeto } from './misevolution.js';

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

/** One trial's verdict, in the current-vs-pending terms `decidePromotion` and
 *  `scaffold_evaluations` consume. How a judge arrives at it (single call,
 *  order-swapped double call — see scaffold/auto-judge.ts) is its own business;
 *  this is the contract the promotion rule is calibrated against. */
export interface ShadowTrialVerdict {
  winner: 'current' | 'pending' | 'tie';
  rationale: string;
  currentScore: number;
  pendingScore: number;
}

export interface JudgeFn {
  (opts: {
    task: string;
    currentOutput: string;
    pendingOutput: string;
  }): Promise<ShadowTrialVerdict>;
}

export interface ShadowConfig {
  /** Required trials before promotion decision. Default 5. */
  minTrials: number;
  /** Win-rate fraction at which to promote pending. Default 0.6. */
  promoteThreshold: number;
  /** Win-rate fraction at which to rollback pending. Default 0.4. */
  rollbackThreshold: number;
  /** Hard ceiling on trials before forcing a decision. Default 20 — a budget
   *  sized to the DECISIVE yield of the order-swapped judge, not to raw turns
   *  (see DEFAULT_SHADOW_CONFIG). */
  maxTrials: number;
  /** Auto-promote/rollback without user confirmation. Default false. */
  autoPromote: boolean;
  /** Max decisive trials the pending may LOSE before it's rolled back.
   *  0 = any regression rolls it back — Monte-Carlo-shown to reject most
   *  genuinely-better variants under judge noise (see DEFAULT_SHADOW_CONFIG). */
  maxRegressions: number;
  /** Minimum decisive (non-tie) trials required before a promote — guards
   *  against promoting on one lucky trial. Default 5. */
  minDecisiveTrials: number;
}

/**
 * Defaults settled by binomial Monte Carlo (scripts/shadow-veto-monte-carlo.ts,
 * 200k sims/cell over the REAL decidePromotion, sequential per-trial stopping
 * exactly as runAutoShadowEval applies it — rerun the script to reproduce).
 *
 * The bar: false-promotion of CLEARLY-worse variants (true win ≤ 0.30) under
 * 5% at tie rates ≤ 0.5, maximizing mean true-promotion. Worlds sweep win-rates
 * {.55,.6,.7,.8} × per-call tie-rates {.3,.5,.7}, "worse" = the 1-win mirror,
 * judged by the order-swapped double-win protocol at 10pp of residual bias.
 *
 * maxTrials — 12 → 20. This is a budget in trials, but only DECISIVE trials
 * carry information, and the order-swapped double-win judge (scaffold/
 * auto-judge.ts) roughly halves the decisive yield per turn: at the flagship
 * world the recorded tie rate goes 50% → 73%. A budget of 12 then runs out
 * while only two or three decisive trials are in, and the ceiling's forced
 * decision — which promotes on a bare >0.5 majority and does NOT consult
 * minDecisiveTrials — starts deciding most rollouts. That is the leak this
 * comment used to file as "residual and not config-fixable"; it is fixable, by
 * denominating the budget correctly. Sweeping it at (maxReg 1, minDec 5):
 *
 *   maxTrials | mean P(promote better) | worst P(promote worse≤0.3,tie≤0.5)
 *          12 |        65.6%           |   7.9%   ← misses the bar
 *          16 |        63.7%           |   5.2%
 *          20 |        62.3%           |   3.2%   ← CHOSEN
 *          24 |        61.3%           |   2.1%
 *          40 |        59.0%           |   1.0%
 *
 * maxRegressions / minDecisiveTrials — unchanged at (1, 5), which the sweep
 * re-derives as the frontier at the rescaled budget. maxRegressions=0 ("one
 * loss = rollback") remains the statistically indefensible setting: a
 * genuinely-better scaffold almost always loses SOME decisive trial under
 * judge noise before accumulating a promotable record.
 *
 *   maxReg minDec | mean P(promote better) | worst P(promote worse≤0.3,tie≤0.5)
 *        0      3 |        44.2%           |   1.5%
 *        0      5 |        34.6%           |   0.8%
 *        1      3 |        75.6%           |  12.2%
 *        1      5 |        62.3%           |   3.2%   ← CHOSEN
 *        2      3 |        76.1%           |  12.5%
 *        2      5 |        76.6%           |   7.7%
 *
 * The resulting operating point strictly dominates the original calibration on
 * BOTH axes (which scored 50.9% / 4.9% for an unbiased single-call judge, and
 * 34.9% / 1.5% for the position-biased one production actually ran — the bias
 * was suppressing true and false promotion alike).
 *
 * A strict <5% bar against ALL worse worlds (incl. the 45% near-coin-flip
 * mirror) stays unattainable in principle at any budget this side of hundreds
 * of decisive trials — and near-coin-flip promotions are low-harm and
 * revertable from the Evolution Changelog.
 */
export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  minTrials: 5,
  promoteThreshold: 0.6,
  rollbackThreshold: 0.4,
  maxTrials: 20,
  autoPromote: false,
  maxRegressions: 1,
  minDecisiveTrials: 5,
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
  execRaw(`CREATE TABLE IF NOT EXISTS scaffold_trial_queue (
    id TEXT PRIMARY KEY,
    pending_version INTEGER NOT NULL,
    task TEXT NOT NULL,
    current_output TEXT NOT NULL,
    context TEXT NOT NULL,
    queued_at INTEGER NOT NULL
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_scaffold_trial_queue_pending ON scaffold_trial_queue(pending_version)`);
  // scaffold_versions.status is now created natively by initScaffoldTables
  // (in scaffold/schemas.ts); no ALTER fallback needed here.
}

// ── The trial queue: what a turn contributes, before anything runs ──────────

/** A trial the turn sampled and nothing has executed yet. */
export interface QueuedShadowTrial {
  readonly id: string;
  readonly pendingVersion: number;
  /** The user's task, WHOLE — the candidate answers the same question the live
   *  turn answered, and the evidence budget is applied once, at judging time. */
  readonly task: string;
  /** What the live turn actually answered — the trial's comparand. */
  readonly currentOutput: string;
  /** The conversation as the live turn's inference saw it, replayed as the
   *  candidate's `host.defaultInference`. Without it a delegating candidate
   *  answers a context-dependent task from the task text alone and loses trials
   *  it should tie — the structural handicap the shadow-parity fix removed, and
   *  the only part of the live turn an offline trial cannot re-derive. Empty
   *  when the host held none; the surface's own default loop stands in. */
  readonly context: readonly ModelMessage[];
  readonly queuedAt: number;
}

/**
 * Queued trials one pending version may accumulate.
 *
 * The queue only buffers between cadence passes, so depth is normally 1-2. The
 * ceiling exists for the host that never drains — a one-shot `proteus exec`
 * process, which by the evolution exit contract starts no cadence work at all
 * — and is set at the trial ceiling itself: past `maxTrials` there is already
 * more queued work than the gate below can consume.
 */
export const MAX_QUEUED_SHADOW_TRIALS = DEFAULT_SHADOW_CONFIG.maxTrials;

/**
 * Characters of serialized turn context one queued trial carries.
 *
 * A live replay held the whole prepared message list in memory; a queued one
 * has to store it, and a workspace can hold {@link MAX_QUEUED_SHADOW_TRIALS}
 * of them at once. The budget keeps the TAIL — a trial's own task is the last
 * message, and what a context-dependent task needs is what was said near it —
 * and is bounded well inside a single SQLite row.
 */
export const SHADOW_TRIAL_CONTEXT_CHARS = 64_000;

/**
 * The tail of `messages` that fits the context budget, starting at a user
 * message. Trimming mid-exchange would leave a tool result whose call is gone,
 * which providers reject outright — a replay that 400s is worth less than a
 * shorter one.
 */
function trimTrialContext(messages: readonly ModelMessage[]): ModelMessage[] {
  const kept: ModelMessage[] = [];
  let spent = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = JSON.stringify(messages[i]).length;
    if (spent + size > SHADOW_TRIAL_CONTEXT_CHARS && kept.length > 0) break;
    spent += size;
    kept.unshift(messages[i]);
  }
  while (kept.length > 0 && kept[0].role !== 'user') kept.shift();
  return kept;
}

/**
 * Record one trial for later execution. Returns what happened, so the caller
 * can report an honest reason rather than a silent no-op.
 */
export function queueShadowTrial(
  sql: SqlExecutor,
  args: {
    pendingVersion: number;
    task: string;
    currentOutput: string;
    context: readonly ModelMessage[];
    now?: number;
  },
): 'queued' | 'queue_full' {
  if (countQueuedShadowTrials(sql, args.pendingVersion) >= MAX_QUEUED_SHADOW_TRIALS) return 'queue_full';
  sql`INSERT INTO scaffold_trial_queue (id, pending_version, task, current_output, context, queued_at)
      VALUES (${`trial-${nanoid()}`}, ${args.pendingVersion}, ${args.task}, ${args.currentOutput},
              ${JSON.stringify(trimTrialContext(args.context))}, ${args.now ?? nowMs()})`;
  return 'queued';
}

/** Trials awaiting execution for a version, oldest first. */
export function listQueuedShadowTrials(sql: SqlExecutor, pendingVersion: number): QueuedShadowTrial[] {
  type Row = {
    id: string; pending_version: number; task: string; current_output: string;
    context: string; queued_at: number;
  };
  const rows = sql<Row>`
    SELECT id, pending_version, task, current_output, context, queued_at
    FROM scaffold_trial_queue WHERE pending_version = ${pendingVersion}
    ORDER BY queued_at ASC`;
  return rows.map((r) => ({
    id: r.id,
    pendingVersion: r.pending_version,
    task: r.task,
    currentOutput: r.current_output,
    context: parseTrialContext(r.context),
    queuedAt: r.queued_at,
  }));
}

/** A context row that cannot be read back is a replay we no longer have, not a
 *  trial we should refuse to run: the candidate falls back to the surface's own
 *  default loop, exactly as it does for a host that held no context. */
function parseTrialContext(raw: string): ModelMessage[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ModelMessage[] : [];
  } catch {
    return [];
  }
}

/** How many trials are queued but not yet run — the evidence a pending version
 *  is owed and does not have. */
export function countQueuedShadowTrials(sql: SqlExecutor, pendingVersion: number): number {
  const rows = sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM scaffold_trial_queue WHERE pending_version = ${pendingVersion}`;
  return rows[0]?.n ?? 0;
}

/** Trial executed (or thrown away) — the queue row's job is done. */
export function dropQueuedShadowTrial(sql: SqlExecutor, id: string): void {
  sql`DELETE FROM scaffold_trial_queue WHERE id = ${id}`;
}

/** Discard every queued trial that is not for `keepVersion`. A trial is
 *  evidence about ONE candidate: once that candidate is promoted or rolled
 *  back, running it would score a version no longer under trial. Pass null to
 *  clear the queue entirely. */
export function purgeQueuedShadowTrials(sql: SqlExecutor, keepVersion: number | null): void {
  if (keepVersion === null) sql`DELETE FROM scaffold_trial_queue`;
  else sql`DELETE FROM scaffold_trial_queue WHERE pending_version != ${keepVersion}`;
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

/**
 * The LIVE scaffold version — the highest status='current' row. Derived from
 * status, never from arithmetic on the pending version: after rollback
 * cycles the numbering is non-contiguous (e.g. current=v2 while pending=v5),
 * so `pending - 1` points at a rolled_back/historical row.
 */
export function getCurrentScaffoldVersion(sql: SqlExecutor): number | null {
  try {
    const rows = sql<{ version: number }>`
      SELECT version FROM scaffold_versions WHERE status = 'current' ORDER BY version DESC LIMIT 1`;
    return rows[0]?.version ?? null;
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
    judgeResult: ShadowTrialVerdict;
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
    // All ties so far carries no signal in either direction — keep observing,
    // even past maxTrials. The ceiling below is NOT a guaranteed stopping
    // point; a run of pure ties legitimately extends the window.
    return { decision: 'continue', winRate: 0.5 };
  }
  const winRate = pending.pendingWins / decisiveTrials;

  // Regression veto (hard, checked first): if the pending has LOST more decisive
  // trials than allowed, roll it back immediately. This gates promotion no
  // matter how high the win-rate is. maxRegressions default is 1 — Monte-Carlo
  // settled (see DEFAULT_SHADOW_CONFIG): 0 rejected most genuinely-better
  // variants because judge noise makes some decisive loss near-certain.
  if (pending.currentWins > config.maxRegressions) {
    return { decision: 'rollback', winRate };
  }

  if (pending.trialsSoFar >= config.minTrials && decisiveTrials >= config.minDecisiveTrials) {
    if (winRate >= config.promoteThreshold) return { decision: 'promote', winRate };
    if (winRate <= config.rollbackThreshold) return { decision: 'rollback', winRate };
  }
  if (pending.trialsSoFar >= config.maxTrials) {
    // Hard ceiling. The regression veto already passed (currentWins ≤
    // maxRegressions), so promote iff genuinely ahead, else rollback. This
    // branch deliberately does NOT re-check minDecisiveTrials — it is the
    // forced decision — which is why maxTrials is sized against the judge's
    // decisive YIELD rather than raw turns (see DEFAULT_SHADOW_CONFIG).
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
 * Returns the new current version and the action ACTUALLY applied: a
 * 'promote' request is converted to 'rollback' (with `vetoReason` set) when
 * the on-disk pending code fails the fixed misevolution criteria — the
 * version file lives in the agent-writable VFS, so promotion must re-check
 * what acceptance checked. Callers must report `action`, not their request.
 */
export async function applyPromotionDecision(
  rt: AgentRuntime,
  pending: PendingScaffold,
  decision: 'promote' | 'rollback',
): Promise<{ newCurrentVersion: number; action: 'promote' | 'rollback'; vetoReason?: string }> {
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
    const misevolution = checkMisevolution(pendingCode);
    if (!misevolution.ok) {
      recordMisevolutionVeto(sql, {
        surface: 'scaffold', violation: misevolution,
        detail: `promotion of v${pending.version} vetoed; rolled back instead`,
      });
      const result = await applyPromotionDecision(rt, pending, 'rollback');
      return { ...result, vetoReason: `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}` };
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
  // pending to rolled_back reverts the user-visible behaviour.
  const currentVersion = getCurrentScaffoldVersion(sql) ?? (pending.version - 1);
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
