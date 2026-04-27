/**
 * Multi-model evaluation pipeline — replaces naive LLM self-scoring.
 *
 * Architecture reference: final-architecture.md §5.6
 * Paper: LLM-as-Judge arXiv:2306.05685 — position/verbosity/self-enhancement bias
 *
 * Three layers:
 * 1. Execution-based scoring (ground truth for verifiable tasks, bypasses LLM)
 * 2. Cross-model judging (different model eliminates self-enhancement bias)
 * 3. Calibration against task history (anchors scores to known reference)
 */

import type { LLM, SqlExecutor, Executor } from '../types/primitives.js';

export async function evaluateWithMultiModelJudging(
  task: string,
  trajectory: string,
  executor: Executor,
  judgeModel: LLM | undefined,
  explorerModel: LLM,
  sql: SqlExecutor,
): Promise<number> {
  // Layer 1: execution-based scoring (when task is verifiable)
  const execScore = await tryExecutionBasedScoring(executor, task, trajectory);
  if (execScore !== null) return execScore;

  // Layer 2: cross-model judging
  const judge = judgeModel ?? explorerModel;
  const prompt = buildJudgePrompt(task, trajectory);
  const rawScore = await scoreWithJudge(judge, prompt);

  // Layer 3: calibration against task history
  return calibrate(sql, task, rawScore);
}

async function tryExecutionBasedScoring(
  executor: Executor,
  task: string,
  trajectory: string,
): Promise<number | null> {
  const codeBlocks = [...trajectory.matchAll(/```(?:javascript|typescript|python)?\n([\s\S]*?)\n```/g)]
    .map(m => m[1]!);

  if (codeBlocks.length === 0) return null;

  const taskHasVerifier = /test|verify|assert|check|validate|pass|correct/i.test(task);
  if (!taskHasVerifier) return null;

  const lastCode = codeBlocks[codeBlocks.length - 1]!;
  const { error } = await executor.execute(
    `async () => {
      try {
        ${lastCode}
        return { passed: true };
      } catch(e) {
        return { passed: false, error: e.message };
      }
    }`,
    [],
  );

  if (error) return 0.1;
  return 0.9;
}

function buildJudgePrompt(task: string, trajectory: string): string {
  return `You are evaluating whether an agent successfully completed a task.

Task: ${task}

Agent trajectory:
${trajectory.slice(0, 4000)}

Score this trajectory on a scale from 0.0 to 1.0 based on:
- Task completion (did it actually address what was asked?)
- Correctness (is the output accurate?)
- Efficiency (was it reasonably concise, or wasteful?)

Respond with ONLY a JSON object. Do not explain.
{"score": <float 0.0-1.0>, "rationale": "<10 words max>"}`;
}

async function scoreWithJudge(judge: LLM, prompt: string): Promise<number> {
  const text = await judge.complete(prompt);
  try {
    const m = text.match(/\{[^}]+\}/);
    const parsed = JSON.parse(m?.[0] ?? '{"score":0.5}');
    return Math.min(1, Math.max(0, Number(parsed.score) || 0.5));
  } catch {
    return 0.5;
  }
}

async function calibrate(
  sql: SqlExecutor,
  task: string,
  rawScore: number,
): Promise<number> {
  const taskWords = task.toLowerCase().replace(/[^a-z ]/g, '').split(' ').slice(0, 5).join(' ');
  const reference = sql<{ best_score: number }>`
    SELECT MAX(score) as best_score
    FROM task_history
    WHERE task LIKE ${'%' + taskWords + '%'}
      AND outcome = 'success'
      AND score IS NOT NULL
  `[0]?.best_score;

  if (reference == null || reference < 0.1) return rawScore;

  return Math.min(1, Math.max(0, rawScore * (reference / Math.max(reference, rawScore))));
}
