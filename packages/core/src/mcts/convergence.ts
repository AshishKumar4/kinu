/**
 * MCTS convergence — committing the winning branch.
 *
 *
 * BUG-4: When winner.value < MIN_ACCEPTABLE_SCORE, converge() returns
 * { converged: false }. The architecture doc does NOT specify what happens next
 * (no retry policy, no fallback). This is a documented behavioral underspecification.
 */

import type { SqlExecutor, LLM } from '../types/primitives.js';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { SearchNode } from '../types/mcts.js';
import type { ConvergenceResult } from '../types/evaluation.js';
import type { SessionWriter } from './record-node.js';
import { maybeStoreCraftedTool } from '../craft/discovery.js';
import { captureAlternateTakes } from './takes.js';
import { selectWinnerByTest } from './test-selection.js';
import { DEFAULT_CONFIG } from '../config.js';
import { isoDate } from '../utils/date.js';

export async function converge(
  rt: AgentRuntime,
  session: SessionWriter,
  rootId: string,
  minAcceptable: number = DEFAULT_CONFIG.mcts.minAcceptableScore,
  takesEpsilon: number = DEFAULT_CONFIG.mcts.takesEpsilon,
): Promise<ConvergenceResult> {
  const population = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes
    WHERE root_id = ${rootId} AND status IN ('terminal', 'open')
    ORDER BY value DESC, depth DESC`;
  const argmaxWinner = population[0];

  if (!argmaxWinner) {
    throw new Error('No viable nodes — all branches failed or were pruned');
  }

  // DO-NOW #3: when the top candidates are within takesEpsilon the judge could
  // not separate them, so argmax(value) is noise. Break the near-tie with a
  // discriminating execution test over the candidates' code (same executor the
  // EVALUATE phase used); the test-passer becomes the winner, else value order.
  const selectedId = await selectWinnerByTest(population, argmaxWinner, takesEpsilon, {
    executor: rt.executor,
    judge: rt.judgeModel ?? rt.llm,
  });
  const winner = selectedId === argmaxWinner.id
    ? argmaxWinner
    : population.find((n) => n.id === selectedId) ?? argmaxWinner;

  // BUG-4: Below-threshold → converge reports failure, not hallucinated success
  if (winner.value < minAcceptable) {
    await rt.memory.append(
      'memory/MEMORY.md',
      `\n### Failed task (${isoDate()}, best score ${winner.value.toFixed(2)})\n` +
      `Task: ${winner.task.slice(0, 200)}\nAll approaches scored below ${minAcceptable}.\n`,
    );
    await rt.memory.index('memory/MEMORY.md');
    abandonSearchTree(rt.storage.sql, rootId);
    await recordTaskOutcome(rt, winner.task, 'error', winner.value);
    return {
      winnerId: winner.id,
      winnerValue: winner.value,
      converged: false,
      trajectory: [],
    };
  }

  const trajectory = winner.msg_id
    ? session.getHistory(winner.msg_id)
    : [];

  const summary = await rt.llm.complete(
    `Task: ${winner.task}\nResult: ${winner.observation.slice(0, 400)}\nScore: ${winner.value.toFixed(2)}\n\n` +
    `Summarize in ≤3 bullet points what approach worked:`,
  );
  await rt.memory.append(
    'memory/MEMORY.md',
    `\n## Successful approach (${isoDate()}, score ${winner.value.toFixed(2)})\n${summary}\n`,
  );
  await rt.memory.index('memory/MEMORY.md');

  // Extract winning code into CraftStore if available.
  // code_used is populated by ExplorationAgent when the branch produces code blocks.
  const winnerCode = rt.storage.sql<{ code_used: string | null }>`
    SELECT code_used FROM search_nodes WHERE id = ${winner.id}
  `[0]?.code_used;
  if (winnerCode && winner.value > DEFAULT_CONFIG.mcts.craftExtractionThreshold) {
    try {
      await maybeStoreCraftedTool(rt, winnerCode, winner.value);
    } catch {
      // Craft extraction failure is non-fatal
    }
  }

  // Alternate Takes: capture the winner's near-tied rivals BEFORE the close
  // below prunes them — afterwards they are indistinguishable from mid-search
  // prunes. The host claims the set for the turn at turn end; the user's pick
  // becomes the explicit preference signal in turn_outcomes.
  try {
    captureAlternateTakes(rt.storage.sql, { rootId, task: winner.task, winnerId: winner.id, epsilon: takesEpsilon });
  } catch {
    // alternate_takes may not exist in minimal test runtimes — non-fatal.
  }

  // Close the tree: the winner becomes terminal and every other open node in
  // this search is pruned, so a settled tree can never be re-entered.
  rt.storage.sql`
    UPDATE search_nodes
    SET status = 'pruned'
    WHERE root_id = ${rootId} AND status = 'open' AND id != ${winner.id}
  `;
  rt.storage.sql`
    UPDATE search_nodes SET status = 'terminal' WHERE id = ${winner.id}
  `;
  await recordTaskOutcome(rt, winner.task, 'success', winner.value);

  return {
    winnerId: winner.id,
    winnerValue: winner.value,
    converged: true,
    trajectory,
  };
}

/**
 * Retire every still-open node of a search that produced no winner — the
 * below-threshold path here, and the engine's handler for a convergence that
 * threw. A search is settled exactly when its tree has no open nodes left, so
 * this is what makes the durable 'failed' record honest.
 */
export function abandonSearchTree(sql: SqlExecutor, rootId: string): void {
  sql`UPDATE search_nodes SET status = 'failed'
      WHERE root_id = ${rootId} AND status = 'open'`;
}

/** Record the task outcome into task_history — the per-task ledger behind the
 *  agent-info "Tasks" stat and scaffold error-rate monitoring. */
async function recordTaskOutcome(
  rt: AgentRuntime,
  task: string,
  outcome: 'success' | 'error',
  score: number,
): Promise<void> {
  let scaffoldVersion = 0;
  try { scaffoldVersion = await rt.identity.scaffold.version(); } catch { /* scaffold-less backend */ }
  try {
    rt.storage.sql`
      INSERT INTO task_history (task, scaffold_version, outcome, score)
      VALUES (${task.slice(0, 500)}, ${scaffoldVersion}, ${outcome}, ${score})
    `;
  } catch {
    // task_history may not exist in minimal test runtimes — non-fatal.
  }
}
