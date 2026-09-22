import { VerdictSchema, type JudgeFn, type Verdict } from './types';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';

export type LLMJudgeFn = (
  prompt: string,
  schema: typeof VerdictSchema,
) => Promise<Verdict>;

/** Caller supplies the structured-output adapter (typically AI SDK generateObject). */
export function createLLMJudge(llmJudge: LLMJudgeFn): JudgeFn {
  return async (caseInput, runA, runB) => {
    const prompt = `You are judging two AI strategies on the same task.

Task: ${caseInput.task}
${caseInput.rubric ? `\nRubric: ${caseInput.rubric}` : ''}
${caseInput.reference ? `\nReference answer (use as ground truth):\n${evidenceWindow(caseInput.reference, EVIDENCE_BUDGETS.evalReference)}` : ''}

Strategy A (${runA.strategyId}) output:
${runA.error ? `ERROR: ${runA.error}` : evidenceWindow(runA.output, EVIDENCE_BUDGETS.evalOutput)}

Strategy B (${runB.strategyId}) output:
${runB.error ? `ERROR: ${runB.error}` : evidenceWindow(runB.output, EVIDENCE_BUDGETS.evalOutput)}

Score each strategy from 0.0 to 1.0 on task completion + correctness +
clarity. Pick the winner ('a', 'b', or 'tie' if scores are within 0.05).
Be terse — rationale should be under 30 words.`;

    return await llmJudge(prompt, VerdictSchema);
  };
}

export { VerdictSchema, type Verdict };
