/**
 * MCTS convergence — committing the winning branch.
 *
 * Architecture reference: final-architecture.md §5.9
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
import { DEFAULT_CONFIG } from '../config.js';
import { isoDate } from '../utils/date.js';

export async function converge(
  rt: AgentRuntime,
  session: SessionWriter,
  minAcceptable: number = DEFAULT_CONFIG.mcts.minAcceptableScore,
): Promise<ConvergenceResult> {
  const winner = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes
    WHERE status IN ('terminal', 'open')
    ORDER BY value DESC, depth DESC
    LIMIT 1
  `[0];

  if (!winner) {
    throw new Error('No viable nodes — all branches failed or were pruned');
  }

  // BUG-4: Below-threshold → converge reports failure, not hallucinated success
  if (winner.value < minAcceptable) {
    await rt.memory.append(
      'memory/MEMORY.md',
      `\n### Failed task (${isoDate()}, best score ${winner.value.toFixed(2)})\n` +
      `Task: ${winner.task.slice(0, 200)}\nAll approaches scored below ${minAcceptable}.\n`,
    );
    await rt.memory.index('memory/MEMORY.md');
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

  // Compact: store non-destructive overlay so future branches start from compressed prior
  await session.compact();

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

  // Mark all other open nodes as pruned
  rt.storage.sql`
    UPDATE search_nodes
    SET status = 'pruned'
    WHERE status = 'open' AND id != ${winner.id}
  `;

  return {
    winnerId: winner.id,
    winnerValue: winner.value,
    converged: true,
    trajectory,
  };
}
