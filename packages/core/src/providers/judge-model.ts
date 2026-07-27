// Which model is allowed to grade this agent's own work.
//
// An LLM asked to compare two responses inflates the one written in its own
// family's voice — self-preference, measured at roughly +10..25pp and driven
// by fluency, so it fires whether or not the judge recognises itself. A
// deployment that leaves the review model unset therefore judges itself with
// itself, which is the one configuration where the shadow judge's verdict is
// least trustworthy. This module states the preference order that avoids it.

import { parseModelSpec } from './types.js';

/** Providers that resell another vendor's models under their own id, so a
 *  bare provider id would misreport the family. Only genuine resell
 *  relationships belong here. */
const PROVIDER_VENDOR: Readonly<Record<string, string>> = {
  // OpenAI's Codex OAuth endpoint — same GPT models as the `openai` provider.
  codex: 'openai',
};

/**
 * The vendor family a model spec belongs to — the unit self-preference tracks.
 * Two providers reselling the same build (`workers-ai/@cf/moonshotai/kimi-k3`
 * vs `openrouter/moonshotai/kimi-k3`) are the SAME family and buy no bias
 * relief, so the provider id alone is the wrong key.
 *
 * The rule: the vendor is the path segment immediately BEFORE the model name.
 * That one rule reads every id shape the registry produces —
 * `@cf/moonshotai/kimi-k3`, `moonshotai/kimi-k3`, and the gateway's nested
 * `workers-ai/@cf/moonshotai/kimi-k3` all resolve to `moonshotai`. Ids with no
 * vendor segment at all (`openai/gpt-5.6`, `anthropic/claude-opus-4`) fall
 * back to the provider id.
 */
export function modelVendorFamily(spec: string): string {
  const { provider, modelId } = parseModelSpec(spec);
  const segments = modelId.split('/');
  if (segments.length > 1) return segments[segments.length - 2].toLowerCase();
  const p = provider.toLowerCase();
  return PROVIDER_VENDOR[p] ?? p;
}

export interface JudgeModelSelection {
  /** `<provider>/<modelId>` the judge should run on. */
  spec: string;
  /** How it was chosen. `same-family-fallback` is reported rather than hidden:
   *  it is the honest name for a deployment with only one vendor connected,
   *  not a design preference. */
  source: 'configured' | 'cross-family' | 'same-family-fallback';
}

export interface SelectJudgeModelOpts {
  /** The operator's explicit `review_model`, if any. */
  reviewSpec: string | null | undefined;
  /** The resolved `<provider>/<modelId>` the agent chats with. */
  chatSpec: string;
  /** Available specs in registry preference order. Lazy — an explicitly
   *  configured review model short-circuits before any availability query. */
  candidates: () => Promise<readonly string[]>;
}

/**
 * Pick the model that judges this agent's own output.
 *
 *   1. An explicitly configured `review_model` wins outright — the operator's
 *      choice is not second-guessed, cross-family or not.
 *   2. Otherwise the first AVAILABLE model from a different vendor family than
 *      the chat model, in registry preference order.
 *   3. Otherwise the chat model itself. Same-model judging is the documented
 *      fallback for a deployment with a single connected vendor — the only
 *      remaining option, not a defensible default.
 */
export async function selectJudgeModel(opts: SelectJudgeModelOpts): Promise<JudgeModelSelection> {
  const configured = opts.reviewSpec?.trim();
  if (configured) return { spec: configured, source: 'configured' };

  const chatFamily = modelVendorFamily(opts.chatSpec);
  for (const candidate of await opts.candidates()) {
    if (modelVendorFamily(candidate) !== chatFamily) {
      return { spec: candidate, source: 'cross-family' };
    }
  }
  return { spec: opts.chatSpec, source: 'same-family-fallback' };
}
