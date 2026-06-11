// ProviderRegistry — resolves "<provider>/<modelId>" → LanguageModel.
// resolve() is SYNCHRONOUS (model construction is sync everywhere). Async
// methods (defaultSpec, listProviders, listAllModels) exist for cred-aware UI
// queries and lazy default selection.
//
// Two registration tiers:
//   - register(provider): static, bespoke providers. Always authoritative.
//   - registerDynamic(source): one catalog-backed source serving provider ids
//     that are not statically registered (models.dev). Its get() is sync and
//     optimistic — catalog membership is enforced asynchronously (listIds for
//     the cred-aware listings, and the provider's own fetch path at request
//     time), keeping resolve() synchronous even with a cold catalog cache.
import type { LanguageModel } from 'ai';
import type {
  ModelProvider, ProviderDeps, ProviderInfo, ModelInfo,
} from './types.js';
import { parseModelSpec } from './types.js';

export interface DynamicProviderSource {
  /** Sync — build (or reuse) a provider for `providerId`, or undefined when
   *  the id is out of this source's namespace. Must be optimistic: actual
   *  catalog membership is validated at request time, not here. */
  get(providerId: string): ModelProvider | undefined;
  /** Async — provider ids currently servable (stored credential ∩ catalog).
   *  Used by the listing methods; ids shadowed by static providers are
   *  filtered by the registry. */
  listIds(deps: ProviderDeps): Promise<string[]>;
}

export interface ProviderRegistry {
  register(provider: ModelProvider): void;
  /** Register the (single) dynamic catalog source. Static providers always
   *  take precedence for their ids. */
  registerDynamic(source: DynamicProviderSource): void;
  get(providerId: string): ModelProvider | undefined;
  /** Sync — whether `resolve()` would find a provider for this id (static
   *  or dynamic). Dynamic acceptance is optimistic — see DynamicProviderSource. */
  canResolve(providerId: string): boolean;
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
  let dynamic: DynamicProviderSource | null = null;

  /** Static providers + currently-servable dynamic ones (static ids win). */
  async function allProviders(deps: ProviderDeps): Promise<ModelProvider[]> {
    if (!dynamic) return [...ordered];
    const out = [...ordered];
    for (const id of await dynamic.listIds(deps)) {
      if (byId.has(id)) continue;
      const provider = dynamic.get(id);
      if (provider) out.push(provider);
    }
    return out;
  }

  function providerFor(providerId: string): ModelProvider | undefined {
    return byId.get(providerId) ?? dynamic?.get(providerId);
  }

  return {
    register(provider) {
      if (byId.has(provider.id)) throw new Error(`Provider ${provider.id} already registered`);
      byId.set(provider.id, provider);
      ordered.push(provider);
    },
    registerDynamic(source) {
      if (dynamic) throw new Error('Dynamic provider source already registered');
      dynamic = source;
    },
    get(id) { return byId.get(id); },
    canResolve(id) { return providerFor(id) !== undefined; },

    list() { return [...ordered]; },

    async listProviders(deps) {
      const out: ProviderInfo[] = [];
      for (const p of await allProviders(deps)) {
        const available = await p.isAvailable(deps);
        const info: ProviderInfo = { id: p.id, label: p.label, available };
        if (!available && p.unavailableReason) info.unavailableReason = await p.unavailableReason(deps);
        out.push(info);
      }
      return out;
    },

    async listAllModels(deps) {
      const out: Array<ModelInfo & { provider: string }> = [];
      for (const p of await allProviders(deps)) {
        if (!(await p.isAvailable(deps))) continue;
        const models = await p.listModels(deps);
        for (const m of models) out.push({ ...m, provider: p.id });
      }
      return out;
    },

    resolve(spec, deps) {
      const parsed = parseModelSpec(spec);
      const provider = providerFor(parsed.provider);
      if (!provider) {
        const known = Array.from(byId.keys()).join(', ');
        throw new Error(`Unknown provider ${JSON.stringify(parsed.provider)} (registered: ${known || 'none'}).`);
      }
      return provider.createModel(parsed.modelId, deps);
    },

    async defaultSpec(deps) {
      for (const p of await allProviders(deps)) {
        if (!(await p.isAvailable(deps))) continue;
        const modelId = p.defaultModel ?? (await p.listModels(deps))[0]?.id;
        if (modelId) return `${p.id}/${modelId}`;
      }
      return null;
    },
  };
}
