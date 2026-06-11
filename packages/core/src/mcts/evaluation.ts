/**
 * Multi-model evaluation pipeline — the replacement for naive LLM self-scoring.
 *
 * STATUS: available but NOT yet wired into the production MCTS path. Branch
 * scoring today is ExplorationAgent.evaluate (same-model self-rating on the
 * CF backend); R1 of the SOTA roadmap routes branch evaluation through this
 * pipeline instead. Covered by unit tests only.
 *
 * Architecture reference: final-architecture.md §5.6
 * Paper: LLM-as-Judge arXiv:2306.05685 — position/verbosity/self-enhancement bias
 *
 * Two layers:
 * 1. Execution-based scoring (ground truth for verifiable tasks, bypasses LLM)
 * 2. Cross-model judging (different model eliminates self-enhancement bias)
 */

import type { LLM, Executor } from '../types/primitives.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';

export async function evaluateWithMultiModelJudging(
  task: string,
  trajectory: string,
  executor: Executor,
  judgeModel: LLM | undefined,
  explorerModel: LLM,
): Promise<number> {
  // Layer 1: execution-based scoring (when task is verifiable)
  const execScore = await tryExecutionBasedScoring(executor, task, trajectory);
  if (execScore !== null) return execScore;

  // Layer 2: cross-model judging
  const judge = judgeModel ?? explorerModel;
  const prompt = buildJudgePrompt(task, trajectory);
  return scoreWithJudge(judge, prompt);
}

async function tryExecutionBasedScoring(
  executor: Executor,
  task: string,
  trajectory: string,
): Promise<number | null> {
  // Match common fence languages — JS/TS communities use `js` / `ts` far more
  // than the verbose forms, and Python rollouts often use `py`.
  const codeBlocks = [...trajectory.matchAll(
    /```(?:javascript|typescript|python|js|ts|py|tsx|jsx)?\n([\s\S]*?)\n```/g,
  )].map(m => m[1]!);

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

JSON shape:
{"score": <float 0.0-1.0>, "rationale": "<10 words max>"}
${jsonObjectOnlyInstruction()}`;
}

async function scoreWithJudge(judge: LLM, prompt: string): Promise<number> {
  const text = await judge.complete(prompt);
  try {
    const parsed = extractJsonObject(text) as { score?: unknown };
    const score = Number(parsed.score);
    if (!Number.isFinite(score)) return 0;
    return Math.min(1, Math.max(0, score));
  } catch {
    return 0;
  }
}
