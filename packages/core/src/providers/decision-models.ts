/** The decision models' names, apart from the model runner: a profile catalog and the app's pages read them, and
 *  neither runs a model. */
export const DEFAULT_DECISION_MODEL = 'workers-ai/@cf/cloudflare/clef';

/** The decision models a catalog may name. */
export const DECISION_MODELS = [DEFAULT_DECISION_MODEL, 'workers-ai/@cf/cloudflare/clef-flash'] as const;

export type DecisionModel = (typeof DECISION_MODELS)[number];

/** The notice key a refusing decision model is said under, beside the tiers'; a space no tier id can hold. */
export const DECISION_REFUSALS = 'decision model';
