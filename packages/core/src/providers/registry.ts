// ProviderRegistry: resolves "<provider>/<modelId>" synchronously. Static providers
// always win; the dynamic (models.dev) source is optimistic, validated at request time.
import type { LanguageModel } from 'ai';
import type {
  ModelProvider, ProviderDeps, ProviderInfo, ModelInfo,
} from './types';
import { parseModelSpec } from './types';
import { diagnostics, renderThrownChain } from '../obs/index';

export interface DynamicProviderSource {
  /** Must be optimistic: catalog membership is validated at request time. */
  get(providerId: string): ModelProvider | undefined;
  /** Ids currently servable (stored credential ∩ catalog). */
  listIds(deps: ProviderDeps): Promise<string[]>;
}

/** A provider whose probe threw; reported, not thrown, so one broken provider cannot empty the menu. */
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
  /** Register the single dynamic catalog source. */
  registerDynamic(source: DynamicProviderSource): void;
  get(providerId: string): ModelProvider | undefined;
  /** Dynamic acceptance is optimistic. */
  canResolve(providerId: string): boolean;
  /** Static providers in registration order. */
  list(): ModelProvider[];
  /** A provider that throws lists as unavailable with the error as reason. */
  listProviders(deps: ProviderDeps): Promise<ProviderInfo[]>;
  /** Never rejects because of one provider. */
  listAllModels(deps: ProviderDeps): Promise<ModelMenu>;
  resolve(spec: string, deps: ProviderDeps): LanguageModel;
  defaultSpec(deps: ProviderDeps): Promise<string | null>;
}

/** Id for a failure of the dynamic source itself. */
const CATALOG_SOURCE_ID = 'catalog';

/** The whole cause chain, never empty. */
function providerFailureReason({ error }: { error: unknown }): string {
  return renderThrownChain({ cause: error }).trim() || 'unknown error';
}

export function createProviderRegistry(): ProviderRegistry {
  const ordered: ModelProvider[] = [];
  const byId = new Map<string, ModelProvider>();
  let dynamic: DynamicProviderSource | null = null;

  /** Static plus servable dynamic providers; a dynamic enumeration failure is one reported failure. */
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

  /** Probe all providers concurrently, answering in registration order. No deadline:
   *  a clock would turn "slow" into "absent". */
  async function probeEach<T>(
    providers: readonly ModelProvider[],
    probe: (provider: ModelProvider) => Promise<T>,
  ): Promise<Array<
    | { readonly provider: ModelProvider; readonly ok: true; readonly value: T }
    | { readonly provider: ModelProvider; readonly ok: false; readonly error: unknown }
  >> {
    return Promise.all(providers.map(async (provider) => {
      try {
        return { provider, ok: true as const, value: await probe(provider) };
      } catch (error) {
        return { provider, ok: false as const, error };
      }
    }));
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

      for (const probed of await probeEach(providers, async (p) => {
        const available = await p.isAvailable(deps);
        const info: ProviderInfo = { id: p.id, label: p.label, available };

        if (!available && p.unavailableReason) info.unavailableReason = await p.unavailableReason(deps);

        return info;
      })) {
        out.push(probed.ok ? probed.value : {
          id: probed.provider.id,
          label: probed.provider.label,
          available: false,
          unavailableReason: providerFailureReason({ error: probed.error }),
        });
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

      // `null`: unavailable, which is not a failure.
      for (const probed of await probeEach(providers, async (p) => (
        await p.isAvailable(deps) ? await p.listModels(deps) : null
      ))) {
        if (!probed.ok) {
          failures.push({
            provider: probed.provider.id,
            label: probed.provider.label,
            reason: providerFailureReason({ error: probed.error }),
          });
          continue;
        }

        if (probed.value === null) continue;

        for (const m of probed.value) models.push({ ...m, provider: probed.provider.id });
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
      // Sequential first-match scan in preference order; a throwing provider is skipped.
      for (const p of (await allProviders(deps)).providers) {
        try {
          if (!(await p.isAvailable(deps))) continue;
          const modelId = p.defaultModel ?? (await p.listModels(deps))[0]?.id;

          if (modelId) return `${p.id}/${modelId}`;
        } catch (error) {
          diagnostics.event('providers.default_model_unavailable', { error: renderThrownChain({ cause: error }) });
          continue;
        }
      }

      return null;
    },
  };
}
