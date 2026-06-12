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
 * loss = 1 − mean(score). Persisted to `replay_evals` so the curve is
 * queryable over time (read-only RPC + agent.replayEvals helper).
 */

import type { SqlExecutor, RawSqlExec, LLM } from '../types/primitives.js';
import { listTurnOutcomes, type TurnOutcomeRow } from './outcomes.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import { nanoid } from '../utils/nanoid.js';
import { nowMs } from '../utils/date.js';

export const DEFAULT_REPLAY_SAMPLE_SIZE = 6;

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
    details TEXT NOT NULL
  )`);
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

function buildReplayJudgePrompt(row: TurnOutcomeRow, fresh: string): string {
  const head =
    `You are scoring a NEW response to a task the agent has answered before.\n\n` +
    `Task:\n${row.userMessage.slice(0, 1500)}\n\n` +
    `New response:\n${fresh.slice(0, 3000)}\n\n`;
  const tail =
    `\nJSON shape: {"score": <number 0..1>, "note": "<one sentence>"}\n` +
    jsonObjectOnlyInstruction();
  if (row.outcome === 'accepted') {
    return head +
      `The ORIGINAL response below was ACCEPTED by the user — it is a known-good reference. ` +
      `Score 1.0 when the new response is clearly at least as good, 0.0 when it is a regression.\n\n` +
      `Reference (accepted) response:\n${row.assistantResponse.slice(0, 3000)}\n` + tail;
  }
  return head +
    `The ORIGINAL response below FAILED — the user followed up with a correction. ` +
    `Score 1.0 when the new response already addresses what the user had to correct, ` +
    `0.0 when it repeats the original failure.\n\n` +
    `Original (failed) response:\n${row.assistantResponse.slice(0, 2000)}\n\n` +
    `User's correction:\n${(row.followup ?? '(no follow-up text recorded)').slice(0, 1000)}\n` + tail;
}

async function judgeReplay(judge: LLM, row: TurnOutcomeRow, fresh: string): Promise<{ score: number; note: string }> {
  const raw = await judge.complete(buildReplayJudgePrompt(row, fresh));
  const parsed = extractJsonObject(raw) as { score?: unknown; note?: unknown };
  if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score)) {
    throw new Error('replay judge returned no numeric score');
  }
  return {
    score: Math.min(1, Math.max(0, parsed.score)),
    note: typeof parsed.note === 'string' ? parsed.note : '',
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
      results.push({ outcomeId: row.id, outcome: row.outcome, score: 0, note: `re-run failed: ${(err as Error).message}` });
      continue;
    }
    try {
      const verdict = await judgeReplay(opts.judge, row, fresh);
      results.push({ outcomeId: row.id, outcome: row.outcome, ...verdict });
    } catch (err) {
      results.push({ outcomeId: row.id, outcome: row.outcome, score: 0, note: `judge failed: ${(err as Error).message}` });
    }
  }

  const meanScore = results.reduce((acc, r) => acc + r.score, 0) / results.length;
  const summary: ReplayEvalSummary = {
    id: `rpl-${nanoid()}`,
    ranAt: opts.now ?? nowMs(),
    sampleSize: results.length,
    acceptedCount: results.filter((r) => r.outcome === 'accepted').length,
    negativeCount: results.filter((r) => r.outcome === 'corrected' || r.outcome === 'frustrated').length,
    meanScore,
    loss: 1 - meanScore,
    scaffoldVersion: opts.scaffoldVersion ?? null,
    results,
  };

  opts.sql`INSERT INTO replay_evals
      (id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version, details)
    VALUES
      (${summary.id}, ${summary.ranAt}, ${summary.sampleSize}, ${summary.acceptedCount},
       ${summary.negativeCount}, ${summary.meanScore}, ${summary.loss},
       ${summary.scaffoldVersion}, ${JSON.stringify(summary.results)})`;
  return summary;
}

/** The persisted loss curve, newest first — what the UI could chart. */
export function listReplayEvals(sql: SqlExecutor, limit = 50): ReplayEvalSummary[] {
  try {
    const rows = sql<{
      id: string; ran_at: number; sample_size: number; accepted_n: number;
      negative_n: number; mean_score: number; loss: number;
      scaffold_version: number | null; details: string;
    }>`SELECT * FROM replay_evals ORDER BY ran_at DESC, id DESC LIMIT ${limit}`;
    return rows.map((r) => {
      let results: ReplayInstanceResult[] = [];
      try {
        const parsed = JSON.parse(r.details) as unknown;
        if (Array.isArray(parsed)) results = parsed as ReplayInstanceResult[];
      } catch { /* malformed details — summary numbers still stand */ }
      return {
        id: r.id, ranAt: r.ran_at, sampleSize: r.sample_size,
        acceptedCount: r.accepted_n, negativeCount: r.negative_n,
        meanScore: r.mean_score, loss: r.loss,
        scaffoldVersion: r.scaffold_version, results,
      };
    });
  } catch {
    return [];
  }
}
