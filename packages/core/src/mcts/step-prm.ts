// Process Reward Models (PRM) — step-level scoring.
//
// Standard MCTS scores the FINAL rollout. PRM-style judging scores each
// intermediate step, allowing the search to prune bad branches before
// spending the full rollout cost. Math-RL literature (Lightman 2024,
// ThinkPRM 2025, BiRM 2025) reports substantial efficiency gains.
//
// Proteus uses this in two places:
//  1. MCTS engine: blend step score into the UCT backprop alongside the
//     final-rollout score.
//  2. Scaffold runtime: per-step quality signal for early termination.
//
// The judge model receives (task, accumulated trajectory so far, current
// step's action+observation) and emits a [0..1] score with a short rationale.
import type { LLM } from '../types/primitives.js';

export interface StepScoreInput {
  task: string;
  /** Accumulated trajectory so far (prior steps), as a string. */
  priorTrajectory: string;
  /** This step's action + observation. */
  step: { action: string; observation: string };
}

export interface StepScore {
  /** [0..1] — how promising this step is for the overall task. */
  score: number;
  /** Short rationale, ≤20 words. */
  rationale: string;
}

const STEP_PROMPT = (i: StepScoreInput) => `You are scoring ONE STEP of a multi-step problem-solving agent.

Task: ${i.task}

Prior trajectory (steps already taken):
${i.priorTrajectory.slice(0, 2000)}

Current step:
- Action: ${i.step.action.slice(0, 800)}
- Observation: ${i.step.observation.slice(0, 1500)}

Rate THIS STEP from 0.0 to 1.0:
- 0.0 — step is wrong / off-track / will likely fail
- 0.5 — step is plausible but not clearly progress
- 1.0 — step is correct / clearly progresses toward task completion

Respond ONLY with this JSON. Do not explain.
{"score": <float 0..1>, "rationale": "<≤20 words>"}`;

/** Score a single MCTS step or scaffold action. Calls the judge LLM. */
export async function scoreStepWithJudge(judge: LLM, input: StepScoreInput): Promise<StepScore> {
  try {
    const text = await judge.complete(STEP_PROMPT(input));
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return { score: 0.5, rationale: 'unparseable' };
    const parsed = JSON.parse(m[0]) as { score?: number; rationale?: string };
    const score = Math.min(1, Math.max(0, Number(parsed.score ?? 0.5) || 0.5));
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
    return { score, rationale };
  } catch {
    return { score: 0.5, rationale: 'judge-error' };
  }
}

/** Blend a step score with the prior cumulative score using a discount factor.
 *  Standard discounted-reward pattern from RL: V_new = (1-γ) * step + γ * V_prior. */
export function blendStepScore(priorScore: number, stepScore: number, discount = 0.7): number {
  return (1 - discount) * stepScore + discount * priorScore;
}
