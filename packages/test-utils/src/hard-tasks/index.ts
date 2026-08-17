/**
 * The hard-task tier's seam into the eval instrument that already exists.
 *
 * WHAT THIS DELIBERATELY DOES NOT BUILD. No loader, no record schema, no
 * statistics, no second comparator. `EvalCase` already carries `env` (an opaque
 * key the tier resolves to a seeder) and `params`, and both had ZERO consumers
 * until now — they were landed for exactly this. `outcomeRow` already projects a
 * verdict onto the row that persistence, the paired comparator and admissibility
 * all read. So this module is three things and nothing else: a lookup, a seeding
 * step, and a verification step.
 *
 * WHY THE CASES ARE DERIVED AND NOT A JSONL FILE. Every prompt quotes the target
 * its verifier scores against. Split across `behaviour.jsonl` and a `.ts` those two
 * numbers would drift, and a prompt promising a target the scorer does not use is a
 * silently mis-stated task that would look like an agent failure. Deriving the
 * cases from {@link HARD_TASKS} makes the drift impossible rather than merely
 * unlikely, and it is why `hardTaskCases` returns cases instead of being a file.
 */
import type { EvalCase, VFS } from '@proteus/core';
import { outcomeRow, ratioOutcome, type VerifierContext } from '../eval-outcome.js';
import type { EvalScoreRow } from '../eval-run.js';
import type { HardTask } from './cost-model.js';
import { HARD_TASKS } from './tasks.js';

export * from './cost-model.js';
export { HARD_TASKS } from './tasks.js';

/**
 * The `EvalCase.env` value that marks a case as belonging to this tier.
 *
 * One constant, not one per task: `env` names the ENVIRONMENT — what has to be put
 * in the workspace and what will be run over it afterwards — and the task's own
 * `id` already identifies which instance. A per-task env key would be the id
 * spelled twice, with two places for it to disagree.
 */
export const HARD_TASK_ENV = 'hard-task';

/**
 * The corpus as eval cases, ready to concatenate with any other corpus.
 *
 * `rubric` and `reference` are deliberately absent: this tier's ground truth is
 * code, and a rubric is the affordance a judge reads. Leaving them unset is what
 * makes "no LLM judge" a property of the data rather than a promise in a comment.
 */
export function hardTaskCases(): EvalCase[] {
  return HARD_TASKS.map((task) => ({
    id: task.id,
    task: task.prompt,
    tags: [...task.tags],
    env: HARD_TASK_ENV,
    // The instance size, so a record says what was actually solved. A stored score
    // whose instance is not recorded beside it is a score nobody can re-derive.
    params: { ...task.problem.params },
  }));
}

/** The task behind a case, or undefined when the case belongs to another tier.
 *  Callers must handle the undefined rather than being handed a throw: a mixed
 *  corpus is the normal state, not an error. */
export function hardTaskFor(task: Pick<EvalCase, 'id' | 'env'>): HardTask | undefined {
  if (task.env !== HARD_TASK_ENV) return undefined;
  return HARD_TASKS.find((t) => t.id === task.id);
}

/**
 * Put the task's files in the workspace the agent is about to be handed.
 *
 * Separate from verification because the two happen either side of a paid episode,
 * and because seeding through the OPENED runtime's VFS is the whole point: a task
 * seeded into the birth runtime's inline VFS is a task the agent never sees.
 */
export async function seedHardTask(task: HardTask, vfs: VFS): Promise<void> {
  for (const file of task.seed) await vfs.writeFile(file.path, file.content);
}

/**
 * Measure the workspace the agent left behind and project the verdict onto the one
 * primary-metric row.
 *
 * THROWS when the measurement harness could not run at all, which is the
 * instrument being broken and must be a red run that publishes no number. A
 * solution that is missing, unparseable, throwing, over budget, below its
 * problem's certificate floor or simply wrong comes back as a scored zero with a
 * detail that says which — because "the agent failed" and "we failed to measure"
 * are different facts.
 */
export async function verifyHardTask(
  task: HardTask, ctx: VerifierContext,
): Promise<EvalScoreRow> {
  const scored = await task.verify(ctx);
  return outcomeRow(ratioOutcome(scored.score, scored.detail, scored.measured));
}
