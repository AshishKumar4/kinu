/**
 * Union of models available to a user, plus the connectable-provider catalog.
 * The provider registry is the source of truth for models; models.dev is the
 * source of truth for which providers a BYO API key can connect. This module
 * only shapes that data for HTTP clients.
 */
import {
  catalogCredKey, listModelsDevProviders, modelsDevCompatBaseURL,
  type ModelsDevProviderInfo, type ProviderFailure,
} from '@kinu.run/core';
import type { UserDO } from './user-do';
import { createAgentProviderRegistry } from '../providers/agent-registry';
import { retryTransientDO } from '../lib/do-rpc';
import type { UserCaller } from './workspace-capability';

export interface ModelMenuEntry {
  /** Full spec — `<provider>/<modelId>`, used as the agent_config.model value. */
  spec: string;
  /** Display label for the picker. */
  label: string;
  /** Provider id (codex, openai, anthropic, workers-ai, …). */
  provider: string;
  /** Capabilities — used by the UI to badge models. */
  capabilities?: string[];
  /** Provider-reported context window, when known. */
  contextWindow?: number;
}

/** The model menu as HTTP clients receive it: what can be picked, and which
 *  providers could not be reached (so the picker can say so instead of
 *  silently dropping them). */
export interface ModelMenuResponse {
  models: ModelMenuEntry[];
  failures: ProviderFailure[];
}

export async function listAvailableModels(env: Env, userId: string, caller: UserCaller): Promise<ModelMenuResponse> {
  // SAFETY: The UserDO namespace binding declares UserDO as its stub contract.
  const stub = env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
  const { registry, deps } = createAgentProviderRegistry({
    env,
    userDO: { stub, caller },
    fetch,
  });

  const menu = await registry.listAllModels(deps);
  const out = menu.models.map((model): ModelMenuEntry => ({
    spec: `${model.provider}/${model.id}`,
    label: model.label ?? model.id,
    provider: model.provider,
    capabilities: model.capabilities ? [...model.capabilities] : undefined,
    contextWindow: model.contextWindow,
  }));

  // openai-compat: user-named — we surface each as a single generic entry.
  // The agent_config.model can be set to `openai-compat:<name>/<modelId>`.
  // Retried: a dropped read here renders a user's connected accounts as none at
  // all, which sends them to re-authorise a provider they never lost.
  const creds = await retryTransientDO('listCredentials', () => stub.listCredentials(caller));
  for (const c of creds) {
    if (c.key.startsWith('openai-compat.')) {
      const name = c.key.slice('openai-compat.'.length);
      out.push({
        spec: `openai-compat:${name}/<modelId>`,
        label: `${name} (custom model id)`,
        provider: `openai-compat:${name}`,
        capabilities: ['tools', 'streaming'],
      });
    }
  }
  return { models: out, failures: menu.failures };
}

/** One connectable provider for the credential UX (BYO API key). */
export interface ProviderCatalogEntry {
  /** Provider id — also the model-spec prefix (`<id>/<modelId>`). */
  id: string;
  /** Credential key the API key is stored under. */
  credKey: string;
  name: string;
  doc?: string;
  /** Conventional env var name for the key (models.dev metadata). */
  envVar?: string;
  connected: boolean;
}

/** All providers a stored API key can connect: every models.dev provider the
 *  openai-compat path can drive, plus catalog providers a bespoke static
 *  provider serves under the same id/credKey (openai, anthropic, openrouter).
 *  OAuth-connected providers (workers-ai, codex) have their own flows. */
export function buildProviderCatalog(
  providers: readonly ModelsDevProviderInfo[],
  staticIds: ReadonlySet<string>,
  storedKeys: ReadonlySet<string>,
): ProviderCatalogEntry[] {
  return providers
    .filter((p) => modelsDevCompatBaseURL(p) !== null || staticIds.has(p.id))
    .map((p): ProviderCatalogEntry => {
      const credKey = catalogCredKey(p.id);
      return {
        id: p.id,
        credKey,
        name: p.name,
        doc: p.doc,
        envVar: p.env[0],
        connected: storedKeys.has(credKey),
      };
    })
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
}

export async function listProviderCatalog(env: Env, userId: string, caller: UserCaller): Promise<ProviderCatalogEntry[]> {
  // SAFETY: The UserDO namespace binding declares UserDO as its stub contract.
  const stub = env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
  const { registry } = createAgentProviderRegistry({ env, userDO: { stub, caller }, fetch });
  const [providers, creds] = await Promise.all([
    listModelsDevProviders({ fetch }),
    retryTransientDO('listCredentials', () => stub.listCredentials(caller)),
  ]);
  return buildProviderCatalog(
    providers,
    new Set(registry.list().map((p) => p.id)),
    new Set(creds.map((c) => c.key)),
  );
}
