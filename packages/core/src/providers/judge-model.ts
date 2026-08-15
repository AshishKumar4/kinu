// Which model is allowed to grade this agent's own work.
//
// An LLM asked to compare two responses inflates the one written in its own
// family's voice — self-preference, measured at roughly +10..25pp and driven
// by fluency, so it fires whether or not the judge recognises itself. A
// deployment that leaves the review model unset therefore judges itself with
// itself, which is the one configuration where the shadow judge's verdict is
// least trustworthy. This module states the preference order that avoids it.

import type { ProviderRegistry } from './registry.js';
import { parseModelSpec, type ProviderDeps } from './types.js';

/**
 * One spec per AVAILABLE statically-registered provider, in the registry's own
 * preference order — the candidate list both selectors below walk, and the one
 * definition of it, so the CF and CLI backends cannot answer "what could judge
 * this" differently.
 *
 * Dynamic models.dev providers are not enumerated: they carry no
 * `defaultModel`, so there is no single model to nominate for them. That only
 * narrows the search — a user connected solely through the catalog still gets
 * the documented same-family fallback, and explicitly named models reach any
 * provider the registry can resolve.
 */
export async function availableJudgeSpecs(
  registry: ProviderRegistry,
  deps: ProviderDeps,
): Promise<string[]> {
  const defaults = new Map(registry.list().map((provider) => [provider.id, provider.defaultModel]));
  const specs: string[] = [];
  for (const info of await registry.listProviders(deps)) {
    const modelId = defaults.get(info.id);
    if (info.available && modelId) specs.push(`${info.id}/${modelId}`);
  }
  return specs;
}

/** Providers that resell another vendor's models under their own id, so a
 *  bare provider id would misreport the family. Only genuine resell
 *  relationships belong here. */
interface ProviderVendorIndex {
  readonly [provider: string]: string;
}

const PROVIDER_VENDOR: ProviderVendorIndex = {
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

// ── A panel of them ──────────────────────────────────────────────

/** Judges in a calibration ensemble (evolution/ensemble.ts).
 *
 *  Two, because two is the smallest panel that can DISAGREE — and disagreement
 *  is the whole signal: a split is the ensemble admitting it does not know,
 *  which is what makes its unanimous verdicts worth reading. A third judge
 *  would buy majority voting, which converts exactly those admissions back into
 *  confident answers. */
export const ENSEMBLE_JUDGE_COUNT = 2;

export interface EnsembleJudgeSelection {
  /** `<provider>/<modelId>` per judge, each from a distinct vendor family.
   *  Shorter than `ENSEMBLE_JUDGE_COUNT` when too few families are connected —
   *  the caller refuses rather than padding it. */
  specs: string[];
  source: 'configured' | 'cross-family';
}

export interface SelectEnsembleJudgesOpts {
  /** Judges the operator named outright. */
  specs: ReadonlyArray<string> | null | undefined;
  /** The resolved `<provider>/<modelId>` the agent chats with — and therefore
   *  the family the classifier under test runs on. */
  chatSpec: string;
  /** Available specs in registry preference order. */
  candidates: () => Promise<readonly string[]>;
  count?: number;
}

/**
 * Pick the panel that grades the same turns the owner hand-labeled.
 *
 * Same preference order as `selectJudgeModel`, applied twice, with two extra
 * constraints that follow from what the panel is FOR — standing in for the
 * human who calibrates the classifier:
 *
 *   - No two judges share a vendor family. Self-preference is a family-level
 *     effect, so a panel drawn from one family agrees with itself for reasons
 *     that have nothing to do with the turn, and its unanimity means nothing.
 *   - No judge shares the CLASSIFIER's family either. A panel that inherits the
 *     classifier's blind spots would confirm its verdicts and read as high
 *     agreement, which is precisely the measurement being attempted.
 *
 * There is deliberately no single-vendor fallback here. `selectJudgeModel` has
 * one because judging with the chat model is worse-but-still-something; an
 * ensemble of one is not a weaker ensemble, it is a different thing wearing the
 * name. Too few families connected returns a short list and the caller says so.
 */
export async function selectEnsembleJudges(
  opts: SelectEnsembleJudgesOpts,
): Promise<EnsembleJudgeSelection> {
  const count = opts.count ?? ENSEMBLE_JUDGE_COUNT;
  const configured = (opts.specs ?? []).map((spec) => spec.trim()).filter((spec) => spec !== '');
  if (configured.length > 0) return { specs: configured, source: 'configured' };

  const seen = new Set([modelVendorFamily(opts.chatSpec)]);
  const specs: string[] = [];
  for (const candidate of await opts.candidates()) {
    const family = modelVendorFamily(candidate);
    if (seen.has(family)) continue;
    seen.add(family);
    specs.push(candidate);
    if (specs.length === count) break;
  }
  return { specs, source: 'cross-family' };
}
