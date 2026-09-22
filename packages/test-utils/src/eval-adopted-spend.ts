/**
 * Spend adopted by a resumed run. The meter is per-process, so rehydrated cases must feed their durable
 * spend back in or the published total covers only the last process. Bridges eval-run, eval-progress
 * and live-model shapes so none of those imports another.
 */
import { observationKey, type EvalObservation } from './eval-run';
import type { CaseActivity } from './eval-progress';
import { recordAdoptedLiveModelSpend, type AdoptedCaseSpend } from './live-model';
import type { Usage } from '@kinu.run/core';

export interface AdoptedSpendSummary {
  /** Cases whose durable spend reached the total. */
  readonly accounted: number;
  /** Cases adopted from a record that could not say what they cost. */
  readonly unaccounted: number;
}

/**
 * One adopted case's spend: tokens from the observation, call count from the activity tally (written
 * during the episode, so a crash cannot erase it). A zero token field means unreported and stays absent;
 * `modelSteps` is a floor that excludes judge samples and spawned heads.
 */
function adoptedCaseSpend(
  observation: EvalObservation, activity: CaseActivity | undefined,
): AdoptedCaseSpend {
  const calls = activity?.modelSteps ?? 0;

  if (observation.outcome !== 'scored') return { calls, usage: {} };
  // Assigned field by field: an absent field and a zero one are different claims.
  const usage: { -readonly [K in keyof Usage]: number } = {};

  if (observation.tokensIn > 0) usage.input = observation.tokensIn;

  if (observation.tokensOut > 0) usage.output = observation.tokensOut;
  const reasoning = observation.reasoningOut ?? 0;

  if (reasoning > 0) usage.reasoning = reasoning;

  return { calls, usage };
}

/**
 * The durable spend a resumed run adopts, fed to the live meter once per case: a resumed case is met at
 * rehydration and again when the harness hands its stored episode back.
 */
export class AdoptedSpendMeter {
  private readonly seen = new Set<string>();
  private accountedCases = 0;
  private unaccountedCases = 0;

  /** Adopt one case. `activity` is the tally the interrupted process wrote for that episode. */
  adopt(observation: EvalObservation, activity: CaseActivity | undefined): void {
    const key = observationKey(observation);

    if (this.seen.has(key)) return;
    this.seen.add(key);

    if (recordAdoptedLiveModelSpend(adoptedCaseSpend(observation, activity)) === 'accounted') {
      this.accountedCases += 1;

      return;
    }

    this.unaccountedCases += 1;
  }

  summary(): AdoptedSpendSummary {
    return { accounted: this.accountedCases, unaccounted: this.unaccountedCases };
  }
}

/** The qualifier printed before a resumed run's total; `null` when nothing was adopted. */
export function formatAdoptedSpend(summary: AdoptedSpendSummary): string | null {
  if (summary.accounted === 0 && summary.unaccounted === 0) return null;

  const covers = summary.accounted === 0
    ? 'THIS PROCESS ONLY'
    : `this process plus ${String(summary.accounted)} adopted case(s)`;

  const lines = [`adopted: resumed run — the spend below covers ${covers}`];

  if (summary.unaccounted > 0) {
    lines.push(`  PARTIAL SPEND — ${String(summary.unaccounted)} case(s) from the interrupted `
      + 'run recorded no usable call evidence, so what they cost is absent from the figure '
      + 'below and it is not the run\'s total');
  }

  return lines.join('\n');
}
