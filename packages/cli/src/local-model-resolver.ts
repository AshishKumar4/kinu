import { createLocalModelResolver, type LocalModelResolver } from '@proteus/cli-backend';
import { agentAffinityKey, parseModelSpec, type LLMProviderConfig } from '@proteus/core';
import {
  createCodexAuthStore,
  resolveCloudSession,
  resolveLLMConfig,
  resolveProviderCredentials,
} from './config.js';

export interface LocalModelResolverOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  /** Pins the agent's signed-in proxy turns to one Workers AI replica
   *  (x-session-affinity) — same `proteus-<name>` key cloud agents use. */
  agentName?: string;
}

export interface ConfiguredLocalModelResolver {
  llmConfig: LLMProviderConfig;
  resolver: LocalModelResolver;
}

/** Why a workspace's model cannot run yet, or null when it can. */
export interface UnusableModel {
  spec: string;
  provider: string;
  reason: string;
}

/**
 * Whether a model spec has a usable credential path right now.
 *
 * A workspace could be created against a provider nothing had connected — most
 * often a signed-in account whose Cloudflare AI was never granted — and the
 * only symptom was the first turn failing. The provider registry already knows
 * (`isAvailable` + `unavailableReason`); this asks it at selection time.
 *
 * Null on any lookup failure: an unreachable provider catalog is not evidence
 * that the credential is missing, and a false alarm here would be worse than
 * silence.
 */
export async function findUnusableModel(opts: LocalModelResolverOptions = {}): Promise<UnusableModel | null> {
  try {
    const { resolver } = createConfiguredLocalModelResolver(opts);
    const spec = resolver.normalizeSpecSync(opts.model ?? null);
    const { provider } = parseModelSpec(spec);
    const info = (await resolver.listProviders()).find((entry) => entry.id === provider);
    if (!info || info.available) return null;
    return { spec, provider, reason: info.unavailableReason ?? `No credential is connected for ${provider}.` };
  } catch {
    return null;
  }
}

export function createConfiguredLocalModelResolver(opts: LocalModelResolverOptions = {}): ConfiguredLocalModelResolver {
  const llmConfig = resolveLLMConfig(opts);
  const cloud = resolveCloudSession();
  const resolver = createLocalModelResolver({
    llm: llmConfig,
    credentials: resolveProviderCredentials(),
    codexAuthStore: createCodexAuthStore(),
    cloud: cloud
      ? { ...cloud, sessionAffinity: opts.agentName ? agentAffinityKey(opts.agentName) : undefined }
      : undefined,
  });
  return { llmConfig, resolver };
}
