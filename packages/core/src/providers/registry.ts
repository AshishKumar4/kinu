// ProviderRegistry: resolves "<provider>/<modelId>" synchronously; static providers win.

import { withModelStack } from './wire-model';
import { hashText } from '@kinu.run/agent-utils/memory';
import { bindModelAttempt, captureModelAttempt, type ModelAttemptIdentity } from './attempt-identity';
import type { LanguageModel } from 'ai';
import type {
  AuthResolution, ModelCallDeps, ModelProvider, ProviderDeps, ProviderInfo, ModelInfo,
} from './types';
import { parseModelSpec } from './types';
import { StaleModelList } from './util';
import { withModelsDevRead } from './models-dev';
import { Effect, Result } from 'effect';
import { diagnostics, KinuError, renderThrownChain, settle, settleSync } from '../obs/index';
import { accountCredentialKey, MAIN_ACCOUNT, storedAccounts } from '../credentials/accounts';

export interface DynamicProviderSource {
  readonly id: string;
  readonly label: string;
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
  /** The current credential snapshot, billed route and model the same retry lookup names. */
  attemptFor(spec: string, deps: ProviderDeps): Promise<ModelAttemptIdentity | null>;
}

const SLOW_LISTING_MS = 2_000;



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

  const answered = (key: string, auth: AuthResolution): AuthResolution => ({ ...auth, credentialKey: key });

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
  const dynamic: DynamicProviderSource[] = [];

  /** Secret-free prefix used by the pacer's cheap cooldown gate and the resolved billed lane. */
  const routeOf = (parsed: ReturnType<typeof parseModelSpec>, provider: ModelProvider): string =>
    JSON.stringify([parsed.provider, provider.laneOf?.(parsed.modelId) ?? parsed.provider]);

  async function resolvedAttempt(parsed: ReturnType<typeof parseModelSpec>, provider: ModelProvider, deps: ProviderDeps): Promise<ModelAttemptIdentity> {
    const key = provider.credentialKey;
    const auth = key === undefined ? null : await accountDeps(deps, parsed.provider, parsed.account).getAuth(key);

    return identityFromAuth(parsed, provider, auth);
  }

  async function identityFromAuth(parsed: ReturnType<typeof parseModelSpec>, provider: ModelProvider, auth: AuthResolution | null): Promise<ModelAttemptIdentity> {
    const route = routeOf(parsed, provider);
    const ref = auth?.credentialKey ?? null;

    const revision = auth === null ? 'environment' : await hashText(JSON.stringify({
      baseURL: auth.baseURL ?? null,
      headers: Object.entries(auth.headers).sort(([left], [right]) => left.localeCompare(right)),
    }));

    const credential = ref === null ? null : JSON.stringify([ref, revision]);

    return { lane: `${route}|${JSON.stringify([ref, revision])}`, modelId: parsed.modelId, credential, ref };
  }

  /** Static plus servable dynamic providers; a dynamic enumeration failure is one reported failure. */
  function allProviders(deps: ProviderDeps): Effect.Effect<{ providers: ModelProvider[]; failures: ProviderFailure[] }> {
    return Effect.gen(function* () {
      const providers = [...ordered];
      const failures: ProviderFailure[] = [];

      for (const source of dynamic) {
        const listed = yield* Effect.result(Effect.tryPromise({ try: () => source.listIds(deps), catch: (cause) => cause }));

        if (Result.isFailure(listed)) {
          failures.push({ provider: source.id, label: source.label, reason: providerFailureReason({ error: listed.failure }) });
          continue;
        }

        for (const id of listed.success) {
          const provider = providers.some((p) => p.id === id) ? undefined : source.get(id);

          if (provider) providers.push(provider);
        }
      }

      return { providers, failures };
    });
  }

  function providerFor(providerId: string): ModelProvider | undefined {
    return byId.get(providerId) ?? dynamic.reduce<ModelProvider | undefined>((found, source) => found ?? source.get(providerId), undefined);
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
      dynamic.push(source);
    },
    get(id) { return providerFor(id); },
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

    listAllModels(listing) {
      // The menu's listings run at once and read models.dev once between them: a read of this call's own.
      const deps = withModelsDevRead(listing);

      return settle(Effect.gen(function* () {
        const { providers, failures: sourceFailures } = yield* allProviders(deps);
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

        const slowest = probes.reduce<(typeof probes)[number] | null>((worst, probed) => (worst === null || probed.ms > worst.ms ? probed : worst), null);

        // A slow listing is one a dropped connection can cut; this names who held it.
        if (slowest !== null && slowest.ms >= SLOW_LISTING_MS) diagnostics.event('models.listing_slow', { provider: slowest.provider.id, ms: slowest.ms });

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
        ? Effect.sync(() => {
          const own = accountDeps(deps, parsed.provider, parsed.account);
          const attempt = () => resolvedAttempt(parsed, provider, deps);

          const inference = { ...own, getAuth: async (...args: Parameters<typeof own.getAuth>) => {
            const auth = await own.getAuth(...args);

            if (auth !== null) await captureModelAttempt(() => identityFromAuth(parsed, provider, auth));

            return auth;
          } };

          return bindModelAttempt(withModelStack(provider.createModel(parsed.modelId, inference), {
            provider: parsed.provider, modelId: parsed.modelId, lane: { route: routeOf(parsed, provider), billed: async () => (await attempt()).lane },
            ...(deps.onProviderWait !== undefined && { onWait: deps.onProviderWait }),
            ...(provider.streamsGenerate === true && { generateByStream: true }),
          }), attempt);
        })
        : Effect.die(new Error(`Unknown provider ${JSON.stringify(parsed.provider)} (registered: ${Array.from(byId.keys()).join(', ') || 'none'}).`)));
    },

    async attemptFor(spec, deps) {
      const parsed = parseModelSpec(spec);
      const provider = providerFor(parsed.provider);

      return provider === undefined ? null : resolvedAttempt(parsed, provider, deps);
    },
  };
}
