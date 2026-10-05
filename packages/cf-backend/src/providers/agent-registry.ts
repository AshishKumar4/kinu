// Per-agent provider registry over core's (`createModelRegistry`); auth goes through the UserDO stub.
import {
  AI_GATEWAY_PROVIDER_ID, DEFAULT_WORKERS_AI_MODEL_SPEC,
  createAIGatewayProvider, createChatGptProvider, createCodexProvider, createModelRegistry, createMyGatewayProvider,
  createWorkersAIProvider, normalizeModelSpec, resolvePlatformGateway, retryTransientDO,
  bindingDecisionRun, restDecisionRun, type DecisionRun,
  type ActorReference, type AuthRequest, type AuthResolution, type AuthResolver, type ProviderDeps, type ProviderEnv,
  type ProviderRegistry, type ProviderWaitInfo, type SpecDefault, type UserCaller,
} from '@kinu.run/core';
import type { LanguageModel } from 'ai';
import type { CredentialSummary } from '../user/user-do';
import { codexEgressFetch, deviceRouteFetch, type CodexEgressNamespace, type ModelRelayHub } from '../egress/codex-egress-route';

/**
 * Credential DO stub paired with the capability this context presents (owner, or workspace token resolved per call),
 * so no context holds the stub without saying who it is.
 */
export interface UserCredentialClient extends ModelRelayHub {
  getAuth(caller: UserCaller, key: string, opts?: AuthRequest): Promise<AuthResolution | null>;
  listCredentials(caller: UserCaller): Promise<CredentialSummary[]>;
}

export interface UserCredentialSource {
  stub: UserCredentialClient;
  caller: UserCaller | (() => Promise<UserCaller>);
}

/** Taken from the consuming provider: the direct path calls `run`, which a gateway-only env lacks. */
type DirectAiBinding =
  NonNullable<ProviderEnv['AI']> & NonNullable<Parameters<typeof createWorkersAIProvider>[0]>;

function isDirectAiBinding(binding: NonNullable<ProviderEnv['AI']>): binding is DirectAiBinding {
  return 'run' in binding;
}

export interface AgentProviderDeps {
  env: ProviderEnv & { readonly CodexEgress?: CodexEgressNamespace };
  ownerUserId?: string | null;
  /** Null for env-bound-only contexts (e.g. runtime.ts inline-branch fallback): getAuth is null, hasCredential false. */
  userDO?: UserCredentialSource | null;
  fetch?: typeof fetch;
  /** Fires before a provider-mandated wait; the actor emits `provider_wait` so a rate-limited turn reads as waiting. */
  onProviderWait?: (info: ProviderWaitInfo) => void;
  appTitle?: string;
  accountFor?: (providerId: string) => string | undefined;
  currentTurn?: (actor: ActorReference) => string | null;
  codexContainer?: typeof fetch;
}

export interface AgentProviderRegistry {
  registry: ProviderRegistry;
  deps: ProviderDeps;
  /** `conversation`: the affinity key (`agentAffinityKey`) the calls are routed and cached under. */
  resolveModel(spec: string, conversation: string): LanguageModel;
  /** Empty input is the platform default (native Workers AI), never a survey of stored BYO credentials. Also accepts bare `@cf/...` and bare model ids. */
  normalizeSpecSync(specOrNull?: string | null): string;
}

async function resolveCaller(source: UserCredentialSource): Promise<UserCaller> {
  return source.caller instanceof Function ? await source.caller() : source.caller;
}

/** Proxies to UserDO so no credential material touches the caller; the DO serializes concurrent refreshes. Null source: every lookup null. */
export function createUserDOAuthResolver(source: UserCredentialSource | null): AuthResolver {
  return async (key, opts) => {
    if (!source) return null;
    const caller = await resolveCaller(source);

    // Retry-safe: the conditional OAuth refresh persists before returning.
    return await retryTransientDO('credential auth', () => source.stub.getAuth(caller, key, opts));
  };
}

/** The decision model's transport: the deployment's Workers AI binding when it pays, else the owner's Cloudflare login. */
export function decisionRunOf(opts: Pick<AgentProviderDeps, 'env' | 'userDO'>): DecisionRun {
  const binding = opts.env.WORKERS_AI_VIA_BINDING === 'on' && opts.env.AI && isDirectAiBinding(opts.env.AI) ? opts.env.AI : null;

  return binding === null
    ? restDecisionRun({ getAuth: createUserDOAuthResolver(opts.userDO ?? null) })
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

  const container = opts.codexContainer ?? (opts.env.CodexEgress !== undefined && opts.ownerUserId
    ? codexEgressFetch(opts.env.CodexEgress, opts.ownerUserId)
    : undefined);

  const relayed = source === null ? null : {
    hub: source.stub, caller: () => resolveCaller(source), ...(opts.currentTurn !== undefined && { currentTurn: opts.currentTurn }),
  };

  const codexEgress = relayed === null ? container : deviceRouteFetch({ ...relayed, provider: 'codex', container: container ?? opts.fetch ?? fetch });

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
    codex: createCodexProvider(codexEgress === undefined ? {} : { egress: codexEgress }),
    opencode: undefined,
    appTitle: opts.appTitle,
  });

  const getAuth = createUserDOAuthResolver(source);
  // Read once per registry: a listing asks about every provider, and a registry lives one call, or until the
  // account's credentials change (`OwnedModelServices.invalidate`).
  let keys: string[] | undefined;

  const credentialKeys = async (): Promise<string[]> => {
    if (!source) return [];

    if (keys !== undefined) return keys;
    const caller = await resolveCaller(source);

    const credentials = await retryTransientDO('credential listing',
      () => source.stub.listCredentials(caller));

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

  // Without a UserDO stub, workers-ai is a guaranteed 401, so the default falls back to the env-bound ai-gateway.
  const platform = resolvePlatformGateway(opts.env);
  const gatewayDefault = 'reason' in platform ? null : `${AI_GATEWAY_PROVIDER_ID}/${DEFAULT_WORKERS_AI_MODEL_SPEC}`;

  const fallback: SpecDefault = {
    spec: source === null ? gatewayDefault : DEFAULT_WORKERS_AI_MODEL_SPEC,
    missing: 'No default provider available (need a UserDO credential stub for workers-ai, '
      + `or a usable platform gateway: ${'reason' in platform ? platform.reason : ''})`,
  };

  return {
    registry,
    deps,

    resolveModel(spec, conversation): LanguageModel {
      return registry.resolve(spec, { ...deps, sessionAffinity: conversation });
    },

    normalizeSpecSync: (specOrNull) => normalizeModelSpec(specOrNull, registry, fallback),
  };
}
