export * from './types.js';
export * from './single-shot.js';
export * from './effort.js';
export * from './mcts.js';
export * from './heads.js';
export * from './think-tool.js';

import { createStrategyRegistry, type StrategyRegistry } from './types.js';
import { createSingleShotStrategy } from './single-shot.js';

/** Default strategy registry — single-shot baseline. Callers register
 *  additional strategies (MCTS, Heads, ToT, …) on top. */
export function createDefaultStrategyRegistry(): StrategyRegistry {
  const reg = createStrategyRegistry();
  reg.register(createSingleShotStrategy());
  return reg;
}
