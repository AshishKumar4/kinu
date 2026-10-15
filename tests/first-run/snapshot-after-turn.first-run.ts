/**
 * FIRST RUN: the workspace still opens after its first answer.
 *
 * THE DEFECT. The agent answered, and the page then said "Couldn't open this
 * workspace. SQL query failed: no such column: actor_id", with no model in the
 * composer. The transcript table is the Agents SDK's: Think creates and writes
 * it with no actor column, and Kinu's snapshot counted it with one.
 *
 * WHY EVERY GATE STAYED GREEN. Every suite seeded that table from Kinu's copy
 * of the DDL, which carried the column. `unit-pane-store-shape.test.ts` now
 * holds the copy to the installed SDK; this case is the product half — a turn
 * through the real socket, then the read the web app makes on open.
 */
import { afterAll, describe, test } from 'vitest';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · snapshot-after-turn';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'After the first answer, the workspace would not open: "Couldn\'t open this workspace. '
    + 'SQL query failed: no such column: actor_id", and the composer showed no model beside a '
    + 'turn that had just run.',
  missedBecause: 'the transcript table is the Agents SDK\'s, created and written by Think with no '
    + 'actor column, and Kinu read it with one. Every suite built the table from Kinu\'s own '
    + 'copy of the DDL, so the reads were never run over the shape the deployment has; nothing '
    + 'sent a turn through the product and then made the read the web app makes on open.',
  provedRedAt: 'cc82601c4',
  redDirection: 'one real turn over the public socket, then `getWorkspaceSnapshot` as the web app '
    + 'calls it: it must answer, count both messages, and name a model. RED at cc82601c4 on the '
    + 'first of the three.',
};

const PLAN = firstRunCasePlan(SUITE, 'snapshot');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      defect: DEFECT,
      modelCalls: 'expected',
      budgetMs: 5 * 60_000,
      purpose: 'A terse assistant. Reply with one short line and use no tools.',
      async run({ session }) {
        await session.prompt('Reply with only OK.');
        const subgoals: EvalSubgoal[] = [];

        // The read itself is the first assertion: before the fix it threw.
        let snapshot: Awaited<ReturnType<typeof session.snapshot>> | null = null;
        let failure = '';

        try {
          snapshot = await session.snapshot();
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }

        subgoals.push({
          what: 'snapshot-answers', reached: snapshot !== null,
          detail: snapshot === null ? failure : 'getWorkspaceSnapshot answered after the turn',
        });
        subgoals.push({
          what: 'counts-the-turn', reached: (snapshot?.messageCount ?? 0) >= 2,
          detail: `messageCount=${String(snapshot?.messageCount ?? 'none')} (the ask and the answer)`,
        });
        subgoals.push({
          what: 'names-a-model', reached: (snapshot?.model ?? '') !== '',
          detail: `model=${JSON.stringify(snapshot?.model ?? '')}`,
        });

        return subgoals;
      },
    }, observations);
  });
});
