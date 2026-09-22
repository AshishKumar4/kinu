/** The hard-task tier's seam into the eval instrument: lookup, seeding, verification. Cases derive from {@link HARD_TASKS} so prompts and verifier targets cannot drift. */
import type { EvalBudget, EvalCase, VFS } from '@kinu.run/core';
import { outcomeRow, ratioOutcome, type VerifierContext } from '../eval-outcome';
import type { EvalScoreRow } from '../eval-run';
import type { HardTask } from './cost-model';
import { HARD_TASKS } from './tasks';

export * from './cost-model';

export { HARD_TASKS } from './tasks';

/** The `EvalCase.env` marking this tier; the task `id` identifies the instance. */
export const HARD_TASK_ENV = 'hard-task';

/** Per-task spend ceilings, sized to catch runaway episodes, not rank efficiency; a fired ceiling is a finding, not a red. */
export const HARD_TASK_BUDGET: EvalBudget = {
  steps: 120,
  tokens: 1_000_000,
  toolErrorRate: 0.6,
  wallMs: 1_800_000,
};

/** The corpus as eval cases; `rubric`/`reference` are absent because ground truth is code. */
export function hardTaskCases(): EvalCase[] {
  return HARD_TASKS.map((task) => ({
    id: task.id,
    task: task.prompt,
    tags: [...task.tags],
    env: HARD_TASK_ENV,
    // The instance size, so a stored score can be re-derived.
    params: { ...task.problem.params },
    budget: { ...HARD_TASK_BUDGET },
  }));
}

/** The task behind a case, or undefined for cases of other tiers. */
export function hardTaskFor(task: Pick<EvalCase, 'id' | 'env'>): HardTask | undefined {
  if (task.env !== HARD_TASK_ENV) return undefined;

  return HARD_TASKS.find((t) => t.id === task.id);
}

/** Seed the task's files through the opened runtime's VFS (the birth runtime's inline VFS is never seen by the agent). */
export async function seedHardTask(task: HardTask, vfs: VFS): Promise<void> {
  for (const file of task.seed) await vfs.writeFile(file.path, file.content);
}

/** Score the workspace; throws only when measurement itself fails, otherwise wrong solutions score zero with a detail. */
export async function verifyHardTask(
  task: HardTask, ctx: VerifierContext,
): Promise<EvalScoreRow> {
  const scored = await task.verify(ctx);

  return outcomeRow(ratioOutcome(scored.score, scored.detail, scored.measured));
}
