// Trivial strategy — one LLM call, return its answer with score 1.0.
// Useful as a baseline against MCTS / Heads / ToT in evals.
import { generateText } from 'ai';
import type { ExplorationStrategy, StrategyContext, StrategyResult } from './types';
import { normalizeUsage, usageTotal } from '../usage';

export function createSingleShotStrategy(): ExplorationStrategy {
  return {
    id: 'single-shot',
    label: 'Single shot',
    description: 'One LLM call, returned verbatim. Baseline strategy.',
    // Eval-harness baseline only: a chat model calling think for one LLM call
    // would be pure overhead, so it is not in the LLM-visible enum.
    advertised: false,
    async explore(ctx: StrategyContext): Promise<StrategyResult> {
      const t0 = Date.now();
      const result = await generateText({
        // No output cap — completion length is the model's. A cap here once did
        // the opposite of bounding cost: `maxIterations`, the LOOP count, was
        // read as a generation length and this baseline returned empty text.
        model: ctx.model,
        prompt: ctx.task,
        abortSignal: ctx.signal,
      });
      const spent = normalizeUsage(result.usage);
      // `reflection` — the least wrong of the ten, and deliberately not one of
      // the three that look closer. Not `agent`: this call is not a turn step.
      // Not `head`: this strategy writes no `head_journal` row, and that bucket
      // is aggregated from the journal by a single writer. Not `mcts`: naming a
      // strategy the caller did not run is worse than naming none. What is left
      // is what this arm actually is — the baseline the harness compares other
      // strategies against, which is measurement spend, not the agent's work.
      ctx.reportModelCall?.({
        source: 'reflection',
        usage: spent,
        modelId: result.response.modelId,
      });
      const text = result.text.trim();
      return {
        strategy: 'single-shot',
        best: { text, score: 1, source: 'single-shot' },
        all: [{ text, score: 1, source: 'single-shot' }],
        cost: {
          // Absent when the provider reported nothing — `cost.tokens` is
          // optional precisely so a baseline run cannot read as free. A scalar
          // for the strategy's own caller; the sink above carries the same
          // report field by field, which is what the workspace total needs.
          tokens: usageTotal(spent),
          durationMs: Date.now() - t0,
          iterations: 1,
        },
      };
    },
  };
}
