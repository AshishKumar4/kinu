/**
 * MCTS convergence: committing the winning branch. Reference: docs/MCTS.md "Pruning and convergence".
 * Below MIN_ACCEPTABLE_SCORE, converge() returns { converged: false }; no retry policy is specified.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ConvergenceResult } from '../types/evaluation';
import type { SessionWriter } from './record-node';
import { isCraftable, maybeStoreCraftedTool } from '../craft/discovery';
import { captureAlternateTakes, findNearTiedRivals, inPopulation, searchTree } from './takes';
import { selectWinnerByTest } from './test-selection';
import { DEFAULT_CONFIG } from '../config';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../utils/evidence-window';
import { isoDate } from '../utils/date';
import type { WorkMode } from '../types/turn';

export interface ConvergeOptions {
  readonly minAcceptable?: number;
  readonly takesEpsilon?: number;
  readonly mode?: WorkMode;
}

export async function converge(
  rt: AgentRuntime,
  session: SessionWriter,
  rootId: string,
  opts: ConvergeOptions = {},
): Promise<ConvergenceResult> {
  const minAcceptable = opts.minAcceptable ?? DEFAULT_CONFIG.mcts.minAcceptableScore;
  const takesEpsilon = opts.takesEpsilon ?? DEFAULT_CONFIG.mcts.takesEpsilon;
  const mode = opts.mode ?? 'build';

  const tree = searchTree(rt.storage.sql, rt.actor, rootId);
  const population = tree.filter(inPopulation);

  const argmaxWinner = population[0];

  if (!argmaxWinner) {
    throw new Error('No viable nodes — all branches failed or were pruned');
  }

  const winner = mode === 'plan'
    ? argmaxWinner
    : await selectWinnerByTest(tree, argmaxWinner, takesEpsilon, {
        executor: rt.executor,
        judge: rt.judgeModel ?? rt.llm,
      });

  // Distinct approaches scoring exactly equal mean the scorer carries no signal: not converged.
  // Only exact ties count; findNearTiedRivals' epsilon window also keeps rivals above the winner.
  const indistinguishable = findNearTiedRivals(tree, winner, 0)
    .filter((rival) => rival.ownScore === winner.ownScore);

  if (indistinguishable.length > 0) {
    if (mode === 'build') {
      await rt.memory.append(
        'memory/MEMORY.md',
        `\n### Undifferentiated search (${isoDate()})\n` +
        `Task: ${winner.task.slice(0, 200)}\n` +
        `${indistinguishable.length + 1} distinct approaches all scored ${winner.ownScore.toFixed(2)}; ` +
        `nothing in this search could tell them apart, so no winner was earned.\n`,
      );
      await rt.memory.index('memory/MEMORY.md');
    }

    abandonSearchTree(rt.storage.sql, rt.actor, rootId);

    return {
      winnerId: winner.id,
      winnerValue: winner.ownScore,
      converged: false,
      reason: 'undifferentiated',
      trajectory: [],
    };
  }

  if (winner.ownScore < minAcceptable) {
    if (mode === 'build') {
      await rt.memory.append(
        'memory/MEMORY.md',
        `\n### Failed task (${isoDate()}, best score ${winner.ownScore.toFixed(2)})\n` +
        `Task: ${winner.task.slice(0, 200)}\nAll approaches scored below ${minAcceptable}.\n`,
      );
      await rt.memory.index('memory/MEMORY.md');
      await recordTaskOutcome(rt, winner.task, 'error', winner.ownScore);
    }

    abandonSearchTree(rt.storage.sql, rt.actor, rootId);

    return {
      winnerId: winner.id,
      winnerValue: winner.ownScore,
      converged: false,
      reason: 'no_acceptable_candidate',
      trajectory: [],
    };
  }

  const trajectory = winner.msg_id
    ? await session.getHistory(winner.msg_id)
    : [];

  if (mode === 'build') {
    const summary = await rt.llm.complete(
      `Task: ${winner.task}\nResult: ${evidenceWindow(winner.observation, EVIDENCE_BUDGETS.convergenceObservation)}\nScore: ${winner.ownScore.toFixed(2)}\n\n` +
      `Summarize in ≤3 bullet points what approach worked:`,
    );

    await rt.memory.append(
      'memory/MEMORY.md',
      `\n## Successful approach (${isoDate()}, score ${winner.ownScore.toFixed(2)})\n${summary}\n`,
    );
    await rt.memory.index('memory/MEMORY.md');

    if (winner.code_used && isCraftable(winner.code_language)
        && winner.ownScore > DEFAULT_CONFIG.mcts.craftExtractionThreshold) {
      await maybeStoreCraftedTool(rt, winner.code_used, winner.ownScore);
    }

    // Rivals are the turn's only preference signal, so a capture failure must surface.
    captureAlternateTakes(rt.storage.sql, rt.actor, { rootId, task: winner.task, winnerId: winner.id, epsilon: takesEpsilon });
  }

  void rt.storage.sql`
    UPDATE search_nodes
    SET status = 'pruned'
    WHERE actor_id = ${rt.actor.actorId} AND root_id = ${rootId}
      AND status = 'open' AND id != ${winner.id}
  `;
  void rt.storage.sql`
    UPDATE search_nodes SET status = 'terminal'
    WHERE actor_id = ${rt.actor.actorId} AND id = ${winner.id}
  `;

  if (mode === 'build') await recordTaskOutcome(rt, winner.task, 'success', winner.ownScore);

  return {
    winnerId: winner.id,
    winnerValue: winner.ownScore,
    converged: true,
    trajectory,
  };
}

/** Retire every open node of a search with no winner; a search is settled when no open nodes remain. */
export function abandonSearchTree(sql: SqlExecutor, actor: ActorHandle, rootId: string): void {
  actor.assertCurrent();
  void sql`UPDATE search_nodes SET status = 'failed'
      WHERE actor_id = ${actor.actorId} AND root_id = ${rootId} AND status = 'open'`;
}

/** Record the task outcome into task_history; a write failure throws rather than leaving the ledger short. */
async function recordTaskOutcome(
  rt: AgentRuntime,
  task: string,
  outcome: 'success' | 'error',
  score: number,
): Promise<void> {
  const scaffoldVersion = await rt.identity.scaffold.version();
  rt.actor.assertCurrent();
  void rt.storage.sql`
    INSERT INTO task_history (actor_id, task, scaffold_version, outcome, score)
    VALUES (${rt.actor.actorId}, ${task.slice(0, 500)}, ${scaffoldVersion}, ${outcome}, ${score})
  `;
}
