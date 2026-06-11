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
import { captureAlternateTakes } from './takes.js';
import { DEFAULT_CONFIG } from '../config.js';
import { isoDate } from '../utils/date.js';

export async function converge(
  rt: AgentRuntime,
  session: SessionWriter,
  minAcceptable: number = DEFAULT_CONFIG.mcts.minAcceptableScore,
  takesEpsilon: number = DEFAULT_CONFIG.mcts.takesEpsilon,
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
    // Close every remaining open node so the next runMCTS starts from its own
    // fresh root: global-argmax UCT only considers status='open', and leaving
    // these open let a later task expand under this task's nodes.
    rt.storage.sql`UPDATE search_nodes SET status = 'failed' WHERE status = 'open'`;
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
    captureAlternateTakes(rt.storage.sql, { task: winner.task, winnerId: winner.id, epsilon: takesEpsilon });
  } catch {
    // alternate_takes may not exist in minimal test runtimes — non-fatal.
  }

  // Close the tree: the winner becomes terminal and every other open node is
  // pruned. Nothing stays 'open' across tasks — otherwise global-argmax UCT
  // would prefer this task's high-value winner over the next task's fresh root.
  rt.storage.sql`
    UPDATE search_nodes
    SET status = 'pruned'
    WHERE status = 'open' AND id != ${winner.id}
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
