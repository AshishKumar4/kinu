// Which model grades this agent's own work: another vendor family, since judges prefer their own family's voice.

import type { ProviderRegistry } from './registry';
import { parseModelSpec, type ProviderDeps } from './types';

/** One spec per available statically-registered provider, in registry preference order. */
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

/** Providers reselling another vendor's models under their own id. */
interface ProviderVendorIndex {
  readonly [provider: string]: string;
}

const PROVIDER_VENDOR: ProviderVendorIndex = {
  // OpenAI's Codex OAuth endpoint — same GPT models as the `openai` provider.
  codex: 'openai',
  chatgpt: 'openai',
};

/** The vendor family of a model spec: the path segment before the model name, else the provider id. */
export function modelVendorFamily(spec: string): string {
  const { provider, modelId } = parseModelSpec(spec);
  const segments = modelId.split('/');

  if (segments.length > 1) return segments[segments.length - 2].toLowerCase();
  const p = provider.toLowerCase();

  return PROVIDER_VENDOR[p] ?? p;
}

/** Judges in a calibration ensemble: two is the smallest panel that can disagree; a third would outvote the split. */
const ENSEMBLE_JUDGE_COUNT = 2;

export interface EnsembleJudgeSelection {
  /** One `<provider>/<modelId>` per distinct family; shorter than `ENSEMBLE_JUDGE_COUNT` when too few are connected. */
  specs: string[];
  source: 'configured' | 'cross-family';
}

export interface SelectEnsembleJudgesOpts {
  /** Judges the operator named outright. */
  specs: ReadonlyArray<string> | null | undefined;
  /** The chat spec, whose family the classifier runs on. A thunk: resolving it can report "not authenticated". */
  chatSpec: () => string;
  /** Available specs in registry preference order. */
  candidates: () => Promise<readonly string[]>;
}

/**
 * Pick the calibration panel in candidate order, with no two judges nor the classifier sharing a family,
 * and no single-vendor fallback: too few families returns a short list.
 */
export async function selectEnsembleJudges(
  opts: SelectEnsembleJudgesOpts,
): Promise<EnsembleJudgeSelection> {
  const configured = (opts.specs ?? []).map((spec) => spec.trim()).filter((spec) => spec !== '');

  if (configured.length > 0) return { specs: configured, source: 'configured' };

  const seen = new Set([modelVendorFamily(opts.chatSpec())]);
  const specs: string[] = [];

  for (const candidate of await opts.candidates()) {
    const family = modelVendorFamily(candidate);

    if (seen.has(family)) continue;
    seen.add(family);
    specs.push(candidate);

    if (specs.length === ENSEMBLE_JUDGE_COUNT) break;
  }

  return { specs, source: 'cross-family' };
}
