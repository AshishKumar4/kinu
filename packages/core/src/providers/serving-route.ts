/**
 * Which API serves a model spec. A gateway relays an author's model over that author's own API, so what a call sends
 * and accepts (reasoning effort, media, prompt caching, server compaction, replayed reasoning) is the serving API's,
 * read here once rather than from the spec's first segment.
 */
import type { WireProtocol } from './wire-model';
import { splitSpec } from './types';

const OPENAI_AUTHOR = 'openai/';

const ANTHROPIC_AUTHOR = 'anthropic/';

const WORKERS_AI_AUTHOR = 'workers-ai/';

/** The API a gateway model is spoken to in, and the id its SDK is built with. */
export interface GatewayWire {
  readonly protocol: WireProtocol;
  readonly modelId: string;
}

/** Each author's own API where the gateway serves one (`/responses`, `/messages`), else its unified chat API. */
export function gatewayWire(modelId: string): GatewayWire {
  // The Anthropic SDK reads Claude's limits by Anthropic's own id.
  if (modelId.startsWith(ANTHROPIC_AUTHOR)) return { protocol: 'messages', modelId: modelId.slice(ANTHROPIC_AUTHOR.length).replaceAll('.', '-') };

  if (modelId.startsWith(OPENAI_AUTHOR)) return { protocol: 'responses', modelId: modelId.slice(OPENAI_AUTHOR.length) };

  return { protocol: 'chat-completions', modelId: workersAiModelId(modelId) };
}

/** A Workers AI model by its own `@cf/` id: no endpoint takes the `workers-ai/` author a gateway spec names it under
 *  (`No such model workers-ai/@cf/zai-org/glm-5.3`, code 5007, production 2026-10-05 and staging 2026-10-08). */
export function workersAiModelId(modelId: string): string {
  return modelId.startsWith(WORKERS_AI_AUTHOR) ? modelId.slice(WORKERS_AI_AUTHOR.length) : modelId;
}

/** The provider whose own API serves a route, and the model by that API's id. */
export interface ServingRoute {
  readonly provider: string;
  readonly modelId: string;
}

/**
 * `spec`'s serving API: a gateway's author route is the author's (`my-gateway/anthropic/claude-opus-4.7` is Anthropic's
 * Messages API serving `claude-opus-4-7`), any other route its own provider's, its account set aside. Null for a spec
 * with no provider.
 */
export function servingRoute(spec: string): ServingRoute | null {
  const parts = splitSpec(spec.trim());

  if (parts === null) return null;

  if (parts.provider !== 'my-gateway') return { provider: parts.provider, modelId: parts.modelId };
  const wire = gatewayWire(parts.modelId);

  if (wire.protocol === 'chat-completions') return { provider: parts.provider, modelId: parts.modelId };

  return { provider: wire.protocol === 'messages' ? 'anthropic' : 'openai', modelId: wire.modelId };
}
