/**
 * FIRST RUN: Enter sends, whichever byte the terminal chose.
 *
 * THE DEFECT. The owner typed a message in the TUI and pressed Enter. Nothing
 * was sent. A tty can deliver Enter as CR or as LF — the kernel translates CR to
 * NL when the line discipline has ICRNL set, and a terminal that answered LNM
 * sends LF outright — and only the `return` key name was bound to submit, so the
 * LF spelling reached opentui's own default table, which opens a line.
 *
 * WHY EVERY GATE STAYED GREEN. The in-process suites drive `createTestRenderer`,
 * which negotiates no keyboard protocol with any terminal and delivered CR. The
 * test pressed the byte its author knew about; the terminal sends the other one.
 *
 * WHAT THIS CASE ADDS OVER `composer-enter-pty.test.ts`. That suite is a real
 * pty and it is the right shape — it is what caught the defect once the cause
 * was known. It drives a FAKE agent, so what it proves is that the composer's
 * key table fires. This case runs the whole first-run path instead: the shipped
 * `runTuiChat` against a DEPLOYED workspace over the real socket, and the
 * assertion is not that a fixture reply painted but that the DEPLOYMENT recorded
 * the user's turn. Between the key table and the durable transcript sit the
 * client, the ticket, the socket and the DO, and none of them is exercised by a
 * fixture reply.
 *
 * BOTH SPELLINGS, ONE WORKSPACE. Each run sends its own marker, so the two turns
 * are told apart in one transcript and neither can be credited with the other's
 * landing. CR first, because that is the spelling that always worked: a run
 * where BOTH are missing is a broken harness rather than a regression, and the
 * failure says so.
 */
import { afterAll, describe, test } from 'vitest';
import { resolve } from 'node:path';

import { workerSession, type EvalObservation } from '@kinu.run/test-utils';
import { TUI_COMPOSER_PLACEHOLDER, TUI_COMPOSER_STEERING_PLACEHOLDER } from '../../packages/core/src/index';
import { runTuiInPty } from '../../packages/cli/tests/helpers/pty-screen';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
  type FirstRunSubgoal,
} from './first-run';

const SUITE = 'First-run · enter-sends';
const CASE = 'enter-sends' as const;

/** The product path this case drives, as a file a pty child can execute. */
const ENTRY = resolve(import.meta.dirname, 'fixtures/pty-cloud-chat.ts');

/** The bound on each screen signal the run waits for — the connect card, the
 *  composer's own placeholder, the draft echo, the running-turn placeholder.
 *  Every wait is on text the product paints, never a sleep; this is only how
 *  long the deployment gets to paint it. In the DRIVER's unit: seconds. */
const READY_SECONDS = 60;

/** How long the deployed turn is given to become a durable user row. A turn is
 *  recorded when the DO accepts it, which is long before the model answers, so
 *  this waits on the transcript rather than on the reply. */
const LANDING_MS = 60_000;
const LANDING_PROBES = 30;

/** One spelling of Enter, and the words the run types before pressing it. */
interface Spelling {
  readonly what: string;
  readonly bytes: string;
  readonly marker: string;
}

const SPELLINGS: readonly Spelling[] = [
  { what: 'enter-as-cr', bytes: '\r', marker: 'KINU-FIRST-RUN-CR' },
  { what: 'enter-as-lf', bytes: '\n', marker: 'KINU-FIRST-RUN-LF' },
];

const PLAN = firstRunCasePlan(SUITE, CASE);
const liveTest = test.skipIf(PLAN === null);
const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE,
      purpose: 'A terse assistant. Reply with one short line and use no tools.',
      async run({ session, plan }) {
        const env = {
          KINU_FIRST_RUN_ORIGIN: plan.origin,
          KINU_FIRST_RUN_TOKEN: workerSession(plan.llm).token,
          KINU_FIRST_RUN_WORKSPACE: session.workspace,
          // The pty helper reads PATH only out of `options.env`, never
          // `process.env`, and the vitest preload strips nothing from this
          // process's PATH — but the value here is also the harness's own, so
          // the child finds the same python3 and bun it does.
          PATH: process.env.PATH ?? '',
        };

        const subgoals: FirstRunSubgoal[] = [];
        for (const spelling of SPELLINGS) {
          const draft = `${spelling.marker} reply with only OK`;
          // The keystrokes a person makes, each after the screen fact a person
          // would wait for. The driver reads the SCREEN — the cell grid the
          // terminal shows — so a word the renderer painted by rewriting only
          // its changed cells still counts as shown.
          const run = runTuiInPty(ENTRY, {
            env,
            steps: [
              // THE FIRST THING A FIRST RUN MEETS is the connect offer: the TUI
              // raises "link this computer?" as a card over the transcript and
              // every keystroke goes to the card until it is answered. The card
              // is WAITED FOR by its own words and answered with its own key
              // (`device.not-now`, tui/actions.tsx:109).
              { wait: 'not now', timeout: READY_SECONDS },
              { send: 'n' },
              // THE CARD DOES NOT COVER THE COMPOSER. The composer placeholder
              // is on screen under the card from the moment the client
              // connects, so it proves nothing about who gets the next key.
              // The card LEAVING the screen is the render that gives the
              // composer its focus back. A key typed before that render has
              // no taker: the card has let go and the composer has not yet
              // taken hold. Measured 2026-09-05 on the local fixture
              // (`connect-card-pty.test.ts`), three runs each: a draft typed
              // straight after the card's key was lost whole, and a draft
              // typed after the card left was echoed and sent.
              { gone: 'not now', timeout: READY_SECONDS },
              { wait: TUI_COMPOSER_PLACEHOLDER, timeout: READY_SECONDS },
              // The draft, then the composer's echo of it: the keys reached
              // the composer, and a draft is not sendable before it is drawn.
              { send: draft },
              { wait: draft, timeout: READY_SECONDS },
              { send: spelling.bytes },
              // The composer's running-turn placeholder is painted by the same
              // render that follows the client's `turn-start`, which the cloud
              // client emits in the same tick it writes the request to the
              // socket. Once it is on screen the deployment has the frame.
              { wait: TUI_COMPOSER_STEERING_PLACEHOLDER, timeout: READY_SECONDS },
            ],
          });
          const unmet = run.waits.find((wait) => !wait.met);
          // THE DEPLOYMENT'S OWN RECORD, not the screen. A composer that painted
          // the text and sent nothing is exactly the defect, and the screen
          // cannot tell those apart.
          const landed = await turnLanded(session, spelling.marker);
          const screen = `Screen as the run left it: ${JSON.stringify(run.screen)}`;
          subgoals.push({
            what: spelling.what,
            reached: unmet === undefined && landed,
            detail: unmet !== undefined
              ? `the screen never ${unmet.until === 'gone' ? 'cleared' : 'showed'} ${JSON.stringify(unmet.text)} `
                + `within ${String(READY_SECONDS)}s on a real pty, so the run stopped there`
                + `${landed ? ' (the deployment holds the turn regardless)' : ' and no draft was sent'}. ${screen}`
              : landed
                ? `${spelling.marker} is a user row in the deployed transcript`
                : `Enter did NOT send: ${spelling.marker} was typed into the composer and the `
                  + `deployment recorded no user turn carrying it. ${screen}`,
          });
        }
        return subgoals;
      },
    }, observations);
  });
});

/** Whether the deployment holds a user row carrying `marker`, polled until it
 *  does or the bound passes. A turn is durable the moment the DO accepts it;
 *  the poll exists because acceptance and this process are on two machines. */
async function turnLanded(
  session: { history(): Promise<readonly { role: string; text: string }[]> },
  marker: string,
): Promise<boolean> {
  const deadline = Date.now() + LANDING_MS;
  const between = Math.floor(LANDING_MS / LANDING_PROBES);
  for (;;) {
    const history = await session.history();
    if (history.some((row) => row.role === 'user' && row.text.includes(marker))) return true;
    if (Date.now() >= deadline) return false;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, between);
    await tick.promise;
  }
}

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
