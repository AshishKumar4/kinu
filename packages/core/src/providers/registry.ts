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
} from './types';
import { parseModelSpec } from './types';

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

/** A provider whose availability check or model listing threw — a revoked
 *  OAuth grant, an unreachable endpoint, a malformed stored credential. It is
 *  reported instead of thrown so ONE broken provider cannot empty a menu that
 *  every other provider is still able to fill. */
export interface ProviderFailure {
  provider: string;
  label?: string;
  reason: string;
}

/** The model menu: what can be listed, plus what could not be reached. */
export interface ModelMenu {
  models: Array<ModelInfo & { provider: string }>;
  failures: ProviderFailure[];
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
  /** Async — list providers with their current availability state. A provider
   *  that throws while being probed lists as unavailable with the error as its
   *  reason; it never fails the call. */
  listProviders(deps: ProviderDeps): Promise<ProviderInfo[]>;
  /** Async — every available provider's models, plus the providers that could
   *  not be listed. Never rejects because of one provider. */
  listAllModels(deps: ProviderDeps): Promise<ModelMenu>;
  resolve(spec: string, deps: ProviderDeps): LanguageModel;
  defaultSpec(deps: ProviderDeps): Promise<string | null>;
}

/** The id the dynamic catalog source reports under when IT is what failed
 *  (the models.dev fetch, the stored-key enumeration) — no single provider
 *  owns that failure. */
export const CATALOG_SOURCE_ID = 'catalog';

export function providerFailureReason({ error }: { error: unknown }): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || 'unknown error';
}

export function createProviderRegistry(): ProviderRegistry {
  const ordered: ModelProvider[] = [];
  const byId = new Map<string, ModelProvider>();
  let dynamic: DynamicProviderSource | null = null;

  /** Static providers + currently-servable dynamic ones (static ids win).
   *  A dynamic source that cannot enumerate (models.dev down, credential
   *  store unreachable) is reported as one failure and costs only ITS
   *  providers — the static ones are still returned. */
  async function allProviders(deps: ProviderDeps): Promise<{
    providers: ModelProvider[];
    failures: ProviderFailure[];
  }> {
    const providers = [...ordered];
    if (!dynamic) return { providers, failures: [] };
    try {
      for (const id of await dynamic.listIds(deps)) {
        if (byId.has(id)) continue;
        const provider = dynamic.get(id);
        if (provider) providers.push(provider);
      }
    } catch (err) {
      return {
        providers,
        failures: [{
          provider: CATALOG_SOURCE_ID,
          label: 'models.dev catalog',
          reason: providerFailureReason({ error: err }),
        }],
      };
    }
    return { providers, failures: [] };
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
      const { providers, failures } = await allProviders(deps);
      const out: ProviderInfo[] = [];
      for (const p of providers) {
        try {
          const available = await p.isAvailable(deps);
          const info: ProviderInfo = { id: p.id, label: p.label, available };
          if (!available && p.unavailableReason) info.unavailableReason = await p.unavailableReason(deps);
          out.push(info);
        } catch (err) {
          out.push({ id: p.id, label: p.label, available: false, unavailableReason: providerFailureReason({ error: err }) });
        }
      }
      for (const failure of failures) {
        out.push({ id: failure.provider, label: failure.label, available: false, unavailableReason: failure.reason });
      }
      return out;
    },

    async listAllModels(deps) {
      const { providers, failures: sourceFailures } = await allProviders(deps);
      const models: Array<ModelInfo & { provider: string }> = [];
      const failures = [...sourceFailures];
      for (const p of providers) {
        try {
          if (!(await p.isAvailable(deps))) continue;
          for (const m of await p.listModels(deps)) models.push({ ...m, provider: p.id });
        } catch (err) {
          failures.push({ provider: p.id, label: p.label, reason: providerFailureReason({ error: err }) });
        }
      }
      return { models, failures };
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
      // Preference order, first usable wins — a provider that throws is
      // skipped so a broken credential cannot leave the agent with no model.
      for (const p of (await allProviders(deps)).providers) {
        try {
          if (!(await p.isAvailable(deps))) continue;
          const modelId = p.defaultModel ?? (await p.listModels(deps))[0]?.id;
          if (modelId) return `${p.id}/${modelId}`;
        } catch { continue; }
      }
      return null;
    },
  };
}
