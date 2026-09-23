/**
 * Test-based selection at MCTS convergence: near-tied candidates (within `takesEpsilon`) are
 * separated by a generated check suite run through the grounded executor; value order otherwise.
 * CodeMonkeys, arXiv:2501.14723.
 */

import type { LLM, Executor } from '../types/primitives';
import { findNearTiedRivals, type ScoredSearchNode } from './takes';
import { checkFraction, generateAssertionSuite, runForVerdict } from './evaluation';
import { diagnostics, toKinuError } from '../obs/index';

export interface TestSelectionDeps {
  executor: Executor;
  /** Cross-model judge when configured; the explorer otherwise. */
  judge: LLM;
}

/** The converged winner among near-tied candidates; `winner` unchanged when tests cannot break the tie. */
export async function selectWinnerByTest(
  nodes: readonly ScoredSearchNode[],
  winner: ScoredSearchNode,
  epsilon: number,
  deps: TestSelectionDeps,
): Promise<string> {
  const rivals = findNearTiedRivals(nodes, winner, epsilon);

  if (rivals.length === 0) return winner.id;
  const candidates = [winner, ...rivals];

  // One assertion harness can compare candidates written in one language.
  const language = candidates.find((node) => (node.code_used ?? '').trim().length > 0)?.code_language;

  if (!language) return winner.id;

  const runnable = candidates.filter((node) =>
    (node.code_used ?? '').trim().length > 0 && node.code_language === language);

  if (runnable.length < 2) return winner.id;

  // A winner with no runnable code in this language cannot lose, so value order holds.
  const winnerRunnable = runnable.find((node) => node.id === winner.id);

  if (!winnerRunnable) return winner.id;
  const winnerCode = (winnerRunnable.code_used ?? '').trim();

  if (!winnerCode) return winner.id;

  // Suite generation is best-effort: a judge failure keeps the argmax winner.
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

      // The pass share, not the pass bit: all-pass/all-fail would otherwise fall back to value order.
      return { node: n, share: checkFraction(execution) ?? (execution.passed ? 1 : 0) };
    }),
  );

  // A tie on share keeps the highest-value candidate.
  const best = Math.max(...verdicts.map((v) => v.share));
  const winnerShare = verdicts.find((v) => v.node.id === winner.id)?.share;

  if (winnerShare === undefined || winnerShare >= best) return winner.id;

  return verdicts.find((v) => v.share === best)?.node.id ?? winner.id;
}
