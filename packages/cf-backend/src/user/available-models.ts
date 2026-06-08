/**
 * Union of models available to a user. The provider registry is the source of
 * truth; this module only shapes registry output for HTTP clients.
 */
import type { UserDO } from './user-do.js';
import { createAgentProviderRegistry } from '../providers/agent-registry.js';

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

export { DEFAULT_WORKERS_AI_MODEL_SPEC } from '../providers/workers-ai-catalog.js';

export async function listAvailableModels(env: Env, userId: string): Promise<ModelMenuEntry[]> {
  const stub = env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
  const { registry, deps } = createAgentProviderRegistry({
    env,
    userDOStub: stub,
    fetch,
  });

  const out = (await registry.listAllModels(deps)).map((model): ModelMenuEntry => ({
    spec: `${model.provider}/${model.id}`,
    label: model.label ?? model.id,
    provider: model.provider,
    capabilities: model.capabilities ? [...model.capabilities] : undefined,
    contextWindow: model.contextWindow,
  }));

  // openai-compat: user-named — we surface each as a single generic entry.
  // The agent_config.model can be set to `openai-compat:<name>/<modelId>`.
  const creds = await stub.listCredentials();
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
  return out;
}
