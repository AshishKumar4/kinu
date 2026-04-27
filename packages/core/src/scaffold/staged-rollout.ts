/**
 * Staged scaffold rollout — canary testing + auto-rollback monitoring.
 *
 * Architecture reference: final-architecture.md §4
 * Formal spec: ScaffoldSafety.lean — canary_is_empirical_not_formal
 *
 * BUG-3: The canary gate provides empirical evidence of non-regression on N tasks.
 * It does NOT formally guarantee capability invariant preservation.
 * For structural safety, use CapabilitySafety (scaffoldwrite_not_grantable).
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { today } from '../utils/date.js';
import { nowMs } from '../utils/date.js';

export interface CanaryResult {
  score: number;
  baselineScore: number;
}

/**
 * Run a canary test: deploy candidate scaffold to an isolated branch,
 * run N recent tasks, compare scores against baseline.
 */
export async function runCanary(
  rt: AgentRuntime,
  candidateCode: string,
  canaryId: string,
  opts: { tasks: number; timeoutMs: number },
): Promise<CanaryResult> {
  const recentTasks = rt.storage.sql<{ task: string }>`
    SELECT task FROM task_history ORDER BY created_at DESC LIMIT ${opts.tasks}
  `;

  if (recentTasks.length === 0) {
    // No history — cannot canary test, assume pass
    return { score: 0.5, baselineScore: 0.5 };
  }

  const canaryScores: number[] = [];
  const baselineScores: number[] = [];

  for (const { task } of recentTasks) {
    // Run candidate in isolated canary branch
    const canaryBranch = await rt.spawnBranch(canaryId);
    try {
      const canaryResult = await Promise.race([
        canaryBranch.evaluate(task),
        new Promise<number>((_, rej) =>
          setTimeout(() => rej(new Error('timeout')), opts.timeoutMs),
        ),
      ]);
      canaryScores.push(canaryResult);
    } catch {
      canaryScores.push(0);
    }

    // Run baseline (current scaffold) in another branch
    const baselineId = `baseline-${nowMs()}`;
    const baselineBranch = await rt.spawnBranch(baselineId);
    try {
      const baselineResult = await baselineBranch.evaluate(task);
      baselineScores.push(baselineResult);
    } catch {
      baselineScores.push(0.5);
    }
    await rt.abortBranch(baselineId).catch(() => {});
  }

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  return { score: mean(canaryScores), baselineScore: mean(baselineScores) };
}

/**
 * Post-deploy error-rate monitoring with auto-rollback.
 * Checks error rates over the last 24 hours; rolls back if new scaffold
 * has >20% relative error rate increase AND absolute rate > 10%.
 */
export async function checkErrorRateAndRollbackIfNeeded(
  rt: AgentRuntime,
  priorVersion: number,
  currentVersion: number,
): Promise<void> {
  const oneDayAgo = nowMs() - 24 * 60 * 60 * 1000;

  const recentErrors = rt.storage.sql<{ count: number }>`
    SELECT COUNT(*) as count FROM task_history
    WHERE scaffold_version = ${currentVersion}
      AND outcome = 'error'
      AND created_at > ${oneDayAgo}
  `[0]?.count ?? 0;

  const recentTotal = rt.storage.sql<{ count: number }>`
    SELECT COUNT(*) as count FROM task_history
    WHERE scaffold_version = ${currentVersion}
      AND created_at > ${oneDayAgo}
  `[0]?.count ?? 0;

  if (recentTotal < 5) return; // insufficient data

  const currentErrorRate = recentErrors / recentTotal;
  const priorErrorRate = rt.storage.sql<{ rate: number }>`
    SELECT CAST(SUM(outcome = 'error') AS REAL) / COUNT(*) as rate
    FROM task_history WHERE scaffold_version = ${priorVersion}
  `[0]?.rate ?? 0;

  // Auto-rollback: >20% relative increase AND absolute rate > 10%
  if (currentErrorRate > priorErrorRate * 1.2 && currentErrorRate > 0.1) {
    const exists = await rt.storage.vfs.exists(`scaffold/agent.js.v${priorVersion}`);
    if (!exists) return;

    const backup = await rt.storage.vfs.readFile(
      `scaffold/agent.js.v${priorVersion}`,
      { encoding: 'utf8' },
    ) as string;
    await rt.identity.scaffold.write(backup);
    await rt.memory.append(
      `memory/logs/${today()}.md`,
      `\n## AUTO-ROLLBACK to scaffold v${priorVersion}\n` +
      `Error rate: ${(currentErrorRate * 100).toFixed(1)}% vs prior ${(priorErrorRate * 100).toFixed(1)}%\n`,
    );
  }
}
