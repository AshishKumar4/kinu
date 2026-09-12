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
import { firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · snapshot-after-turn';

const CASE = 'snapshot-after-turn' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
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
