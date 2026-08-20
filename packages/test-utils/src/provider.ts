// ExplorationStrategy fixtures — stub strategies for the registry contract
// tests. Providers are mocked at the fetch seam instead (network.ts).
import type { ExplorationStrategy, StrategyContext, StrategyResult } from '@kinu/core';

export interface TestStrategyOptions {
  id: string;
  /** Static answer text. */
  answer?: string;
  /** Score in [0..1]. */
  score?: number;
  /** Make explore() throw with this message. */
  throwError?: string;
  /** Delay (ms) before returning — for budget/cancellation tests. */
  delayMs?: number;
}

export function createTestStrategy(opts: TestStrategyOptions): ExplorationStrategy {
  return {
    id: opts.id,
    label: opts.id,
    async explore(ctx: StrategyContext): Promise<StrategyResult> {
      if (opts.delayMs) await new Promise<void>(r => setTimeout(r, opts.delayMs));
      if (opts.throwError) throw new Error(opts.throwError);
      const text = opts.answer ?? `answer from ${opts.id} for: ${ctx.task}`;
      const score = opts.score ?? 1;
      return {
        strategy: opts.id,
        best: { text, score, source: opts.id },
        all: [{ text, score, source: opts.id }],
        cost: { durationMs: 0, iterations: 1 },
      };
    },
  };
}
