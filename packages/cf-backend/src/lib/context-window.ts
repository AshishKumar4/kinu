export { COMPACT_AT_UTILIZATION, compactionThreshold, compactionThresholdForWindow, contextWindowForModel } from '@proteus/core';

import type { ModelProvider, ProviderDeps } from '@proteus/core';

/**
 * The provider catalog's reported window (ModelInfo.contextWindow) for one
 * model, or null when the provider/model/window is unknown. The catalog is
 * the source of truth (see core context-window.ts) — callers prefer this
 * over the static regex table when it resolves.
 */
export async function catalogContextWindow(
  provider: Pick<ModelProvider, 'listModels'> | undefined,
  deps: ProviderDeps,
  modelId: string,
): Promise<number | null> {
  if (!provider) return null;
  try {
    const models = await provider.listModels(deps);
    return models.find((m) => m.id === modelId)?.contextWindow ?? null;
  } catch {
    return null;
  }
}
