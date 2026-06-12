// Workers AI platform defaults. The runtime provider implementation is
// CF-specific (cf-backend/src/providers/workers-ai.ts); the default model id
// is shared platform knowledge: cf-backend seeds new agents with it, the CLI
// seeds local agents and ranks model menus by it, and cli-backend uses it as
// the branch-worker fallback.
export const DEFAULT_WORKERS_AI_MODEL_ID = '@cf/moonshotai/kimi-k2.6';
export const DEFAULT_WORKERS_AI_MODEL_SPEC = `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`;

/** Stable per-agent Workers AI session-affinity key — pins an agent's turns to
 *  the same replica so the (default-on) prefix cache actually hits across
 *  turns. Same `proteus-<name>` scheme as the sandbox id; one source so the
 *  cf-backend registry call sites and the CLI's signed-in proxy pin don't
 *  drift. */
export function agentAffinityKey(name: string): string {
  return `proteus-${name}`;
}
