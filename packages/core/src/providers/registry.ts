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
import { diagnostics, renderThrownChain } from '../obs/index';

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

/** A provider failure's whole chain, and never the empty string: a catalog row
 *  reading "" is indistinguishable from one that did not fail. The chain, not the
 *  outermost message, because a 401 wrapped in "models.dev fetch failed" used to
 *  arrive as the wrapper alone. */
export function providerFailureReason({ error }: { error: unknown }): string {
  return renderThrownChain({ cause: error }).trim() || 'unknown error';
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
  /**
   * Probe every provider AT ONCE, isolate each failure, and answer in
   * REGISTRATION ORDER.
   *
   * The listing methods below used to await each provider in a `for` loop, so
   * one slow vendor added its whole latency to every provider behind it — and
   * this call now sits in front of a turn's first token, where that sum is
   * time the user spends watching nothing. The probes are independent: no
   * provider's availability or model list is an input to another's.
   *
   * ORDER COMES FROM THE INPUT, NEVER FROM COMPLETION. `Promise.all` resolves
   * positionally, so the fast provider that finished first does not overtake
   * the slow one in the menu. A menu that reordered itself by whichever vendor
   * answered quickest would be a different list on every call, and callers
   * compare these lists.
   *
   * NO DEADLINE, deliberately: a provider is slow or it is broken, and a clock
   * here would convert "slow" into "absent", which downstream reads as a model
   * that does not exist. Failures are reported as failures.
   */
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
      // An UNAVAILABLE provider is not a failure — it is a provider nobody
      // connected — so it contributes neither models nor a row, exactly as the
      // sequential form did. `null` carries that "available: false" answer out
      // of the probe without a second call.
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
      // Preference order, first usable wins — a provider that throws is
      // skipped so a broken credential cannot leave the agent with no model.
      //
      // SEQUENTIAL ON PURPOSE, unlike the two listing methods above. This is a
      // first-match scan, not an enumeration: it stops at the first provider
      // that can serve, so it already does the least work available. Probing
      // them all at once would list models from providers whose answer is
      // never read, which costs requests and credentials to save latency the
      // short-circuit has usually already saved.
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
