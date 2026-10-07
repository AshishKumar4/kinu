import { shows, type Sight } from '../src/sight';
import { defineTaskEval } from '../src/eval';
import { DIFFERENT_DESIGNS } from '../src/judge';
import { defineEvalTask } from '../src/task';
import type { EvalCheckOutcome, EvalVerifier } from '../src/verifier';
import { answersWithSlates, madeNoApp, readAnswer, readingEvidence } from './ephemeral';

// A one-off visual answer: three treatments of a pricing table to compare in the chat. The answer should be
// ephemeral slates, not an app. Each must show every plan's monthly price and the yearly price the checker computes
// from the seeded discounts; a judge says whether the three are visibly different designs, which nothing here can
// compute, at the agreement `evals/scripts/calibrate-judge.ts` measured.

const MISSION = "Lumen Notes' product workspace: pricing, packaging and the marketing site.";

const PLANS_PATH = '/home/user/pricing/plans.csv';

const PLANS = [
  { plan: 'Starter', monthlyUsd: 19, discountPct: 10, seats: 3, storageGb: 50, support: 'Email' },
  { plan: 'Team', monthlyUsd: 49, discountPct: 15, seats: 10, storageGb: 250, support: 'Chat' },
  { plan: 'Business', monthlyUsd: 129, discountPct: 20, seats: 50, storageGb: 2000, support: 'Phone and chat' },
] as const;

const CSV = `plan,monthly_usd,annual_discount_pct,seats,storage_gb,support\n${PLANS.map((plan) =>
  [plan.plan, plan.monthlyUsd, plan.discountPct, plan.seats, plan.storageGb, plan.support].join(',')).join('\n')}\n`;

const NAMES = PLANS.map((plan) => plan.plan);

/** Twelve months at the plan's price with its annual discount taken off: $205.20, $499.80 and $1,238.40. */
function yearlyUsd(plan: (typeof PLANS)[number]): number {
  return Math.round(plan.monthlyUsd * 12 * (100 - plan.discountPct)) / 100;
}

/** Every plan shows its monthly and yearly price, together, in a part of the page of its own that fits across it. */
function showsEveryPrice(sight: Sight): boolean {
  return PLANS.every((plan) => (sight.regions[plan.plan] ?? []).some((region) => !region.clipped
    && shows(region.text, plan.monthlyUsd) && shows(region.text, yearlyUsd(plan))));
}

/** A fresh chat page draws the answer's slates, at least three, each showing every price; and what each looks like. */
async function everyTreatment(verifier: EvalVerifier): Promise<{ outcome: EvalCheckOutcome; pictures: Uint8Array<ArrayBuffer>[] }> {
  return verifier.browse(async (browser) => {
    const readings = await readAnswer(browser, 3, NAMES, showsEveryPrice);

    return {
      outcome: { pass: readings.length >= 3 && readings.every((reading) => reading.held), evidence: readings.map(readingEvidence) },
      pictures: await Promise.all(readings.map((reading) => reading.view.picture())),
    };
  });
}

const task = defineEvalTask({
  id: 'pricing-treatments',
  mission: MISSION,
  turns: [{
    seed: [{ path: PLANS_PATH, content: CSV }],
    prompt: `We're redesigning the pricing table on our site. Show me three different treatments of the plans in
${PLANS_PATH} so I can compare them side by side. Each one shows every plan's monthly price and its
yearly price with the annual discount taken off.`,
    verify: async (verifier) => {
      await answersWithSlates(verifier, 3);
      await madeNoApp(verifier);

      let pictures: Uint8Array<ArrayBuffer>[] = [];

      await verifier.check('each-treatment-shows-every-price', async () => {
        const drawn = await everyTreatment(verifier);

        pictures = drawn.pictures;

        return drawn.outcome;
      });

      await verifier.check('the-treatments-look-different', async () => {
        if (pictures.length < 3) return { pass: false, evidence: { treatments: pictures.length } };
        const judged = await verifier.judgement(DIFFERENT_DESIGNS, pictures);

        return { pass: judged.verdict === true, evidence: { judged, treatments: pictures.length } };
      });

      await verifier.check('a-reload-shows-the-same', async () => (await everyTreatment(verifier)).outcome);
    },
  }],
});

defineTaskEval(task);
