// Trivial strategy — one LLM call, return its answer with score 1.0.
// Useful as a baseline against MCTS / Heads / ToT in evals.
import { generateText } from 'ai';
import type { ExplorationStrategy, StrategyContext, StrategyResult } from './types.js';

export function createSingleShotStrategy(): ExplorationStrategy {
  return {
    id: 'single-shot',
    label: 'Single shot',
    description: 'One LLM call, returned verbatim. Baseline strategy.',
    async explore(ctx: StrategyContext): Promise<StrategyResult> {
      const t0 = Date.now();
      const { text, usage } = await generateText({
        // maxIterations is the LOOP count, NOT the generation length — reusing
        // it here capped output at ~10 tokens (the think tool's default budget),
        // which is why single-shot returned empty text.
        model: ctx.model,
        prompt: ctx.task,
        maxOutputTokens: ctx.budget?.maxOutputTokens ?? 2048,
        abortSignal: ctx.signal,
      });
      return {
        strategy: 'single-shot',
        best: { text: text.trim(), score: 1, source: 'single-shot' },
        all: [{ text: text.trim(), score: 1, source: 'single-shot' }],
        cost: {
          tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
          durationMs: Date.now() - t0,
          iterations: 1,
        },
      };
    },
  };
}
