// The fast tier an account gets when it has not set one: picked from what its providers list
// (/mnt/local/kinu/tmp/fast-tier/DESIGN.md, approved 2026-10-19).

import type { ModelMenu } from '../providers/registry';
import { specProvider, specWithoutAccount, type ModelPricing } from '../providers/types';
import type { TierAssignment } from '../types/profile';
import { COMPACTION_TRIGGER_PERCENT } from '../providers/server-compaction';

/** A model the fast tier can run on, with the window the pick's floor compares. */
export interface FastCandidate {
  readonly model: string;
  readonly contextWindow?: number;
}

/** The catalog's price, or the same model's price under another listed provider: a plan's row carries none. */
function priceOf(model: ModelMenu['models'][number], menu: ModelMenu['models']): ModelPricing | undefined {
  return model.cost ?? menu.find((other) => other.id === model.id && other.cost !== undefined)?.cost;
}

/** Whether the catalog lists the model with structured output, under its own row or the same model's under another
 *  provider, as a plan's row lists less than the API's. */
function answersStructured(model: ModelMenu['models'][number], menu: ModelMenu['models']): boolean {
  return menu.some((other) => other.id === model.id && other.capabilities?.includes('structured-outputs') === true);
}

/** Lower first; an unknown price is never treated as free, so it sorts after every known one. */
function byPrice(a: ModelPricing | undefined, b: ModelPricing | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;

  if (b === undefined) return -1;

  return a.input - b.input || a.output - b.output;
}

/**
 * Every model the fast tier could run on, cheapest first: one that calls tools (a researcher runs whole turns on fast)
 * and that the catalog lists with structured output (sleep-time, titles and triage read a shape back: rc24 staging's
 * pick without it, granite-4.0-h-micro, dropped a field sleep-time requires in 4 of 8 tries), by input price, then
 * output price, as fast jobs read turns and write a line; an unpriced one after the priced, and equal ones in the
 * menu's order, which is the registry's provider order.
 */
export function fastCandidatesOf(menu: Pick<ModelMenu, 'models'>): FastCandidate[] {
  const able = menu.models.filter((model) => model.capabilities?.includes('tools') === true && answersStructured(model, menu.models));
  const priced = able.map((model) => ({ model, price: priceOf(model, menu.models) }));

  // `sort` is stable, so equal prices keep the menu's order; `priced` is this call's own array.
  return priced.sort((a, b) => byPrice(a.price, b.price)).map(({ model }) => ({
    model: `${model.provider}/${model.id}`,
    ...(model.contextWindow !== undefined && { contextWindow: model.contextWindow }),
  }));
}

/**
 * An unset fast tier: the cheapest candidate that holds what the account's main model keeps (fast reads what the main
 * tier wrote, and a conversation is compacted at `COMPACTION_TRIGGER_PERCENT` of the main model's window), failing over
 * to the cheapest of each other provider, then to the main model (AGENTS.md:67). Null when nothing qualifies, and the
 * tier runs on the main model as before.
 */
export function fastAssignment(candidates: readonly FastCandidate[], main: TierAssignment): TierAssignment | null {
  const mainWindow = candidates.find((candidate) => candidate.model === specWithoutAccount(main.model))?.contextWindow;
  const floor = mainWindow === undefined ? 0 : Math.floor(mainWindow * COMPACTION_TRIGGER_PERCENT / 100);
  const able = candidates.filter((candidate) => (candidate.contextWindow ?? 0) >= floor);
  const [pick, ...rest] = able;

  if (pick === undefined) return null;
  const providers = new Set([specProvider(pick.model)]);
  const fallbacks: string[] = [];

  for (const candidate of rest) {
    const provider = specProvider(candidate.model);

    if (providers.has(provider)) continue;
    providers.add(provider);
    fallbacks.push(candidate.model);
  }

  const chain = [...fallbacks, main.model].filter((spec, index, all) => spec !== pick.model && all.indexOf(spec) === index);

  return chain.length === 0 ? { model: pick.model } : { model: pick.model, fallbacks: chain };
}
