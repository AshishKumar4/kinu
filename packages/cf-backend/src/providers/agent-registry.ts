// Per-agent provider registry over core's (`createModelRegistry`); auth goes through the UserDO stub.
import {
  createAIGatewayProvider, createChatGptProvider, createCodexProvider, createModelRegistry, createMyGatewayProvider,
  createWorkersAIProvider, normalizeModelSpec,
  bindingDecisionRun, restDecisionRun, type DecisionRun,
  type ActorReference, type AuthRequest, type AuthResolution, type AuthResolver, type ModelAffinity, type ProviderDeps, type ProviderEnv,
  type ProviderRegistry, type ProviderWaitInfo, type SpecDefault, type UserCaller,
  accountDeps, countRequestInputTokens, parseModelSpec, type TurnModelSources, type CredentialSummary,
} from '@kinu.run/core';
import type { LanguageModel } from 'ai';
import { deviceRouteFetch, type ModelRelayHub } from '../egress/model-relay-route';
import { idempotent } from '@nimbus-sh/fabric/do-calls.js';
import { logDoCallRetry } from '../obs/do-call-retry';

/** Credential and relay methods on UserDO; each call presents its caller's capability. */
export interface UserCredentialClient extends ModelRelayHub {
  getAuth(caller: UserCaller, key: string, opts?: AuthRequest): Promise<AuthResolution | null>;
  listCredentials(caller: UserCaller): Promise<CredentialSummary[]>;
}

export interface UserCredentialSource {
  getAuth: AuthResolver;
  listCredentials(this: void): Promise<CredentialSummary[]>;
  hub(): ModelRelayHub;
  caller(this: void): Promise<UserCaller>;
}

export function userCredentials(resolve: () => UserCredentialClient, authority: UserCaller | (() => Promise<UserCaller>)): UserCredentialSource {
  const identity = async (): Promise<UserCaller> => authority instanceof Function ? await authority() : authority;

  return {
    caller: identity,
    hub: resolve,
    getAuth: async (key, opts) => {
      const caller = await identity();
      // Rotation persists before answering; a repeat reads it, while a spent but unpersisted token is already lost.

      return await idempotent('credential auth', resolve, (stub) => stub.getAuth(caller, key, opts), { onRetry: logDoCallRetry });
    },
    listCredentials: async () => {
      const caller = await identity();

      return await idempotent('credential listing', resolve, (stub) => stub.listCredentials(caller), { onRetry: logDoCallRetry });
    },
  };
}

/** Taken from the consuming provider: the direct path calls `run`, which a gateway-only env lacks. */
type DirectAiBinding =
  NonNullable<ProviderEnv['AI']> & NonNullable<Parameters<typeof createWorkersAIProvider>[0]>;

function isDirectAiBinding(binding: NonNullable<ProviderEnv['AI']>): binding is DirectAiBinding {
  return 'run' in binding;
}

export interface AgentProviderDeps {
  env: ProviderEnv;
  /** Null for env-bound-only contexts (e.g. runtime.ts inline-branch fallback): getAuth is null, hasCredential false. */
  userDO?: UserCredentialSource | null;
  fetch?: typeof fetch;
  /** Fires before a provider-mandated wait; the actor emits `provider_wait` so a rate-limited turn reads as waiting. */
  onProviderWait?: (info: ProviderWaitInfo) => void;
  appTitle?: string;
  accountFor?: (providerId: string) => string | undefined;
  currentTurn?: (actor: ActorReference) => string | null;
}

export interface AgentProviderRegistry {
  registry: ProviderRegistry;
  deps: ProviderDeps;
  /** `affinity`: the conversation and workspace the calls are routed and cached under (`actorAffinity`). */
  resolveModel(spec: string, affinity: ModelAffinity): LanguageModel;
  /** A `provider/model` spec, or a bare `@cf/...` Workers AI id. */
  normalizeSpecSync(spec: string): string;
}

export function routedModelReads(providers: AgentProviderRegistry): NonNullable<TurnModelSources['routed']> {
  return {
    attemptFor: (spec) => providers.registry.attemptFor(providers.normalizeSpecSync(spec), providers.deps),
    countInputTokens: (spec, request) => {
      const counted = parseModelSpec(spec);

      return countRequestInputTokens(providers.registry.get(counted.provider), counted.modelId, accountDeps(providers.deps, counted.provider, counted.account), request);
    },
  };
}

/** The decision model's transport: the deployment's Workers AI binding when it pays, else the owner's Cloudflare login. */
export function decisionRunOf(opts: Pick<AgentProviderDeps, 'env' | 'userDO'>): DecisionRun {
  const binding = opts.env.WORKERS_AI_VIA_BINDING === 'on' && opts.env.AI && isDirectAiBinding(opts.env.AI) ? opts.env.AI : null;

  return binding === null
    ? restDecisionRun({ getAuth: opts.userDO?.getAuth ?? (async () => null) })
    : bindingDecisionRun(binding);
}

export function providerBindingsOf(env: ProviderEnv): ProviderEnv {
  return { AI: env.AI, AI_GATEWAY_URL: env.AI_GATEWAY_URL, WORKERS_AI_VIA_BINDING: env.WORKERS_AI_VIA_BINDING };
}

export function createAgentProviderRegistry(opts: AgentProviderDeps): AgentProviderRegistry {
  let deploymentBinding: DirectAiBinding | undefined;

  if (opts.env.WORKERS_AI_VIA_BINDING === 'on' && opts.env.AI && isDirectAiBinding(opts.env.AI)) {
    deploymentBinding = opts.env.AI;
  }

  const source = opts.userDO ?? null;

  const relayed = source === null ? null : {
    hub: source.hub(), caller: source.caller, ...(opts.currentTurn !== undefined && { currentTurn: opts.currentTurn }),
  };

  const registry = createModelRegistry({
    workersAi: createWorkersAIProvider(deploymentBinding),
    myGateway: createMyGatewayProvider(),
    aiGateway: createAIGatewayProvider(),
    // An account's own ChatGPT login wins; without one, the machine that signed in carries the call.
    chatgpt: relayed === null ? undefined : createChatGptProvider({
      device: {
        fetch: deviceRouteFetch({ ...relayed, provider: 'chatgpt' }),
        unavailableReason: async () => (await relayed.hub.relayDevice(await relayed.caller(), 'chatgpt') === null
          ? 'Sign in with ChatGPT to use your ChatGPT plan.'
          : undefined),
      },
    }),
    // chatgpt.com refuses Workers: the account's connected machine carries every Codex call, or none does.
    codex: createCodexProvider(relayed === null ? {} : { egress: deviceRouteFetch({ ...relayed, provider: 'codex' }) }),
    opencode: undefined,
    appTitle: opts.appTitle,
  });

  const getAuth = source?.getAuth ?? (async () => null);
  // Read once per registry: a listing asks about every provider, and a registry lives one call, or until the
  // account's credentials change (`OwnedModelServices.invalidate`).
  let keys: string[] | undefined;

  const credentialKeys = async (): Promise<string[]> => {
    if (!source) return [];

    if (keys !== undefined) return keys;
    const credentials = await source.listCredentials();

    keys = credentials.map((c) => c.key);

    return keys;
  };

  const deps: ProviderDeps = {
    env: opts.env,
    getAuth,
    hasCredential: async (key: string) => (await credentialKeys()).includes(key),
    listCredentialKeys: credentialKeys,
    fetch: opts.fetch,
    onProviderWait: opts.onProviderWait,
    accountFor: opts.accountFor,
  };

  const fallback: SpecDefault = { spec: null, missing: 'A model spec names its provider ("provider/model"); an unpinned actor runs on its profile\'s tier model.' };

  return {
    registry,
    deps,

    resolveModel(spec, affinity): LanguageModel {
      return registry.resolve(spec, { ...deps, ...affinity });
    },

    normalizeSpecSync: (spec) => normalizeModelSpec(spec, registry, fallback),
  };
}
