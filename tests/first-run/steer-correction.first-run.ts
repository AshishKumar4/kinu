/**
 * A correction sent while the agent is working, through the composer's own steer: the words must
 * reach the work, whether the running turn reads them at a step or they run as the next turn.
 * Then a second turn lists the files, so the answer has to agree with what the workspace holds.
 */
import { afterAll, describe, test } from 'vitest';
import type { EvalObservation } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { LISTING_TURN, STEER, STEER_TURN, steerSubgoals } from './steer-observation';

const SUITE = 'First-run · steer-correction';

const CASE = 'steer-correction' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      // No genesis turn: the steer has to interrupt the case's own turn, not one the workspace opened.
      genesis: false,
      purpose: 'A senior engineer who follows the latest instruction and keeps files where asked.',
      modelCalls: 'expected',
      async run({ session }) {
        // The composer's race, driven on purpose: the turn is submitted and the correction goes in
        // while it is open. The DO answers `mid-turn` or `turn`, and both are correct.
        const submission = session.submit(STEER_TURN);
        const landing = await session.steer(STEER);
        await submission.settled;
        await session.prompt(LISTING_TURN);

        const [steered, wal, history] = await Promise.all([
          session.readFile('notes/steered.txt', { allowMissing: true }),
          session.readFile('notes/wal.txt', { allowMissing: true }),
          session.history(),
        ]);

        return steerSubgoals({ landing, steered, wal, history });
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the corpus and the
 *  defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
