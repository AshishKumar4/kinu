// Cross-family judge selection against a live agent provider registry.
//
// The policy itself lives in core (`selectJudgeModel`); this is the adapter
// that answers "what is actually available to this owner right now" from the
// registry the agent already owns.

import { selectJudgeModel, type JudgeModelSelection } from '@proteus/core';
import type { AgentProviderRegistry } from './agent-registry.js';

/**
 * One spec per AVAILABLE statically-registered provider, in the registry's own
 * preference order (workers-ai → my-gateway → ai-gateway → codex → openai →
 * anthropic → openrouter → openai-compat).
 *
 * Dynamic models.dev providers are not enumerated: they carry no
 * `defaultModel`, so there is no single model to nominate for them. That only
 * narrows the cross-family search — a user connected solely through the
 * catalog still gets the documented same-family fallback, and an explicit
 * `review_model` reaches any provider the registry can resolve.
 */
async function availableJudgeSpecs(registry: AgentProviderRegistry): Promise<string[]> {
  const defaults = new Map(registry.registry.list().map((p) => [p.id, p.defaultModel]));
  const specs: string[] = [];
  for (const info of await registry.registry.listProviders(registry.deps)) {
    const modelId = defaults.get(info.id);
    if (info.available && modelId) specs.push(`${info.id}/${modelId}`);
  }
  return specs;
}

/**
 * Resolve the model that judges this agent's own output: the operator's
 * `review_model` when set, else a different-vendor model when one is
 * connected, else the chat model (same-model judging — the documented
 * single-vendor fallback). Specs come back normalized and registry-resolvable.
 */
export async function resolveJudgeModelSelection(opts: {
  registry: AgentProviderRegistry;
  reviewSpec: string | null;
  chatSpec: string | null;
}): Promise<JudgeModelSelection> {
  const { registry } = opts;
  const selection = await selectJudgeModel({
    reviewSpec: opts.reviewSpec,
    chatSpec: registry.normalizeSpecSync(opts.chatSpec),
    candidates: () => availableJudgeSpecs(registry),
  });
  return { ...selection, spec: registry.normalizeSpecSync(selection.spec) };
}
