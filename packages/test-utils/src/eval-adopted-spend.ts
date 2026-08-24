/**
 * What a RESUMED run adopted, and what that does to the cost it publishes.
 *
 * A run that spans hours spans processes. When one dies, the next reads the
 * durable progress store, rehydrates every case whose episode already finished
 * and runs only what is left — which is the whole point of that store, and is
 * why a crash costs minutes instead of a full corpus.
 *
 * The observations came back. The SPEND did not. The meter is per-process by
 * construction, so a resumed run published one record whose case list covered
 * the whole run and whose `spend` covered the last process only — an unqualified
 * total that got SMALLER the more times the run was interrupted. That is the
 * same defect as a tier reporting `0 model call(s)` over an episode that spent
 * hundreds of thousands of neurons, one process boundary further out.
 *
 * This module is the bridge, and it is its own file because it is the only
 * place that has to know all three shapes at once: the observation that carries
 * the token totals (eval-run.ts), the activity tally that carries the model-step
 * count (eval-progress.ts), and the meter those two feed (live-model.ts). None
 * of the three should import another to reach the other two.
 */
import { observationKey, type EvalObservation } from './eval-run';
import type { CaseActivity } from './eval-progress';
import { recordAdoptedLiveModelSpend, type AdoptedCaseSpend } from './live-model';
import type { Usage } from '@kinu.run/core';

/** What a resumed run adopted, in the two counts a reader of the total needs. */
export interface AdoptedSpendSummary {
  /** Cases whose durable spend reached the total. */
  readonly accounted: number;
  /** Cases adopted from a record that could not say what they cost. */
  readonly unaccounted: number;
}

/**
 * One adopted case's spend, as its durable record is able to state it.
 *
 * The tokens come from the observation, because that is where a finished
 * episode wrote them. The call count comes from the activity tally, because
 * that is the only count written DURING the episode and therefore the only one
 * a crash cannot erase.
 *
 * A ZERO IS NOT A MEASUREMENT. `tokensIn`/`tokensOut` are summed over the ledger
 * with `?? 0`, so a 0 there means no step reported usage rather than a step that
 * cost nothing. Carrying it through as `input: 0` would publish a fabricated
 * measurement, which is exactly what the `Usage` contract exists to refuse, so a
 * zero field is simply absent and the case is labelled instead of priced. An
 * episode that ended any way but `scored` stored no totals at all and takes the
 * same path.
 *
 * A FLOOR, said out loud: `modelSteps` counts the episode's own `step_finish`
 * rows, so a judge sample or a head that episode spawned sits outside it. That
 * is the whole of what crosses a process boundary, and a stated floor is worth
 * more than the nothing it replaces.
 */
function adoptedCaseSpend(
  observation: EvalObservation, activity: CaseActivity | undefined,
): AdoptedCaseSpend {
  const calls = activity?.modelSteps ?? 0;
  if (observation.outcome !== 'scored') return { calls, usage: {} };
  // Built field by field, in `addUsage`'s own mutable-mapped shape, because an
  // absent field and a zero one are different claims and only assignment can
  // keep them apart.
  const usage: { -readonly [K in keyof Usage]: number } = {};
  if (observation.tokensIn > 0) usage.input = observation.tokensIn;
  if (observation.tokensOut > 0) usage.output = observation.tokensOut;
  const reasoning = observation.reasoningOut ?? 0;
  if (reasoning > 0) usage.reasoning = reasoning;
  return { calls, usage };
}

/**
 * The durable spend a resumed run adopts, fed to the live meter once per case.
 *
 * ONCE PER CASE, because a resumed case is met twice: when the run rehydrates
 * its observations before any work begins, and again when the harness hands the
 * stored episode back instead of re-running it. Charging both visits would
 * double the very number this exists to make true, so the keys are held here
 * rather than left to the order in which two call sites happen to run.
 *
 * Instance state, not module counters. The meter it feeds is process-global by
 * necessity; WHICH cases a run adopted is a fact about that run.
 */
export class AdoptedSpendMeter {
  private readonly seen = new Set<string>();
  private accountedCases = 0;
  private unaccountedCases = 0;

  /** Adopt one case. `activity` is the tally the interrupted process wrote as
   *  that episode's own events landed. */
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

/**
 * What the published total actually covers, printed BEFORE it.
 *
 * A resumed run's total spans processes and nothing in the number says so, so
 * the run says it — and says it first, because a reader who meets a total before
 * meeting its qualifier has already read a partial figure as a whole one.
 * `null` when nothing was adopted: an ordinary run's total needs no sentence.
 */
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
