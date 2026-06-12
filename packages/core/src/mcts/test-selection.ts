/**
 * Test-based selection at MCTS convergence (DO-NOW #3).
 *
 * converge() picks argmax(value). When the top candidates are within
 * `takesEpsilon` — a near-tie the judge ensemble could not separate — value
 * order is noise. Instead we run a DISCRIMINATING execution check: generate one
 * assertion harness against the task, run each near-tied candidate's code
 * through the SAME grounded executor the EVALUATE phase used, and pick the
 * candidate that passes. Falls back to value order when no candidate carries
 * runnable code or the harness can't separate them.
 *
 * Grounding: CodeMonkeys — pool → generated tests → test-based selection beats
 * argmax over self-rated value (arXiv:2501.14723).
 */

import type { SearchNode } from '../types/mcts.js';
import type { LLM, Executor } from '../types/primitives.js';
import { findNearTiedRivals } from './takes.js';
import { generateAssertions, runForVerdict } from './evaluation.js';

export interface TestSelectionDeps {
  executor: Executor;
  /** Cross-model judge when configured; the explorer otherwise (same fallback
   *  rule the evaluator documents). */
  judge: LLM;
}

/**
 * Choose the converged winner among the near-tied terminal candidates by
 * discriminating execution test. Returns the winning node id — the argmax
 * `winner` unchanged when the tie cannot be broken by tests (no runnable code,
 * or all-pass / all-fail).
 *
 * `nodes` is the population converge() decided over (terminal/open, pre-close).
 */
export async function selectWinnerByTest(
  nodes: readonly SearchNode[],
  winner: SearchNode,
  epsilon: number,
  deps: TestSelectionDeps,
): Promise<string> {
  // The near-tie set, winner included, ordered by value (winner first).
  const rivals = findNearTiedRivals(nodes, winner, epsilon);
  if (rivals.length === 0) return winner.id;
  const candidates = [winner, ...rivals];

  // Only candidates that carry runnable code can be discriminated by execution.
  const runnable = candidates.filter((n) => (n.code_used ?? '').trim().length > 0);
  if (runnable.length < 2) return winner.id;

  // One harness, written against the task using the value-argmax winner's code
  // as the reference shape, then run against EACH candidate's own code.
  const assertions = await generateAssertions(deps.judge, winner.task, runnable[0]!.code_used!.trim());
  if (!assertions) return winner.id;

  const verdicts = await Promise.all(
    runnable.map(async (n) => ({
      node: n,
      passed: (await runForVerdict(deps.executor, n.code_used!.trim(), assertions)).passed,
    })),
  );

  const passers = verdicts.filter((v) => v.passed);
  // No separation (all pass or all fail) → keep value order.
  if (passers.length === 0 || passers.length === verdicts.length) return winner.id;

  // The argmax winner already passes → confirmed; don't churn the answer.
  if (passers.some((v) => v.node.id === winner.id)) return winner.id;

  // The winner FAILED the discriminating test but a near-tied rival PASSED —
  // promote the highest-value passer (verdicts preserve the value order).
  return passers[0]!.node.id;
}
