/** Model menu and connectable-provider catalog for HTTP clients. The provider registry is the
 *  source of truth for models; models.dev for which providers a BYO key can connect. */
import {
  catalogCredKey, listModelsDevProviders, modelsDevCompatBaseURL, openAICompatNameOf, testModel,
  type ModelTestResult, type ModelsDevProviderInfo, type ProviderFailure, type ReasoningEffort,
} from '@kinu.run/core';
import { createAgentProviderRegistry, type UserCredentialClient } from '../providers/agent-registry';
import type { ObjectNamespace } from '@kinu.run/core';
import type { ProviderEnv } from '@kinu.run/core';
import { retryTransientDO } from '@kinu.run/core';
import type { UserCaller } from '@kinu.run/core';
import type { CodexEgressNamespace } from '../egress/codex-egress-route';

export interface ModelMenuEntry {
  /** `<provider>/<modelId>`, used as the actor_config.model value. */
  spec: string;
  label: string;
  provider: string;
  providerLabel?: string;
  capabilities?: string[];
  contextWindow?: number;
  /** The settings control renders exactly these after "model default". */
  reasoningEfforts?: readonly ReasoningEffort[];
}

/** `failures` lists unreachable providers so the picker can say so instead of dropping them. */
export interface ModelMenuResponse {
  models: ModelMenuEntry[];
  failures: ProviderFailure[];
  accounts?: Readonly<Record<string, readonly string[]>>;
}

export interface AvailableModelsEnv<Id> extends ProviderEnv {
  CodexEgress?: CodexEgressNamespace;
  UserDO: ObjectNamespace<Id, UserCredentialClient>;
}

export async function listAvailableModels<Id>(
  env: AvailableModelsEnv<Id>, userId: string, caller: UserCaller,
): Promise<ModelMenuResponse> {
  const stub = env.UserDO.get(env.UserDO.idFromName(userId));

  const { registry, deps } = createAgentProviderRegistry({
    env,
    ownerUserId: userId,
    userDO: { stub, caller },
    fetch,
  });

  const menu = await registry.listAllModels(deps);

  const out = menu.models.map((model): ModelMenuEntry => ({
    spec: `${model.provider}/${model.id}`,
    label: model.label ?? model.id,
    provider: model.provider,
    providerLabel: registry.get(model.provider)?.label,
    capabilities: model.capabilities ? [...model.capabilities] : undefined,
    contextWindow: model.contextWindow,
    reasoningEfforts: model.reasoningEfforts,
  }));

  // openai-compat providers are user-named; each surfaces as one entry (`openai-compat:<name>/<modelId>`).
  // Retried: a dropped read would show no connected accounts and prompt needless re-authorisation.
  const creds = await retryTransientDO('listCredentials', () => stub.listCredentials(caller));

  const compatNames = new Set(creds.flatMap((c) => openAICompatNameOf(c.key) ?? []));

  for (const name of compatNames) {
    out.push({
      spec: `openai-compat:${name}/<modelId>`,
      label: `${name} (custom model id)`,
      provider: `openai-compat:${name}`,
      capabilities: ['tools', 'streaming'],
    });
  }

  return { models: out, failures: menu.failures, ...(menu.accounts !== undefined && { accounts: menu.accounts }) };
}

export interface ProviderCatalogEntry {
  /** Also the model-spec prefix (`<id>/<modelId>`). */
  id: string;
  credKey: string;
  name: string;
  doc?: string;
  /** From models.dev metadata. */
  envVar?: string;
  connected: boolean;
}

/** models.dev providers the openai-compat path can drive, plus those a static provider serves under
 * the same id/credKey. OAuth providers (workers-ai, codex) have their own flows. */
function buildProviderCatalog(
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

export async function listProviderCatalog<Id>(
  env: AvailableModelsEnv<Id>, userId: string, caller: UserCaller,
): Promise<ProviderCatalogEntry[]> {
  const stub = env.UserDO.get(env.UserDO.idFromName(userId));
  const { registry } = createAgentProviderRegistry({ env, ownerUserId: userId, userDO: { stub, caller }, fetch });

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

export async function testAvailableModel<Id>(input: {
  readonly env: AvailableModelsEnv<Id>;
  readonly userId: string;
  readonly caller: UserCaller;
  readonly spec: string;
  readonly signal: AbortSignal;
}): Promise<ModelTestResult> {
  const { env, userId, caller } = input;
  const stub = env.UserDO.get(env.UserDO.idFromName(userId));
  const registry = createAgentProviderRegistry({ env, ownerUserId: userId, userDO: { stub, caller }, fetch });

  return testModel({ model: registry.resolveModel(input.spec), signal: input.signal });
}
