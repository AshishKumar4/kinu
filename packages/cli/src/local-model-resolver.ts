import { createLocalModelResolver, type LocalModelResolver } from '@kinu.run/cli-backend';
import { agentAffinityKey, parseModelSpec, type LLMProviderConfig } from '@kinu.run/core';
import {
  createOAuthStore,
  resolveCloudSession,
  resolveLLMConfig,
  resolveProviderCredentials,
} from './config';
import { readDefaultTier } from './profiles';
import { renderThrownChain } from '@kinu.run/core/obs';

interface LocalModelResolverOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  /** Pins signed-in proxy turns to one Workers AI replica (x-session-affinity). */
  agentName?: string;
}

interface ConfiguredLocalModelResolver {
  /** Default endpoint for bare ids, or null. */
  llmConfig: LLMProviderConfig | null;
  resolver: LocalModelResolver;
}


interface UnusableModel {
  spec: string;
  /** Absent when resolution failed before any provider could be named. */
  provider?: string;
  reason: string;
}

export async function findUnusableModel(opts: LocalModelResolverOptions = {}): Promise<UnusableModel | null> {
  let resolver: LocalModelResolver;
  let spec: string;
  let provider: string;

  try {
    resolver = createConfiguredLocalModelResolver(opts).resolver;
    spec = resolver.normalizeSpecSync(opts.model ?? null);
    provider = parseModelSpec(spec).provider;
  } catch (error) {
    return {
      spec: opts.model ?? 'The configured model',
      reason: renderThrownChain({ cause: error }),
    };
  }

  const info = (await resolver.listProviders()).find((entry) => entry.id === provider);

  if (!info || info.available) return null;

  return { spec, provider, reason: info.unavailableReason ?? `No credential is connected for ${provider}.` };
}

export function createConfiguredLocalModelResolver(opts: LocalModelResolverOptions = {}): ConfiguredLocalModelResolver {
  // A null endpoint only removes the bare-id default.
  const llmConfig = resolveLLMConfig({ ...opts, defaultModel: readDefaultTier()?.model });
  const cloud = resolveCloudSession();

  const resolver = createLocalModelResolver({
    llm: llmConfig,
    credentials: resolveProviderCredentials(),
    oauthStore: createOAuthStore(),
    cloud: cloud ?? undefined,
    sessionAffinity: opts.agentName ? agentAffinityKey(opts.agentName) : undefined,
  });

  return { llmConfig, resolver };
}
