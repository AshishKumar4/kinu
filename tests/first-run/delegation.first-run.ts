/**
 * FIRST RUN: delegation settles — a hired helper answers, reports back, and retires.
 *
 * THE ASK. Turn one hires a task-lifetime helper to say one specific word, and
 * the turn its answer opens relays it; turn two hires a durable helper and lists
 * the roster; turn three dismisses it and lists again. Every check reads durable
 * state — the ledger's rows, the helper's own ledger, the stored transcript —
 * never the model's own account of what it did.
 *
 * WHY EVERY GATE STAYED GREEN. `every-tool` deliberately EXCLUDES `hire` and
 * asserts `agents` was never called; unit proofs drive the agents tool against
 * fixtures the test author wrote. Nothing asked the deployed agent to hire a
 * helper and then read back whether the hire settled, whether the helper's
 * answer reached the parent, and whether the roster retired the row.
 *
 * THE ANSWER ARRIVES AS A MESSAGE. A hire returns at once (cafab2bfc): the
 * helper's answer opens the hirer's next turn. The row waits on the turns the
 * workspace room broadcasts closing (`hirerHeard`) until that message is in the
 * hirer's history, and reads what the helper answered from its own ledger, so it
 * needs no poll loop and no wall clock of its own. The durable hire, list and
 * dismiss all settle in-turn.
 *
 * SYSTEM-CARD CEILING, AND ITS BLIND SPOT. The conversation must gain no
 * "system, to be shown to the agent" cards beyond SYSTEM_CARD_CEILING, counted
 * over history rows whose role is `system`. What this count CANNOT see: the
 * public session's history drops every row's id and metadata, so a
 * harness-stamped user row (a queued signal's durable message, which the chat
 * renders as an event card rather than a user bubble) is invisible to it. A
 * product that moves its unbounded growth into metadata-stamped user rows
 * passes this subgoal; that half needs a product seam to see, and this row
 * does not add one.
 */
import { afterAll, describe, test } from 'vitest';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { ORCHESTRATOR_AGENT_SLUG } from '../../packages/core/src/index';
import type { KinuPublicSession } from '../../evals/src/session';
import {
  DELEGATION_ROSTER_ASK as ROSTER_ASK, DELEGATION_TASK_ASK as TASK_ASK, DELEGATION_WORD as WORD, delegationDismissAsk,
} from './asks';
import { delivered, finalAnswer, observeDelegationRetirement, observeDurableHire, taskHires } from './delegation-observation';
import { ROOT } from '../../evals/src/helper-address';
import { helperRecord, hirerHeard } from './hires';
import { openPublicSocket } from './public-socket';
import { firstRunSpliceStep, firstRunTurnEvents } from './turn-settlement';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';

const SUITE = 'First-run · delegation';

const CASE = 'delegation' as const;

/** The exact bound the card subgoal holds: delegation may drain at most this many cards. */
const SYSTEM_CARD_CEILING = 2;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

/**
 * Say what each subgoal measured, from inside the case.
 *
 * `runFirstRunCase` prints the same lines AFTER it collects the episode's
 * evidence, and that collection can itself refuse — a row whose product never
 * called a model fails on the model-call contract before any verdict is
 * printed, which is how the first live drive of this row lost its subgoals to
 * a one-line budget error. Printing here costs one line per subgoal and keeps
 * the measurement readable whatever the harness decides afterwards.
 */
function announce(subgoals: readonly EvalSubgoal[]): readonly EvalSubgoal[] {
  for (const subgoal of subgoals) {
    console.warn(`    [delegation] ${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`);
  }

  return subgoals;
}

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

function excerpt(value: string, length = 160): string {
  return JSON.stringify(value.slice(0, length));
}

async function promptEvidence(session: KinuPublicSession, prompt: string) {
  const result = await session.prompt(prompt);
  const [events, history] = await Promise.all([session.runEvents(), session.history()]);

  return firstRunTurnEvents(events, prompt, {
    absorbedBy: result.landed === 'mid-turn' ? result.absorbedBy : undefined,
    splicedAtStep: firstRunSpliceStep(history, prompt),
  });
}

describe(SUITE, () => {
  // THE ROW MUST TERMINATE under the same contract as background-settle: the
  // tier runs with testTimeout 0, so an episode the product leaves open would
  // hold the tier open with it. The case's BUDGET ends the wait the product
  // owes no more of; the harness retains the ledger as found and the verdict
  // reads it. No wall clock of this row's own: no setTimeout, no Date
  // comparison, no per-test timeout beyond this shared shape.
  liveTest(`MEASURED: ${CASE}`, { timeout: 24 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      genesis: false,
      modelCalls: 'expected',
      purpose: 'A lead that has one helper answer one word, shows a second on the roster, and retires it.',
      budgetMs: 20 * 60_000,
      async run({ session, plan, budget }) {
        const subgoals: EvalSubgoal[] = [];
        const room = openPublicSocket(plan.origin, plan.identity, `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`, budget);

        if (!(await room.opened)) throw new Error(`the workspace room ${room.path} refused the upgrade`);

        try {
          // Registered before the hire is sent, so the turn the helper's answer opens cannot close unseen.
          const closed = room.turnClosed();
          const taskEvents = await promptEvidence(session, TASK_ASK);
          const [hire] = taskHires(taskEvents);

          const heard = hire !== undefined
            && await hirerHeard(room, closed, async () => delivered(await session.history(), TASK_ASK, hire.agent) !== null);

          const delivery = hire === undefined ? null : delivered(await session.history(), TASK_ASK, hire.agent);
          const answer = hire === undefined || !heard ? '' : finalAnswer((await helperRecord(room, ROOT, hire.agent)).events);

          let settled = `no task hire answered at once in the requested turn's ${String(taskEvents.length)} events`;

          if (hire !== undefined) {
            settled = delivery === null
              ? `agents#${hire.call.toolCallId} hired ${hire.agent}, whose answer never reached the hirer`
              : `${hire.agent} answered ${excerpt(answer)}, delivered as ${excerpt(delivery.text)}`;
          }

          subgoals.push({ what: 'hire-settles', reached: delivery !== null && answer === WORD, detail: settled });

          subgoals.push({
            what: 'word-reported',
            reached: delivery !== null && answer === WORD && delivery.reply.includes(WORD),
            detail: delivery === null ? 'no delivered answer to read the word off' : `the hirer replied ${excerpt(delivery.reply, 240)}`,
          });
        } finally {
          room.close('the row is done');
        }

        const { durableName, shown } = observeDurableHire(await promptEvidence(session, ROSTER_ASK));

        const retirement = durableName === null
          ? { retired: false, dismisses: 0 }
          : observeDelegationRetirement(await promptEvidence(session, delegationDismissAsk(durableName)), durableName);

        subgoals.push({
          what: 'roster-shows-and-retires',
          reached: durableName !== null && shown && retirement.retired,
          detail: durableName === null
            ? 'no durable hired name on any settled hire result, so the roster cannot be read for it'
            : `helper ${JSON.stringify(durableName)}: roster ${shown ? 'showed' : 'never showed'} it; `
              + `${String(retirement.dismisses)} settled dismiss call(s); a later roster `
              + `${retirement.retired ? 'no longer names' : 'still names or never re-read'} it`,
        });

        const systemRows = (await session.history()).filter((row) => row.role === 'system').length;

        subgoals.push({
          what: 'system-cards-bounded',
          reached: systemRows <= SYSTEM_CARD_CEILING,
          detail: `${String(systemRows)} system row(s) in the conversation against a ceiling of `
            + `${String(SYSTEM_CARD_CEILING)} (blind spot: metadata-stamped harness rows read as `
            + 'user rows over this session — see the header)',
        });

        return announce(subgoals);
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules
 *  (each of which resolves a live plan at import). */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
