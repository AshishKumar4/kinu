// ProviderRegistry: resolves "<provider>/<modelId>" synchronously; static providers win.
import type { LanguageModel } from 'ai';
import type {
  AuthResolution, ModelProvider, ProviderDeps, ProviderInfo, ModelInfo,
} from './types';
import { parseModelSpec } from './types';
import { diagnostics, KinuError, renderThrownChain } from '../obs/index';
import { accountCredentialKey, MAIN_ACCOUNT, storedAccounts } from '../credentials/accounts';

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
  accounts?: Readonly<Record<string, readonly string[]>>;
}

export interface ProviderRegistry {
  register(provider: ModelProvider): void;
  registerDynamic(source: DynamicProviderSource): void;
  get(providerId: string): ModelProvider | undefined;
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

/** `named`, else `accountFor`'s, else `main`, else the only one; several unchosen: refused. */
export function accountDeps(deps: ProviderDeps, providerId: string, named?: string): ProviderDeps {
  const chosen = (): string | undefined => named ?? deps.accountFor?.(providerId);

  const soleKey = async (key: string): Promise<string | null> => {
    const accounts = storedAccounts(key, await deps.listCredentialKeys?.() ?? []);
    const [only, ...others] = accounts;

    if (only === undefined || only === MAIN_ACCOUNT) return null;

    if (others.length > 0) {
      throw new KinuError('bad_input', `${providerId} has the accounts ${accounts.join(', ')} and no default: `
        + `choose one in the providers settings or with \`kinu provider default ${providerId} <name>\`.`);
    }

    return accountCredentialKey(key, only);
  };

  const answered = (key: string, auth: AuthResolution): AuthResolution => {
    const stored: AuthResolution = { headers: auth.headers, credentialKey: key };

    if (auth.baseURL !== undefined) stored.baseURL = auth.baseURL;

    return stored;
  };

  return {
    ...deps,
    accountFor: undefined,
    async getAuth(key, opts) {
      const account = chosen();

      if (account !== undefined) {
        const stored = accountCredentialKey(key, account);
        const auth = await deps.getAuth(stored, opts);

        if (auth === null) throw new KinuError('missing', `No usable ${providerId} credential for the account "${account}".`);

        return answered(stored, auth);
      }

      const main = await deps.getAuth(key, opts);

      if (main !== null) return answered(key, main);
      const sole = await soleKey(key);

      if (sole === null) return null;
      const auth = await deps.getAuth(sole, opts);

      return auth === null ? null : answered(sole, auth);
    },
    async hasCredential(key) {
      const account = chosen();

      if (account !== undefined) return deps.hasCredential(accountCredentialKey(key, account));

      return await deps.hasCredential(key) || await soleKey(key) !== null;
    },
  };
}

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

  /** Probes concurrently, answering in registration order; no deadline, which would read slow as absent. */
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
        const own = accountDeps(deps, p.id);
        const available = await p.isAvailable(own);
        const info: ProviderInfo = { id: p.id, label: p.label, available };

        if (!available && p.unavailableReason) info.unavailableReason = await p.unavailableReason(own);

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
      const keys = await deps.listCredentialKeys?.() ?? [];

      const accounts = Object.fromEntries(providers.flatMap((p) => {
        const stored = p.credentialKey === undefined ? [] : storedAccounts(p.credentialKey, keys);

        return stored.length === 0 ? [] : [[p.id, stored]];
      }));

      // `null`: unavailable, which is not a failure.
      for (const probed of await probeEach(providers, async (p) => {
        const own = accountDeps(deps, p.id);

        return await p.isAvailable(own) ? await p.listModels(own) : null;
      })) {
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

      return { models, failures, accounts };
    },

    resolve(spec, deps) {
      const parsed = parseModelSpec(spec);
      const provider = providerFor(parsed.provider);

      if (!provider) {
        const known = Array.from(byId.keys()).join(', ');
        throw new Error(`Unknown provider ${JSON.stringify(parsed.provider)} (registered: ${known || 'none'}).`);
      }

      return provider.createModel(parsed.modelId, accountDeps(deps, parsed.provider, parsed.account));
    },

    async defaultSpec(deps) {
      // Sequential first-match scan in preference order; a throwing provider is skipped.
      for (const p of (await allProviders(deps)).providers) {
        try {
          const own = accountDeps(deps, p.id);

          if (!(await p.isAvailable(own))) continue;
          const modelId = p.defaultModel ?? (await p.listModels(own))[0]?.id;

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
