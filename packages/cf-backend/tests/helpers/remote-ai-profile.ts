import { DEFAULT_WORKERS_AI_MODEL_SPEC, profileCatalogDigest, type ProfileAuthorityInputs } from '@kinu.run/core';
import { OrchestratorAgent } from '../../src/orchestrator';

/**
 * Fixture-owned fast model for the native suites whose subject is not the model; product defaults remain unchanged.
 * Read 2026-10-11: https://developers.cloudflare.com/workers-ai/platform/limits/ — standard text-generation models
 * answer 300 requests/minute, while the product's default GLM-5.3 answers 20.
 * Model: https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
 * Measured green on the real remote binding: Armada job 20261011202049-ebc63503 (durable-object-semantics-under-workerd).
 * Every call still reaches the real binding; a 429 there ends the run (workers-ai-binding.ts).
 */
function remoteAiFixtureProfile(input: ProfileAuthorityInputs): ProfileAuthorityInputs {
  const fast = input.envelope.catalog.tiers.fast ?? input.envelope.catalog.tiers.default;

  if (fast?.model !== DEFAULT_WORKERS_AI_MODEL_SPEC) return input;

  const model = 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const catalog = { ...input.envelope.catalog, tiers: { ...input.envelope.catalog.tiers, fast: { model } } };

  return { envelope: { ...input.envelope, catalog, digest: profileCatalogDigest(catalog) },
    provider: { ...input.provider, availableModels: [...new Set([...input.provider.availableModels, model])] } };
}

export class RemoteAiFixtureOrchestrator extends OrchestratorAgent {
  protected override async profileInputs(): Promise<ProfileAuthorityInputs> {
    return remoteAiFixtureProfile(await super.profileInputs());
  }
}
