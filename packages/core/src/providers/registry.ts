// ProviderRegistry: resolves "<provider>/<modelId>" synchronously; static providers win.
import { withToolResultImages } from './tool-result-images';
import type { LanguageModel } from 'ai';
import type {
  AuthResolution, ModelCallDeps, ModelProvider, ProviderDeps, ProviderInfo, ModelInfo,
} from './types';
import { parseModelSpec } from './types';
import { StaleModelList } from './util';
import { Effect, Result } from 'effect';
import { diagnostics, KinuError, renderThrownChain, settle, settleSync } from '../obs/index';
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
  resolve(spec: string, deps: ModelCallDeps): LanguageModel;
  /** The stored credential `spec` authenticates with, found without authenticating; null when none would serve. */
  credentialFor(spec: string, deps: ProviderDeps): Promise<string | null>;
}

const CATALOG_SOURCE_ID = 'catalog';

const SLOW_LISTING_MS = 2_000;

/** As {@link accountDeps} picks, without authenticating; null where it finds none or refuses. */
async function chosenCredentialKey(deps: ProviderDeps, providerId: string, key: string, named?: string): Promise<string | null> {
  const chosen = named ?? deps.accountFor?.(providerId);

  if (chosen !== undefined) return accountCredentialKey(key, chosen);

  if (await deps.hasCredential(key)) return key;
  const [only, ...others] = storedAccounts(key, await deps.listCredentialKeys?.() ?? []);

  return only === undefined || only === MAIN_ACCOUNT || others.length > 0 ? null : accountCredentialKey(key, only);
}

/** `named`, else `accountFor`'s, else `main`, else the only one; several unchosen: refused. */
export function accountDeps<Deps extends ProviderDeps>(deps: Deps, providerId: string, named?: string): Deps {
  const chosen = (): string | undefined => named ?? deps.accountFor?.(providerId);

  const soleKey = (key: string): Effect.Effect<string | null, KinuError> => Effect.gen(function* () {
    const accounts = storedAccounts(key, (yield* Effect.promise(async () => deps.listCredentialKeys?.())) ?? []);
    const [only, ...others] = accounts;

    if (only === undefined || only === MAIN_ACCOUNT) return null;

    if (others.length > 0) {
      return yield* new KinuError('bad_input', `${providerId} has the accounts ${accounts.join(', ')} and none is its default.`);
    }

    return accountCredentialKey(key, only);
  });

  const answered = (key: string, auth: AuthResolution): AuthResolution => {
    const stored: AuthResolution = { headers: auth.headers, credentialKey: key };

    if (auth.baseURL !== undefined) stored.baseURL = auth.baseURL;

    return stored;
  };

  return {
    ...deps,
    accountFor: undefined,
    getAuth(key, opts) {
      return settle(Effect.gen(function* () {
        const account = chosen();

        if (account !== undefined) {
          const stored = accountCredentialKey(key, account);
          const auth = yield* Effect.promise(() => deps.getAuth(stored, opts));

          if (auth === null) return yield* new KinuError('missing', `No usable ${providerId} credential for the account "${account}".`);

          return answered(stored, auth);
        }

        const main = yield* Effect.promise(() => deps.getAuth(key, opts));

        if (main !== null) return answered(key, main);
        const sole = yield* soleKey(key);

        if (sole === null) return null;
        const auth = yield* Effect.promise(() => deps.getAuth(sole, opts));

        return auth === null ? null : answered(sole, auth);
      }));
    },
    hasCredential(key) {
      return settle(Effect.gen(function* () {
        const account = chosen();

        if (account !== undefined) return yield* Effect.promise(() => deps.hasCredential(accountCredentialKey(key, account)));

        return (yield* Effect.promise(() => deps.hasCredential(key))) || (yield* soleKey(key)) !== null;
      }));
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
  function allProviders(deps: ProviderDeps): Effect.Effect<{ providers: ModelProvider[]; failures: ProviderFailure[] }> {
    const providers = [...ordered];
    const source = dynamic;

    if (!source) return Effect.succeed({ providers, failures: [] });

    return Effect.match(Effect.tryPromise({ try: () => source.listIds(deps), catch: (cause) => ({ cause }) }), {
      onSuccess: (ids) => {
        for (const id of ids) {
          if (byId.has(id)) continue;
          const provider = source.get(id);

          if (provider) providers.push(provider);
        }

        return { providers, failures: [] };
      },
      onFailure: (failed) => ({
        providers,
        failures: [{ provider: CATALOG_SOURCE_ID, label: 'models.dev catalog', reason: providerFailureReason({ error: failed.cause }) }],
      }),
    });
  }

  function providerFor(providerId: string): ModelProvider | undefined {
    return byId.get(providerId) ?? dynamic?.get(providerId);
  }

  /** Probes concurrently, answering in registration order; no deadline, which would read slow as absent. */
  function probeEach<T>(
    providers: readonly ModelProvider[],
    probe: (provider: ModelProvider) => Promise<T>,
  ): Effect.Effect<Array<{ readonly provider: ModelProvider; readonly result: Result.Result<T, unknown>; readonly ms: number }>> {
    return Effect.forEach(providers, (provider) => {
      const started = Date.now();

      return Effect.map(
        Effect.result(Effect.tryPromise({ try: () => probe(provider), catch: (cause) => cause })),
        (result) => ({ provider, result, ms: Date.now() - started }),
      );
    }, { concurrency: 'unbounded' });
  }

  return {
    register(provider) {
      return settleSync(byId.has(provider.id)
        ? Effect.die(new Error(`Provider ${provider.id} already registered`))
        : Effect.sync(() => {
          byId.set(provider.id, provider);
          ordered.push(provider);
        }));
    },
    registerDynamic(source) {
      return settleSync(dynamic
        ? Effect.die(new Error('Dynamic provider source already registered'))
        : Effect.sync(() => { dynamic = source; }));
    },
    get(id) { return byId.get(id); },
    canResolve(id) { return providerFor(id) !== undefined; },

    list() { return [...ordered]; },

    listProviders(deps) {
      return settle(Effect.gen(function* () {
        const { providers, failures } = yield* allProviders(deps);
        const out: ProviderInfo[] = [];

        for (const probed of yield* probeEach(providers, async (p) => {
          const own = accountDeps(deps, p.id);
          const available = await p.isAvailable(own);
          const info: ProviderInfo = { id: p.id, label: p.label, available };

          if (!available && p.unavailableReason) info.unavailableReason = await p.unavailableReason(own);

          return info;
        })) {
          out.push(Result.isSuccess(probed.result) ? probed.result.success : {
            id: probed.provider.id,
            label: probed.provider.label,
            available: false,
            unavailableReason: providerFailureReason({ error: probed.result.failure }),
          });
        }

        for (const failure of failures) {
          out.push({ id: failure.provider, label: failure.label, available: false, unavailableReason: failure.reason });
        }

        return out;
      }));
    },

    listAllModels(deps) {
      return settle(Effect.gen(function* () {
        const started = Date.now();
        const { providers, failures: sourceFailures } = yield* allProviders(deps);
        const catalogMs = Date.now() - started;
        const models: Array<ModelInfo & { provider: string }> = [];
        const failures = [...sourceFailures];
        const keys = (yield* Effect.promise(async () => deps.listCredentialKeys?.())) ?? [];

        const accounts = Object.fromEntries(providers.flatMap((p) => {
          const stored = p.credentialKey === undefined ? [] : storedAccounts(p.credentialKey, keys);

          return stored.length === 0 ? [] : [[p.id, stored]];
        }));

        // `null`: unavailable, which is not a failure.
        const probes = yield* probeEach(providers, async (p) => {
          const own = accountDeps(deps, p.id);

          return await p.isAvailable(own) ? await p.listModels(own) : null;
        });

        const slowest = probes.reduce((worst, probed) => (probed.ms > worst.ms ? { provider: probed.provider.id, ms: probed.ms } : worst), { provider: CATALOG_SOURCE_ID, ms: catalogMs });

        // A slow listing is one a dropped connection can cut; this names who held it.
        if (slowest.ms >= SLOW_LISTING_MS) diagnostics.event('models.listing_slow', slowest);

        for (const probed of probes) {
          if (Result.isFailure(probed.result)) {
            const error = probed.result.failure;

            if (error instanceof StaleModelList) {
              for (const m of error.models) models.push({ ...m, provider: probed.provider.id });
            }

            failures.push({ provider: probed.provider.id, label: probed.provider.label, reason: providerFailureReason({ error }) });
            continue;
          }

          for (const m of probed.result.success ?? []) models.push({ ...m, provider: probed.provider.id });
        }

        return { models, failures, accounts };
      }));
    },

    resolve(spec, deps) {
      const parsed = parseModelSpec(spec);
      const provider = providerFor(parsed.provider);

      return settleSync(provider
        ? Effect.sync(() => withToolResultImages(provider.createModel(parsed.modelId, accountDeps(deps, parsed.provider, parsed.account))))
        : Effect.die(new Error(`Unknown provider ${JSON.stringify(parsed.provider)} (registered: ${Array.from(byId.keys()).join(', ') || 'none'}).`)));
    },

    async credentialFor(spec, deps) {
      const parsed = parseModelSpec(spec);
      const key = providerFor(parsed.provider)?.credentialKey;

      return key === undefined ? null : chosenCredentialKey(deps, parsed.provider, key, parsed.account);
    },
  };
}
