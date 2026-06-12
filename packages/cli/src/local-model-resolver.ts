import { createLocalModelResolver, type LocalModelResolver } from '@proteus/cli-backend';
import { agentAffinityKey, type LLMProviderConfig } from '@proteus/core';
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
