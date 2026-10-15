/**
 * A correction sent while the agent is working, through the composer's own steer: the words must
 * reach the work, whether the running turn reads them at a step or they run as the next turn.
 * Then a second turn lists the files, so the answer has to agree with what the workspace holds.
 */
import { afterAll, describe, test } from 'vitest';
import type { EvalObservation } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { LISTING_TURN, STEER, STEER_TURN, steerSubgoals } from './steer-observation';

const SUITE = 'First-run · steer-correction';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'A correction typed while the agent is still working has to reach the work: either the '
    + 'running turn reads it at a step or it runs as the next turn. A correction the product '
    + 'acknowledges and then drops leaves the agent finishing the instruction the user took back.',
  missedBecause: 'unit-mid-turn-steer and the busy-chat workerd probe splice scripted turns; the '
    + "composer's steer against a model on the deployment ran only in the trajectory eval family, "
    + 'which is retired, and no first-run row sends one.',
  provedRedAt: null,
  redDirection: 'Not proved red against a deployed sha: a dropped steer cannot be deployed, and there '
    + 'is no staging. The red direction is proved on planted evidence in steer-observation.test.ts: a '
    + 'correction the running turn never read fails correction-applied, steer-is-durable and '
    + 'listing-truthful, and a steer the workspace never answered fails landing.',
};

const PLAN = firstRunCasePlan(SUITE, 'steer');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      defect: DEFECT,
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
