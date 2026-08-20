import { createLocalModelResolver, type LocalModelResolver } from '@kinu/cli-backend';
import { agentAffinityKey, parseModelSpec, type LLMProviderConfig } from '@kinu/core';
import {
  createCodexAuthStore,
  resolveCloudSession,
  resolveLLMConfig,
  resolveProviderCredentials,
} from './config';
import { renderThrownChain } from '@kinu/core/obs';

export interface LocalModelResolverOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  /** Pins the agent's signed-in proxy turns to one Workers AI replica
   *  (x-session-affinity) — same `kinu-<name>` key cloud agents use. */
  agentName?: string;
}

export interface ConfiguredLocalModelResolver {
  llmConfig: LLMProviderConfig;
  resolver: LocalModelResolver;
}

/** Why a workspace's model cannot run yet, or null when it can. */
export interface UnusableModel {
  spec: string;
  /** Absent when resolution failed before any provider could be named. */
  provider?: string;
  reason: string;
}

/**
 * Whether a model spec has a usable credential path right now.
 *
 * A workspace could be created against a provider nothing had connected — most often a signed-in
 * account whose Cloudflare AI was never granted — and the only symptom was the first turn failing.
 * The provider registry already knows (`isAvailable` + `unavailableReason`); this asks it at
 * selection time. `listProviders` describes a provider (or catalog) it could not reach as
 * unavailable WITH a reason instead of rejecting, so there is no lookup failure to absorb here.
 */
export async function findUnusableModel(opts: LocalModelResolverOptions = {}): Promise<UnusableModel | null> {
  let resolver: LocalModelResolver;
  let spec: string;
  let provider: string;
  try {
    resolver = createConfiguredLocalModelResolver(opts).resolver;
    spec = resolver.normalizeSpecSync(opts.model ?? null);
    provider = parseModelSpec(spec).provider;
  } catch (error) {
    // Failing to resolve the model AT ALL is this function's answer, not a lookup it may shrug off:
    // null said "usable", and the workspace then died on its first turn with this very error.
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
