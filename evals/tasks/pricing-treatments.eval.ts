import { WORKSPACE_ROOT } from '@kinu.run/core';
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

/**
 * The treatment names every plan and shows its monthly and yearly price, all within the chat's width. Read over the
 * whole treatment, not plan by plan: pricing copy names other plans ("everything in Team, plus"), so no part of a card
 * names one plan alone.
 */
function showsEveryPrice(sight: Sight): boolean {
  return PLANS.every((plan) => sight.text.toLowerCase().includes(plan.plan.toLowerCase())
    && shows(sight.text, plan.monthlyUsd) && shows(sight.text, yearlyUsd(plan)));
}

/** A fresh chat page draws the answer's slates, at least three, each showing every price. */
function everyTreatment(verifier: EvalVerifier): Promise<EvalCheckOutcome> {
  return verifier.browse(async (browser) => {
    const readings = await readAnswer(browser, 3, [], showsEveryPrice);

    return { pass: readings.length >= 3 && readings.every((reading) => reading.held), evidence: readings.map(readingEvidence) };
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

      await verifier.check('each-treatment-shows-every-price', () => everyTreatment(verifier));

      // Pictured in a browser of its own, so a picture that cannot be taken fails this check alone.
      await verifier.check('the-treatments-look-different', () => verifier.browse(async (browser) => {
        const views = await browser.answerSlates(await browser.open(), 3);
        const pictures: Uint8Array<ArrayBuffer>[] = [];

        // One at a time: each is scrolled into view to be pictured.
        for (const view of views) pictures.push(await view.picture());

        const judged = await verifier.judgement(DIFFERENT_DESIGNS, pictures);

        return { pass: views.length >= 3 && judged.verdict === true, evidence: { judged, treatments: views.length } };
      }));

      await verifier.check('a-reload-shows-the-same', () => everyTreatment(verifier));
    },
  }],
});

defineTaskEval(task);
