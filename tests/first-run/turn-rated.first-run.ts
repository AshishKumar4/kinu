/**
 * FIRST RUN: an answered turn is rated by the decision model.
 *
 * THE RISK. A deployed workspace rates a turn from the user's reply through its Workers AI binding
 * (`bindingDecisionRun`, providers/decision-model.ts). Every pre-deploy test fakes that binding's answer, so a
 * shape the platform does not return, or a binding that refuses, reads green until nothing is ever rated and the
 * Quality tab stays empty. The shape was measured once on a throwaway Worker (2026-10-02); this row is the check
 * that keeps holding it on the deployment.
 *
 * WHAT IT DOES. One real turn over the public socket, then the reply a person gives it, then `getQuality` as the
 * Quality tab reads it, until a turn is rated. No thumb or pick is given, so every rating is the model's.
 *
 * NO WALL CLOCK. The review runs after the reply, out of turn; the wait ends when a rating is read and is bounded
 * by the case's own budget, so an unrated turn is this row's finding, not its timeout.
 */
import { afterAll, describe, test } from 'vitest';
import type { EvalObservation } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';

const SUITE = 'First-run · turn-rated';

const CASE = 'turn-rated' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, { timeout: 6 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      genesis: false,
      purpose: 'A terse assistant. Reply with one short line and use no tools.',
      modelCalls: 'expected',
      budgetMs: 4 * 60_000,
      async run({ session, budget }) {
        await session.prompt('Summarize what a changelog is for, in one line.');
        // This reply rates the first turn, and a rating landing names `getQuality` in a `reads_changed` frame.
        let heard = session.readsMoved(['getQuality']);
        await session.prompt('That is exactly what I needed for the release notes, thanks.');
        let today = (await session.quality())[0];

        while ((today?.rated ?? 0) === 0 && !budget.aborted) {
          while (session.readsMoved(['getQuality']) === heard && !budget.aborted) await aborted(AbortSignal.any([session.readsMoving, budget]));
          heard = session.readsMoved(['getQuality']);
          today = (await session.quality())[0];
        }

        const rated = today?.rated ?? 0;
        const byModel = rated - (today?.thumbs ?? 0);

        return [
          {
            what: 'turn-rated', reached: rated >= 1,
            detail: today === undefined ? 'getQuality listed no day' : `today: ${JSON.stringify(today)}`,
          },
          {
            what: 'rated-by-the-decision-model', reached: byModel >= 1,
            detail: `${String(byModel)} of ${String(rated)} ratings came from the model; no thumb or pick was given`,
          },
        ];
      },
    }, observations);
  });
});

/** Settles when `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
}

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the corpus and the
 *  defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
