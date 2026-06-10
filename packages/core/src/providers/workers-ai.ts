// Workers AI platform defaults. The runtime provider implementation is
// CF-specific (cf-backend/src/providers/workers-ai.ts); the default model id
// is shared platform knowledge: cf-backend seeds new agents with it, the CLI
// seeds local agents and ranks model menus by it, and cli-backend uses it as
// the branch-worker fallback.
export const DEFAULT_WORKERS_AI_MODEL_ID = '@cf/moonshotai/kimi-k2.6';
export const DEFAULT_WORKERS_AI_MODEL_SPEC = `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`;
