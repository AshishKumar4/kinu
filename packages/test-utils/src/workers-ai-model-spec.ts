/** Fixture-owned model; product defaults are not changed.
 * Read 2026-10-11: https://developers.cloudflare.com/workers-ai/platform/limits/ — standard text generation: 300
 * requests/minute, GLM-5.3: 20. https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
 * Real binding green: Armada job 20261011203037-e2fca4e0. The native harness terminates on quota exhaustion.
 */
export const WORKERS_AI_FIXTURE_MODEL_ID = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export const WORKERS_AI_FIXTURE_MODEL_SPEC = `workers-ai/${WORKERS_AI_FIXTURE_MODEL_ID}`;
