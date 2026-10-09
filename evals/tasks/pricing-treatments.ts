import { WORKSPACE_ROOT } from '@kinu.run/core';
import { shows, type Sight } from '../src/sight';
import { DIFFERENT_DESIGNS } from '../src/judge';
import type { EvalPart } from '../src/task';
import type { EvalCheckOutcome, EvalVerifier } from '../src/verifier';
import { answersWithSlates, madeNoApp, madeNoPrototype, readAnswer, readingEvidence } from './ephemeral';

// A one-off visual answer: three treatments of a pricing table to compare in the chat. The answer should be
// ephemeral slates, not an app. Each must show every plan's monthly price and the yearly price the checker computes
// from the seeded discounts; a judge says whether the three are visibly different designs, which nothing here can
// compute, at the agreement `evals/scripts/calibrate-judge.ts` measured.


const PLANS_PATH = `${WORKSPACE_ROOT}/pricing/plans.csv`;

const PLANS = [
  { plan: 'Starter', monthlyUsd: 19, discountPct: 10, seats: 3, storageGb: 50, support: 'Email' },
  { plan: 'Team', monthlyUsd: 49, discountPct: 15, seats: 10, storageGb: 250, support: 'Chat' },
  { plan: 'Business', monthlyUsd: 129, discountPct: 20, seats: 50, storageGb: 2000, support: 'Phone and chat' },
] as const;

const CSV = `plan,monthly_usd,annual_discount_pct,seats,storage_gb,support\n${PLANS.map((plan) =>
  [plan.plan, plan.monthlyUsd, plan.discountPct, plan.seats, plan.storageGb, plan.support].join(',')).join('\n')}\n`;

/** Twelve months at the plan's price with its annual discount taken off: $205.20, $499.80 and $1,238.40. */
function yearlyUsd(plan: (typeof PLANS)[number]): number {
  return Math.round(plan.monthlyUsd * 12 * (100 - plan.discountPct)) / 100;
}

const NAMES = PLANS.map((plan) => plan.plan);

/** Every plan shows its own monthly and yearly price in its own part of the treatment, its row, card or column; copy
 *  that mentions another plan in passing ("everything in Team, plus") is no other plan's label (`sight.ts`). */
function showsEveryPrice(sight: Sight): boolean {
  return PLANS.every((plan) => (sight.regions[plan.plan] ?? []).some((region) => shows(region.text, plan.monthlyUsd) && shows(region.text, yearlyUsd(plan))));
}

/** At least three treatments, whether in one answer page or separate pages, each showing every plan's own prices. */
function everyTreatment(verifier: EvalVerifier): Promise<EvalCheckOutcome> {
  return verifier.browse(async (browser) => {
    const readings = await readAnswer(browser, 1, NAMES, showsEveryPrice);

    const treatments = PLANS.map((plan) => readings.filter((reading) => reading.held).reduce((total, reading) => total
      + (reading.sight.regions[plan.plan] ?? []).filter((region) => shows(region.text, plan.monthlyUsd) && shows(region.text, yearlyUsd(plan))).length, 0));

    return { pass: treatments.every((count) => count >= 3), evidence: { treatments, readings: readings.map(readingEvidence) } };
  });
}

export const pricingTreatments: EvalPart = {
  id: 'pricing',
  objectives: [
    `Show at least three visibly different pricing treatments in the chat, each with every plan's monthly and discounted yearly price from pricing/plans.csv.`,
    'A one-off comparison: no file slate and no prototype.',
  ],
  turns: [{
    seed: [{ path: PLANS_PATH, content: CSV }],
    prompt: `We're redesigning the pricing table on our site. Show me three different treatments of the plans in
${PLANS_PATH} so I can compare them side by side. Each one shows every plan's monthly price and its
yearly price with the annual discount taken off.`,
    verify: async (verifier) => {
      await answersWithSlates(verifier, 1);
      await madeNoApp(verifier);
      await madeNoPrototype(verifier);

      await verifier.check('each-treatment-shows-every-price', () => everyTreatment(verifier));

      // Pictured in a browser of its own, so a picture that cannot be taken fails this check alone.
      await verifier.check('the-treatments-look-different', () => verifier.browse(async (browser) => {
        const pictures = await browser.answerPictures(await browser.open(), 1, NAMES, showsEveryPrice);
        const judged = await verifier.judgement(DIFFERENT_DESIGNS, pictures);

        return { pass: pictures.length > 0 && judged.verdict === true, evidence: { judged, pages: pictures.length } };
      }));

      await verifier.check('a-reload-shows-the-same', () => everyTreatment(verifier));
    },
  }],
};
