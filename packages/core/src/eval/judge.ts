// Default LLM-judge implementation for the eval harness. Mirrors the
// auto-judge pattern (winner-of-two with rationale) but accepts any LLM that
// implements the StructuredJudgeFn shape from scaffold/auto-judge.
import { VerdictSchema, type JudgeFn, type Verdict } from './types.js';

/** A judge fn that calls a structured-output LLM via the AI SDK. */
export type LLMJudgeFn = (
  prompt: string,
  schema: typeof VerdictSchema,
) => Promise<Verdict>;

/** Default judge: builds a comparison prompt, calls the structured LLM,
 *  returns the Verdict. Caller supplies the structured-output adapter
 *  (typically generateObject from the AI SDK). */
export function createLLMJudge(llmJudge: LLMJudgeFn): JudgeFn {
  return async (caseInput, runA, runB) => {
    const prompt = `You are judging two AI strategies on the same task.

Task: ${caseInput.task}
${caseInput.rubric ? `\nRubric: ${caseInput.rubric}` : ''}
${caseInput.reference ? `\nReference answer (use as ground truth):\n${caseInput.reference.slice(0, 1500)}` : ''}

Strategy A (${runA.strategyId}) output:
${runA.error ? `ERROR: ${runA.error}` : runA.output.slice(0, 2000)}

Strategy B (${runB.strategyId}) output:
${runB.error ? `ERROR: ${runB.error}` : runB.output.slice(0, 2000)}

Score each strategy from 0.0 to 1.0 on task completion + correctness +
clarity. Pick the winner ('a', 'b', or 'tie' if scores are within 0.05).
Be terse — rationale should be under 30 words.`;
    return await llmJudge(prompt, VerdictSchema);
  };
}

// Re-export for callers
export { VerdictSchema, type Verdict };
