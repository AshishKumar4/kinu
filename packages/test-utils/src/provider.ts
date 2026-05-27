// ModelProvider + StrategyRegistry fixtures.
//
// Two shapes: stub providers/strategies for the registry contract tests, and
// "fake-but-realistic" ones that integrate with mocked fetch via createMockFetch.
import type {
  ModelProvider, ModelInfo, ExplorationStrategy, StrategyContext, StrategyResult,
} from '@proteus/core';
import type { LanguageModel } from 'ai';

export interface TestProviderOptions {
  id: string;
  modelId?: string;
  available?: boolean;
  models?: ModelInfo[];
  /** Returned by createModel. Default: a stub LanguageModel-shaped object. */
  model?: LanguageModel;
}

export function createTestProvider(opts: TestProviderOptions): ModelProvider {
  const models = opts.models ?? [{ id: opts.modelId ?? 'default' }];
  return {
    id: opts.id,
    label: opts.id,
    defaultModel: opts.modelId,
    isAvailable: () => opts.available ?? true,
    listModels: () => models,
    createModel: () => opts.model ?? ({ specificationVersion: 'v2', provider: opts.id } as unknown as LanguageModel),
  };
}

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
