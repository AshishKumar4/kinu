// Workers AI defaults.
export const DEFAULT_WORKERS_AI_MODEL_ID = '@cf/zai-org/glm-5.3';

export const DEFAULT_WORKERS_AI_MODEL_SPEC = `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`;

/** The provider id Workers AI models are specced under. */
export const WORKERS_AI_PROVIDER_ID = 'workers-ai';

/** Cloudflare's catalog namespace: such an id is always a Workers AI model. */
export const WORKERS_AI_MODEL_ID_PREFIX = '@cf/';

/** Qualify a Workers AI model into a `<provider>/<modelId>` spec, idempotently. */
export function workersAiSpec(modelOrSpec: string): string {
  return modelOrSpec.startsWith(`${WORKERS_AI_PROVIDER_ID}/`)
    ? modelOrSpec
    : `${WORKERS_AI_PROVIDER_ID}/${modelOrSpec}`;
}

/** Per-agent session-affinity key pinning turns to one replica so the prefix cache hits. */
export function agentAffinityKey(name: string): string {
  return `kinu-${name}`;
}
