// ProviderRegistry — resolves "<provider>/<modelId>" → LanguageModel.
// resolve() is SYNCHRONOUS (model construction is sync everywhere). Async
// methods (defaultSpec, listProviders, listAllModels) exist for cred-aware UI
// queries and lazy default selection.
import type { LanguageModel } from 'ai';
import type {
  ModelProvider, ProviderDeps, ProviderInfo, ModelInfo,
} from './types.js';
import { parseModelSpec } from './types.js';

export interface ProviderRegistry {
  register(provider: ModelProvider): void;
  get(providerId: string): ModelProvider | undefined;
  /** Sync — list registered providers in registration order. Use when you
   *  only need the static set (no cred-aware availability check needed). */
  list(): ModelProvider[];
  /** Async — list providers with their current availability state. */
  listProviders(deps: ProviderDeps): Promise<ProviderInfo[]>;
  listAllModels(deps: ProviderDeps): Promise<Array<ModelInfo & { provider: string }>>;
  resolve(spec: string, deps: ProviderDeps): LanguageModel;
  defaultSpec(deps: ProviderDeps): Promise<string | null>;
}

export function createProviderRegistry(): ProviderRegistry {
  const ordered: ModelProvider[] = [];
  const byId = new Map<string, ModelProvider>();

  return {
    register(provider) {
      if (byId.has(provider.id)) throw new Error(`Provider ${provider.id} already registered`);
      byId.set(provider.id, provider);
      ordered.push(provider);
    },
    get(id) { return byId.get(id); },

    list() { return [...ordered]; },

    async listProviders(deps) {
      const out: ProviderInfo[] = [];
      for (const p of ordered) {
        const available = await p.isAvailable(deps);
        const info: ProviderInfo = { id: p.id, label: p.label, available };
        if (!available && p.unavailableReason) info.unavailableReason = await p.unavailableReason(deps);
        out.push(info);
      }
      return out;
    },

    async listAllModels(deps) {
      const out: Array<ModelInfo & { provider: string }> = [];
      for (const p of ordered) {
        if (!(await p.isAvailable(deps))) continue;
        const models = await p.listModels(deps);
        for (const m of models) out.push({ ...m, provider: p.id });
      }
      return out;
    },

    resolve(spec, deps) {
      const parsed = parseModelSpec(spec);
      const provider = byId.get(parsed.provider);
      if (!provider) {
        const known = Array.from(byId.keys()).join(', ');
        throw new Error(`Unknown provider ${JSON.stringify(parsed.provider)} (registered: ${known || 'none'}).`);
      }
      return provider.createModel(parsed.modelId, deps);
    },

    async defaultSpec(deps) {
      for (const p of ordered) {
        if (!(await p.isAvailable(deps))) continue;
        const modelId = p.defaultModel ?? (await p.listModels(deps))[0]?.id;
        if (modelId) return `${p.id}/${modelId}`;
      }
      return null;
    },
  };
}
