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
import { runTuiInPty } from '../../packages/cli/tests/helpers/pty-screen';
import {
  FIRST_RUN_DEFECTS, firstRunPlan, publishFirstRunRecord, runFirstRunCase,
  type FirstRunSubgoal,
} from './first-run';

const SUITE = 'First-run · enter-sends';
const CASE = 'enter-sends' as const;

/** The product path this case drives, as a file a pty child can execute. */
const ENTRY = resolve(import.meta.dirname, 'fixtures/pty-cloud-chat.ts');

/** What the composer must be showing before a key means anything. The TUI paints
 *  the workspace name once the client is connected and the hub is read, so this
 *  is the product's own "ready", not a sleep. */
const READY_TIMEOUT_MS = 60_000;

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

const PLAN = firstRunPlan(SUITE);
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
        };

        const subgoals: FirstRunSubgoal[] = [];
        for (const spelling of SPELLINGS) {
          // The keystrokes a person makes: the words, a beat, then Enter. The
          // beat is the composer's own — a draft is not sendable before it is
          // rendered — and the wait before it is the TUI proving it connected.
          const run = runTuiInPty(ENTRY, {
            env,
            steps: [
              { wait: session.workspace, timeout: READY_TIMEOUT_MS / 1_000 },
              { send: `${spelling.marker} reply with only OK` },
              { sleep: 2 },
              { send: spelling.bytes },
              { sleep: 6 },
            ],
          });
          const connected = run.waits.every((wait) => wait.found);
          // THE DEPLOYMENT'S OWN RECORD, not the screen. A composer that painted
          // the text and sent nothing is exactly the defect, and the screen
          // cannot tell those apart.
          const landed = await turnLanded(session, spelling.marker);
          subgoals.push({
            what: spelling.what,
            reached: connected && landed,
            detail: !connected
              ? `the TUI never showed ${session.workspace} on a real pty, so no key was pressed `
                + `in a connected composer: ${JSON.stringify(run.screen.slice(-240))}`
              : landed
                ? `${spelling.marker} is a user row in the deployed transcript`
                : `Enter did NOT send: ${spelling.marker} was typed into the composer and the `
                  + 'deployment recorded no user turn carrying it. Last frame: '
                  + JSON.stringify(run.screen.slice(-240)),
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
