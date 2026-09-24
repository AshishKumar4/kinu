/** The hard-task corpus and its seeding and verification, so prompts and verifier targets cannot drift. */
import type { VFS } from '@kinu.run/core';
import { outcomeRow, ratioOutcome, type VerifierContext } from '../eval-outcome';
import type { EvalScoreRow } from '../eval-run';
import type { HardTask } from './cost-model';

export * from './cost-model';

export { HARD_TASKS } from './tasks';

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
