// Workers AI platform defaults. The runtime provider implementation is
// CF-specific (cf-backend/src/providers/workers-ai.ts); the default model id
// is shared platform knowledge: cf-backend seeds new agents with it, the CLI
// seeds local agents and ranks model menus by it, and cli-backend uses it as
// the branch-worker fallback.
export const DEFAULT_WORKERS_AI_MODEL_ID = '@cf/deepseek-ai/deepseek-v4-pro-0813';
export const DEFAULT_WORKERS_AI_MODEL_SPEC = `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`;

/** The provider id Workers AI models are specced under. */
export const WORKERS_AI_PROVIDER_ID = 'workers-ai';

/** The id namespace Cloudflare's own catalog uses. A model id beginning with
 *  this is a Workers AI model whatever else is configured, which is why the
 *  qualification below can be unconditional rather than a guess. */
export const WORKERS_AI_MODEL_ID_PREFIX = '@cf/';

/**
 * Qualify a Workers AI model into a `<provider>/<modelId>` spec, idempotently.
 *
 * The rule is core's because the id namespace is core's, and it was living in an
 * adapter — spelled twice in one file, once as a `@cf/` prefix rewrite and once
 * as an already-qualified check. Both are this.
 */
export function workersAiSpec(modelOrSpec: string): string {
  return modelOrSpec.startsWith(`${WORKERS_AI_PROVIDER_ID}/`)
    ? modelOrSpec
    : `${WORKERS_AI_PROVIDER_ID}/${modelOrSpec}`;
}

/** Stable per-agent Workers AI session-affinity key — pins an agent's turns to
 *  the same replica so the (default-on) prefix cache actually hits across
 *  turns. Same `kinu-<name>` scheme as the sandbox id; one source so the
 *  cf-backend registry call sites and the CLI's signed-in proxy pin don't
 *  drift. */
export function agentAffinityKey(name: string): string {
  return `kinu-${name}`;
}
