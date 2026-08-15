/**
 * Replay-eval harness — the system's measurable loss (audit R3 item 4).
 *
 * Samples stored outcome-labeled turns (turn_outcomes), re-runs each task
 * against the CURRENT config via the backend-supplied runner (cf: the live
 * scaffold rollout with the real tool surface; cli: the current prompt +
 * model), and scores the fresh response against the recorded outcome:
 *
 *   accepted  — the recorded response is a known-good reference; score
 *               whether the new response is at least as good (regression).
 *   corrected/frustrated — the recorded response failed and the user's
 *               follow-up says how; score whether the new response already
 *               addresses that correction (improvement).
 *
 * loss = 1 − mean(score), reported with the 95% interval around it (a mean of
 * a dozen judge verdicts is not a point). Persisted to `replay_evals` so the
 * curve is queryable over time (read-only RPC + agent.replayEvals helper).
 */

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec, LLM } from '../types/primitives.js';
import {
  isNegativeOutcome,
  listTurnOutcomes,
  TURN_OUTCOMES,
  type TurnOutcomeRow,
} from './outcomes.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window.js';
import { nanoid } from '../utils/nanoid.js';
import { nowMs } from '../utils/date.js';
import { parseJsonValue } from '../utils/json.js';
import { scoreInterval, wilsonInterval, type ScoreInterval } from '../utils/stats.js';

/**
 * Instances per replay pass. Each one costs a full re-run of a past task
 * against the live config plus a judge call — the dominant cost in the
 * lifetime-evolution cycle, so this is chosen against the width it buys.
 * 95% half-width at a mean of 0.5: ±0.31 at 6 (the interval covers most of
 * [0,1] — the number says nothing), ±0.20 at 20, ±0.14 at 48. 20 is where the
 * curve stops being noise, for a bit over 3× the cost; 48 would cost 2.4×
 * again to take a third off the width.
 */
export const DEFAULT_REPLAY_SAMPLE_SIZE = 20;

export function initReplayTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS replay_evals (
    id TEXT PRIMARY KEY,
    ran_at INTEGER NOT NULL,
    sample_size INTEGER NOT NULL,
    accepted_n INTEGER NOT NULL,
    negative_n INTEGER NOT NULL,
    mean_score REAL NOT NULL,
    loss REAL NOT NULL,
    scaffold_version INTEGER,
    details TEXT NOT NULL,
    score_lo REAL,
    score_hi REAL
  )`);
  // The record is the audit of what was reported, interval included, so the
  // bounds are stored rather than recomputed. Rows written before they
  // existed keep NULLs; listReplayEvals reconstructs those exactly from the
  // stored mean and sample size.
  try { execRaw(`ALTER TABLE replay_evals ADD COLUMN score_lo REAL`); } catch { /* exists */ }
  try { execRaw(`ALTER TABLE replay_evals ADD COLUMN score_hi REAL`); } catch { /* exists */ }
}

export interface ReplayInstanceResult {
  outcomeId: string;
  outcome: TurnOutcomeRow['outcome'];
  score: number;
  note: string;
}

export interface ReplayEvalSummary {
  id: string;
  ranAt: number;
  sampleSize: number;
  acceptedCount: number;
  negativeCount: number;
  meanScore: number;
  loss: number;
  /** 95% interval around `meanScore` (loss bounds are its complement — see
   *  `lossInterval`). Never read the mean without it. */
  interval: ScoreInterval;
  scaffoldVersion: number | null;
  results: ReplayInstanceResult[];
}

export interface RunReplayEvalOpts {
  sql: SqlExecutor;
  /** Judge LLM (rt.judgeModel ?? rt.llm). */
  judge: LLM;
  /** Re-run a task against the CURRENT config; returns the response text. */
  runTask: (task: string) => Promise<string>;
  sampleSize?: number;
  scaffoldVersion?: number | null;
  now?: number;
}

const ReplayJudgeSchema = v.object({
  score: v.number(),
  note: v.optional(v.string()),
});

const ReplayInstanceResultSchema: v.GenericSchema<ReplayInstanceResult> = v.object({
  outcomeId: v.string(),
  outcome: v.picklist(TURN_OUTCOMES),
  score: v.number(),
  note: v.string(),
});

function errorMessage(input: { error: unknown }): string {
  return input.error instanceof Error ? input.error.message : String(input.error);
}

function buildReplayJudgePrompt(row: TurnOutcomeRow, fresh: string): string {
  const head =
    `You are scoring a NEW response to a task the agent has answered before.\n\n` +
    `Task:\n${evidenceWindow(row.userMessage, EVIDENCE_BUDGETS.replayTask)}\n\n` +
    `New response:\n${evidenceWindow(fresh, EVIDENCE_BUDGETS.replayFreshResponse)}\n\n`;
  const tail =
    `\nJSON shape: {"score": <number 0..1>, "note": "<one sentence>"}\n` +
    jsonObjectOnlyInstruction();
  if (row.outcome === 'accepted') {
    return head +
      `The ORIGINAL response below was ACCEPTED by the user — it is a known-good reference. ` +
      `Score 1.0 when the new response is clearly at least as good, 0.0 when it is a regression.\n\n` +
      `Reference (accepted) response:\n${evidenceWindow(row.assistantResponse, EVIDENCE_BUDGETS.replayReferenceResponse)}\n` + tail;
  }
  return head +
    `The ORIGINAL response below FAILED — the user followed up with a correction. ` +
    `Score 1.0 when the new response already addresses what the user had to correct, ` +
    `0.0 when it repeats the original failure.\n\n` +
    `Original (failed) response:\n${evidenceWindow(row.assistantResponse, EVIDENCE_BUDGETS.replayFailedResponse)}\n\n` +
    `User's correction:\n${evidenceWindow(row.followup ?? '(no follow-up text recorded)', EVIDENCE_BUDGETS.replayCorrection)}\n` + tail;
}

async function judgeReplay(judge: LLM, row: TurnOutcomeRow, fresh: string): Promise<{ score: number; note: string }> {
  const raw = await judge.complete(buildReplayJudgePrompt(row, fresh));
  const parsed = v.safeParse(ReplayJudgeSchema, extractJsonObject(raw));
  if (!parsed.success || !Number.isFinite(parsed.output.score)) {
    throw new Error('replay judge returned no numeric score');
  }
  return {
    score: Math.min(1, Math.max(0, parsed.output.score)),
    note: parsed.output.note ?? '',
  };
}

/**
 * Run one replay-eval pass. Returns null when no outcome-labeled turns exist
 * yet (nothing to measure). A failed re-run or unusable judge verdict scores
 * the instance 0 — failing to reproduce a graded turn IS loss.
 */
export async function runReplayEval(opts: RunReplayEvalOpts): Promise<ReplayEvalSummary | null> {
  const size = Math.max(1, Math.floor(opts.sampleSize ?? DEFAULT_REPLAY_SAMPLE_SIZE));
  // Balanced sample, newest first: regressions guard (accepted) + the
  // failures the system should have learned from (corrected/frustrated).
  const negatives = listTurnOutcomes(opts.sql, { limit: Math.ceil(size / 2), outcomes: ['corrected', 'frustrated'] });
  const accepted = listTurnOutcomes(opts.sql, { limit: size - negatives.length, outcomes: ['accepted'] });
  const sample = [...negatives, ...accepted];
  if (sample.length === 0) return null;

  const results: ReplayInstanceResult[] = [];
  for (const row of sample) {
    let fresh: string;
    try {
      fresh = await opts.runTask(row.userMessage);
    } catch (err) {
      results.push({ outcomeId: row.id, outcome: row.outcome, score: 0, note: `re-run failed: ${errorMessage({ error: err })}` });
      continue;
    }
    try {
      const verdict = await judgeReplay(opts.judge, row, fresh);
      results.push({ outcomeId: row.id, outcome: row.outcome, ...verdict });
    } catch (err) {
      results.push({ outcomeId: row.id, outcome: row.outcome, score: 0, note: `judge failed: ${errorMessage({ error: err })}` });
    }
  }

  const interval = scoreInterval(results.map((r) => r.score));
  const summary: ReplayEvalSummary = {
    id: `rpl-${nanoid()}`,
    ranAt: opts.now ?? nowMs(),
    sampleSize: results.length,
    acceptedCount: results.filter((r) => r.outcome === 'accepted').length,
    negativeCount: results.filter((r) => isNegativeOutcome(r.outcome)).length,
    meanScore: interval.mean,
    loss: 1 - interval.mean,
    interval,
    scaffoldVersion: opts.scaffoldVersion ?? null,
    results,
  };

  void opts.sql`INSERT INTO replay_evals
      (id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version,
       details, score_lo, score_hi)
    VALUES
      (${summary.id}, ${summary.ranAt}, ${summary.sampleSize}, ${summary.acceptedCount},
       ${summary.negativeCount}, ${summary.meanScore}, ${summary.loss},
       ${summary.scaffoldVersion}, ${JSON.stringify(summary.results)},
       ${interval.lo}, ${interval.hi})`;
  return summary;
}

/** The persisted loss curve, newest first — what the UI could chart. */
export function listReplayEvals(sql: SqlExecutor, limit = 50): ReplayEvalSummary[] {
  try {
    const rows = sql<{
      id: string; ran_at: number; sample_size: number; accepted_n: number;
      negative_n: number; mean_score: number; loss: number;
      scaffold_version: number | null; details: string;
      score_lo: number | null; score_hi: number | null;
    }>`SELECT * FROM replay_evals ORDER BY ran_at DESC, id DESC LIMIT ${limit}`;
    return rows.map((r) => {
      let results: ReplayInstanceResult[] = [];
      try {
        const parsed = v.safeParse(v.array(ReplayInstanceResultSchema), parseJsonValue(r.details));
        if (parsed.success) results = parsed.output;
      } catch { /* malformed details — summary numbers still stand */ }
      // Pre-interval rows carry no bounds; mean and n determine them exactly.
      const interval: ScoreInterval = r.score_lo != null && r.score_hi != null
        ? { mean: r.mean_score, lo: r.score_lo, hi: r.score_hi, n: r.sample_size }
        : wilsonInterval(r.mean_score * r.sample_size, r.sample_size);
      return {
        id: r.id, ranAt: r.ran_at, sampleSize: r.sample_size,
        acceptedCount: r.accepted_n, negativeCount: r.negative_n,
        meanScore: r.mean_score, loss: r.loss, interval,
        scaffoldVersion: r.scaffold_version, results,
      };
    });
  } catch {
    return [];
  }
}
