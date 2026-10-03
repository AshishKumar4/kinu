import { createLocalModelResolver, type LocalModelResolver } from '@kinu.run/cli-backend';
import { parseModelSpec, type LLMProviderConfig } from '@kinu.run/core';
import {
  createOAuthStore,
  resolveCloudSession,
  resolveLLMConfig,
  resolveProviderCredentials,
} from './config';
import { readDefaultTier } from './profiles';
import { Cause, Effect } from 'effect';
import { renderThrownChain, settle } from '@kinu.run/core/obs';

interface LocalModelResolverOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
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

export function findUnusableModel(opts: LocalModelResolverOptions = {}): Promise<UnusableModel | null> {
  return settle(Effect.gen(function* () {
    const resolved = yield* Effect.matchCause(Effect.sync(() => {
      const resolver = createConfiguredLocalModelResolver(opts).resolver;
      const spec = resolver.normalizeSpecSync(opts.model ?? null);

      return { resolver, spec, provider: parseModelSpec(spec).provider };
    }), {
      onSuccess: (named) => ({ named }),
      onFailure: (failed) => ({ unusable: { spec: opts.model ?? 'The configured model', reason: renderThrownChain({ cause: Cause.squash(failed) }) } }),
    });

    if ('unusable' in resolved) return resolved.unusable;
    const { resolver, spec, provider } = resolved.named;
    const info = (yield* Effect.promise(() => resolver.listProviders())).find((entry) => entry.id === provider);

    if (!info || info.available) return null;

    return { spec, provider, reason: info.unavailableReason ?? `No credential is connected for ${provider}.` };
  }));
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
  });

  return { llmConfig, resolver };
}
