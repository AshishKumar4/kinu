// What model something gets when nobody named one; refusal copy stays per backend.

import { DEFAULT_WORKERS_AI_MODEL_SPEC } from './workers-ai';

/**
 * The model to start on: an explicit choice the account can serve, else the available Workers AI default, else null.
 * Never the first menu entry: that silently signed workspaces up to a paid BYO provider (pinned by test).
 */
export function defaultSpecFor(
  configured: string | null | undefined,
  availableSpecs: readonly string[],
): string | null {
  if (configured && availableSpecs.includes(configured)) return configured;

  return availableSpecs.includes(DEFAULT_WORKERS_AI_MODEL_SPEC)
    ? DEFAULT_WORKERS_AI_MODEL_SPEC
    : null;
}
