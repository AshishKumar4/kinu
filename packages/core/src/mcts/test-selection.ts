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

import type { SearchNode } from '../types/mcts';
import type { LLM, Executor } from '../types/primitives';
import { findNearTiedRivals } from './takes';
import { checkFraction, generateAssertionSuite, runForVerdict } from './evaluation';
import { diagnostics, toKinuError } from '../obs/index';

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

  // One assertion harness can compare candidates written in one language.
  const language = candidates.find((node) => (node.code_used ?? '').trim().length > 0)?.code_language;
  if (!language) return winner.id;
  const runnable = candidates.filter((node) =>
    (node.code_used ?? '').trim().length > 0 && node.code_language === language);
  if (runnable.length < 2) return winner.id;

  // The suite measures runnable code. A winner with none in this language
  // cannot lose to it, so the tie stands and value order holds.
  const winnerRunnable = runnable.find((node) => node.id === winner.id);
  if (!winnerRunnable) return winner.id;
  const winnerCode = (winnerRunnable.code_used ?? '').trim();
  if (!winnerCode) return winner.id;

  // One check suite, written against the task using the value-argmax winner's
  // code as the reference shape, then run against EACH candidate's own code.
  // Suite generation is best-effort: a judge failure keeps the argmax winner
  // instead of failing the search it was meant to settle.
  let checks: readonly string[];
  try {
    checks = await generateAssertionSuite(
      deps.judge, winner.task, winnerCode, language);
  } catch (cause) {
    diagnostics.failure(
      'mcts.test_selection_failed',
      toKinuError({ doing: 'generate the discriminating test suite', cause, otherwise: 'unavailable' }),
      { winnerId: winner.id },
    );
    return winner.id;
  }
  if (checks.length === 0) return winner.id;

  const verdicts = await Promise.all(
    runnable.map(async (n) => {
      const code = (n.code_used ?? '').trim();
      const execution = await runForVerdict(deps.executor, code, checks, language);
      // The measured share, not the pass bit. All-pass and all-fail used to be
      // dead ends that fell back to value order; a suite of independent checks
      // separates "two of four" from "none of four", so a near-tie the judge
      // could not resolve is now resolved by how much of the task each
      // candidate actually satisfies.
      return { node: n, share: checkFraction(execution) ?? (execution.passed ? 1 : 0) };
    }),
  );

  // The highest-value candidate among the best performers wins — a tie on
  // share keeps today's answer.
  const best = Math.max(...verdicts.map((v) => v.share));
  const winnerShare = verdicts.find((v) => v.node.id === winner.id)?.share;
  // No separation: nothing measured beats the argmax winner's own share.
  if (winnerShare === undefined || winnerShare >= best) return winner.id;
  return verdicts.find((v) => v.share === best)?.node.id ?? winner.id;
}
