/** The notices a model setting refusing for its owner to fix is said through, once (`profiles/tier-refusals.ts`). */

import type { TierId } from './profile';

export interface TierRefusal {
  readonly model: string;
  readonly cause: unknown;
}

/** Keyed by a tier id, or `DECISION_REFUSALS` for the decision model that rates turns. */
export interface TierRefusals {
  changes(): number;
  refused(refusal: { readonly tier: TierId; readonly since: number; readonly refusals: readonly TierRefusal[] }): void;
  answered(tier: TierId): void;
  /** Clef refused and no fast-tier model is trusted for the questions asked (`structured-decision.ts`), so nothing
   *  answered them: kept until a decision is answered again, so `/refine` can say why no turn is rated. Null clears. */
  untrusted(asked: { readonly model: string; readonly questions: readonly string[] } | null): void;
}
