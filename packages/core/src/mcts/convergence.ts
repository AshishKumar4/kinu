/**
 * MCTS convergence — committing the winning branch.
 *
 * Architecture reference: docs/MCTS.md — "Pruning and convergence"
 *
 * BUG-4: When winner.value < MIN_ACCEPTABLE_SCORE, converge() returns
 * { converged: false }. The architecture doc does NOT specify what happens next
 * (no retry policy, no fallback). This is a documented behavioral underspecification.
 */

import type { SqlExecutor } from '../types/primitives';
import type { AgentRuntime } from '../types/agent-runtime';
import type { SearchNode } from '../types/mcts';
import type { ConvergenceResult } from '../types/evaluation';
import type { SessionWriter } from './record-node';
import { isCraftable, maybeStoreCraftedTool } from '../craft/discovery';
import { captureAlternateTakes, findNearTiedRivals } from './takes';
import { selectWinnerByTest } from './test-selection';
import { DEFAULT_CONFIG } from '../config';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { isoDate } from '../utils/date';
import type { WorkMode } from '../prompting/surface';

export async function converge(
  rt: AgentRuntime,
  session: SessionWriter,
  rootId: string,
  minAcceptable: number = DEFAULT_CONFIG.mcts.minAcceptableScore,
  takesEpsilon: number = DEFAULT_CONFIG.mcts.takesEpsilon,
  mode: WorkMode = 'build',
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
  const selectedId = mode === 'plan'
    ? argmaxWinner.id
    : await selectWinnerByTest(population, argmaxWinner, takesEpsilon, {
        executor: rt.executor,
        judge: rt.judgeModel ?? rt.llm,
      });
  const winner = selectedId === argmaxWinner.id
    ? argmaxWinner
    : population.find((n) => n.id === selectedId) ?? argmaxWinner;

  // A search that could not tell its branches apart did not converge on one.
  //
  // With no value signal every node carries the same number, so `ORDER BY value
  // DESC` degenerates to row order and the "winner" is whichever row SQLite
  // returned first — while the result still cleared `minAcceptable` and
  // reported success. Measured against this selector: at zero signal a 42-node
  // tree returns a node no better than one of 42 independent samples, and the
  // agreement between what it picked and the genuinely best node is 0%.
  //
  // The test is exact equality across DISTINCT approaches, not an epsilon: two
  // near-tied branches are a real near-tie the takes ledger exists to record,
  // whereas two textually different proposals scoring byte-identically means
  // the scorer is not a function of the proposal. `findNearTiedRivals` supplies
  // the population — it already drops the root, same-path refinements and
  // textual duplicates — but its epsilon window is one-sided and keeps rivals
  // scoring ABOVE the winner, which is the normal state after the execution
  // tie-break promotes a lower-value passer. Only the exact ties count.
  const indistinguishable = findNearTiedRivals(population, winner, 0)
    .filter((rival) => rival.value === winner.value);
  if (indistinguishable.length > 0) {
    if (mode === 'build') {
      await rt.memory.append(
        'memory/MEMORY.md',
        `\n### Undifferentiated search (${isoDate()})\n` +
        `Task: ${winner.task.slice(0, 200)}\n` +
        `${indistinguishable.length + 1} distinct approaches all scored ${winner.value.toFixed(2)}; ` +
        `nothing in this search could tell them apart, so no winner was earned.\n`,
      );
      await rt.memory.index('memory/MEMORY.md');
    }
    abandonSearchTree(rt.storage.sql, rootId);
    return {
      winnerId: winner.id,
      winnerValue: winner.value,
      converged: false,
      reason: 'undifferentiated',
      trajectory: [],
    };
  }

  // BUG-4: Below-threshold → converge reports failure, not hallucinated success
  if (winner.value < minAcceptable) {
    if (mode === 'build') {
      await rt.memory.append(
        'memory/MEMORY.md',
        `\n### Failed task (${isoDate()}, best score ${winner.value.toFixed(2)})\n` +
        `Task: ${winner.task.slice(0, 200)}\nAll approaches scored below ${minAcceptable}.\n`,
      );
      await rt.memory.index('memory/MEMORY.md');
      await recordTaskOutcome(rt, winner.task, 'error', winner.value);
    }
    abandonSearchTree(rt.storage.sql, rootId);
    return {
      winnerId: winner.id,
      winnerValue: winner.value,
      converged: false,
      reason: 'no_acceptable_candidate',
      trajectory: [],
    };
  }

  const trajectory = winner.msg_id
    ? session.getHistory(winner.msg_id)
    : [];

  if (mode === 'build') {
    const summary = await rt.llm.complete(
      `Task: ${winner.task}\nResult: ${evidenceWindow(winner.observation, EVIDENCE_BUDGETS.convergenceObservation)}\nScore: ${winner.value.toFixed(2)}\n\n` +
      `Summarize in ≤3 bullet points what approach worked:`,
    );
    await rt.memory.append(
      'memory/MEMORY.md',
      `\n## Successful approach (${isoDate()}, score ${winner.value.toFixed(2)})\n${summary}\n`,
    );
    await rt.memory.index('memory/MEMORY.md');

    const winnerCode = rt.storage.sql<{ code_used: string | null; code_language: string | null }>`
      SELECT code_used, code_language FROM search_nodes WHERE id = ${winner.id}
    `[0];
    if (winnerCode?.code_used && isCraftable(winnerCode.code_language)
        && winner.value > DEFAULT_CONFIG.mcts.craftExtractionThreshold) {
      await maybeStoreCraftedTool(rt, winnerCode.code_used, winner.value);
    }

    // The near-tied rivals of the answer the user is about to see. Capturing
    // them is the only preference signal this turn produces, so a capture that
    // fails settles nothing quietly.
    captureAlternateTakes(rt.storage.sql, { rootId, task: winner.task, winnerId: winner.id, epsilon: takesEpsilon });
  }

  // Close the tree: the winner becomes terminal and every other open node in
  // this search is pruned, so a settled tree can never be re-entered.
  void rt.storage.sql`
    UPDATE search_nodes
    SET status = 'pruned'
    WHERE root_id = ${rootId} AND status = 'open' AND id != ${winner.id}
  `;
  void rt.storage.sql`
    UPDATE search_nodes SET status = 'terminal' WHERE id = ${winner.id}
  `;
  if (mode === 'build') await recordTaskOutcome(rt, winner.task, 'success', winner.value);

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
  void sql`UPDATE search_nodes SET status = 'failed'
      WHERE root_id = ${rootId} AND status = 'open'`;
}

/** Record the task outcome into task_history — the per-task ledger behind the
 *  agent-info "Tasks" stat and scaffold error-rate monitoring. Both the scaffold
 *  version and task_history come from the workspace schema every backend
 *  initializes, so neither is optional: a search that cannot write its own
 *  outcome must say so rather than leave the ledger short one settled task. */
async function recordTaskOutcome(
  rt: AgentRuntime,
  task: string,
  outcome: 'success' | 'error',
  score: number,
): Promise<void> {
  const scaffoldVersion = await rt.identity.scaffold.version();
  void rt.storage.sql`
    INSERT INTO task_history (task, scaffold_version, outcome, score)
    VALUES (${task.slice(0, 500)}, ${scaffoldVersion}, ${outcome}, ${score})
  `;
}
