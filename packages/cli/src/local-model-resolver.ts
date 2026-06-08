import { createLocalModelResolver, type LocalModelResolver } from '@proteus/cli-backend';
import type { LLMProviderConfig } from '@proteus/core';
import {
  createCodexAuthStore,
  resolveLLMConfig,
  resolveProviderCredentials,
} from './config.js';

export interface LocalModelResolverOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
}

export interface ConfiguredLocalModelResolver {
  llmConfig: LLMProviderConfig;
  resolver: LocalModelResolver;
}

export function createConfiguredLocalModelResolver(opts: LocalModelResolverOptions = {}): ConfiguredLocalModelResolver {
  const llmConfig = resolveLLMConfig(opts);
  const resolver = createLocalModelResolver({
    llm: llmConfig,
    credentials: resolveProviderCredentials(),
    codexAuthStore: createCodexAuthStore(),
  });
  return { llmConfig, resolver };
}

export function getConfiguredLocalModelSpec(opts: LocalModelResolverOptions = {}): string | null {
  try {
    return createConfiguredLocalModelResolver(opts).resolver.normalizeSpecSync(opts.model ?? null);
  } catch {
    return null;
  }
}
