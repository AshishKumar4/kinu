import { copyHeaders } from './fetch-shim';
import type { ModelAffinity } from './types';

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

/** An actor's conversation, which pins its turns to one replica so the prefix cache hits, and the workspace it shares
 *  its static prompt prefix with. */
export function actorAffinity(actor: { readonly name: string; readonly workspaceId: string }): ModelAffinity {
  return { sessionAffinity: `kinu-${actor.name}`, workspaceAffinity: `kinu-workspace-${actor.workspaceId}` };
}

export const SESSION_AFFINITY_HEADER = 'x-session-affinity';

export function sessionAffinityOf(headers: HeadersInit | undefined): string | undefined {
  return copyHeaders(headers).get(SESSION_AFFINITY_HEADER) ?? undefined;
}
