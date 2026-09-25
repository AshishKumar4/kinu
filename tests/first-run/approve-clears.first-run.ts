/**
 * FIRST RUN: approving the parked commands CLEARS them.
 *
 * THE DEFECT. The owner approved a queue of parked commands and every checkbox
 * came straight back ticked, as if the queue had refilled itself. It had not:
 * the rows were decided. The component defaults its selection to "everything"
 * (`selected === null` means the whole queue), the decision resets selection to
 * `null`, and the card re-renders from the same actions array before the queue
 * is re-read — so the click clears the rows and re-ticks their boxes.
 *
 * WHY EVERY GATE STAYED GREEN. The queue's own suites drive the RPC and the read
 * model, where the decided row does disappear — `list()` is `listQueued()`, so
 * the API half was correct and tested. Nobody clicked the button. A defect
 * living between a correct API and a correct-looking render is invisible to
 * every test that calls one of them.
 *
 * SO THIS CASE DRIVES BOTH HALVES, AGAINST ONE WORKSPACE AND ONE QUEUE:
 *
 *   THE MECHANISM, over the public plane — a real gated command parks, the
 *   queue lists it, `decideDeferredApprovals` (the RPC the button is bound to)
 *   approves it, the re-read no longer holds it, and the approved command then
 *   RUNS on the machine, which is the fact a permission is for. Permission is
 *   not an effect: the queue's own doctrine says the grant is spent when the
 *   command is re-issued, and this case re-issues it and reads the bytes.
 *
 *   THE BUTTON, in a real browser — Chrome loads the deployed workspace, the
 *   parked card renders, the Approve button is clicked, and NO CHECKBOX IS LEFT
 *   CHECKED. That is the assertion the owner made by eye.
 *
 * THE GATED COMMAND IS REAL AND SAFE. `rm -r <this run's own scratch directory>`
 * trips `rm-recursive`, whose harm is `local` — and `device` is not one of the
 * agent's own executors, so a local-harm rule gates there and nowhere else. The
 * directory belongs to this case, on the machine this case attached, and its
 * disappearance is how the run proves the approved command really ran.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, test } from 'vitest';
import type { Browser, Page } from 'puppeteer';

import { scratchDir, workerSession, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import type { PublicSessionPlan } from '../../evals/src/session';
import type { DeviceAccount } from './device-session';
import { attachMachine, detachMachine, grantDeviceConsent, type AttachedMachine } from './daemon';
import { approvalClearsSelection, isApprovalButtonLabel } from './approval-observation';
import { openBrowser, signedInPage } from './browser';
import type { TestChrome } from '../../scripts/test-chrome';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';

const SUITE = 'First-run · approve-clears';

const CASE = 'approve-clears' as const;

/** The machine this case attaches. One is enough: the subject is the queue, and
 *  the fleet is the next case's subject. */
const MACHINE = 'kinu-first-run-approve';

/** How long the browser waits for a deployed pane to paint. The app loads its
 *  bundle, opens a socket and reads the queue, so this is a page-load budget
 *  rather than a correctness deadline: what is asserted is what the pane shows
 *  once it has shown anything. */
const PAINT_MS = 30_000;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    const account: DeviceAccount = {
      origin: PLAN.origin,
      cliToken: workerSession(PLAN.llm).token,
      identity: PLAN.identity,
    };

    // ONE NAMED OWNER rather than two loose bindings, and it is load-bearing:
    // the case body is a closure, so after it a plain `let` still reads as its
    // initializer and every teardown line below would be unreachable code the
    // compiler is right about — the device arm's own reason for the same shape.
    const held: CaseState = { machine: null, browser: null };

    try {
      await runFirstRunCase(PLAN, {
        id: CASE,
        modelCalls: 'expected',
        purpose: 'A careful assistant working on the owner\'s own machine.',
        async run({ session }) {
          const machine = await attachMachine({
            account, name: MACHINE, home: scratchDir('first-run-approve'),
          });

          held.machine = machine;
          await grantDeviceConsent(account, machine.deviceId, session.workspace);

          // The thing the gated command will destroy, on the machine, created
          // by this case. Its disappearance is the proof that a permission
          // became an effect — and only after the owner said yes.
          const doomed = join(machine.home, 'doomed');
          mkdirSync(doomed, { recursive: true });
          writeFileSync(join(doomed, 'marker'), 'first-run\n');
          const command = `rm -r ${JSON.stringify(doomed)}`;

          // ── parked ──────────────────────────────────────────────────
          // Through the Env tab's own RPC, which reaches the same gated
          // boundary every other caller does: `gateProviderExec` wraps the
          // provider at registration, so there is no path to this machine that
          // skips the review.
          const first = await session.execute('device', command);
          const firstText = `${first.stdout ?? ''}${first.stderr ?? ''}${first.error ?? ''}`;
          const queued = await session.parkedCommands();
          const row = queued.find((entry) => entry.command === command) ?? null;
          // Read while parked: the approval wakes the agent and the approved
          // command runs before the next read, so a later read cannot show this.
          const survivedTheAsk = existsSync(doomed);

          // ── decided ─────────────────────────────────────────────────
          const decided = row === null ? [] : await session.decideParkedCommands([row.id], 'approved');
          const after = await session.parkedCommands();
          const stillQueued = after.some((entry) => entry.id === row?.id);

          // ── the effect ──────────────────────────────────────────────
          // Re-issued, which is when an approved command runs: the grant is
          // spent at the gate and the command reaches the machine.
          const second = row === null
            ? null
            : await session.execute('device', command);

          const gone = !existsSync(doomed);

          // ── the button ──────────────────────────────────────────────
          // A second parked row, so the browser has something to approve that
          // the RPC half did not already clear. Same command shape, different
          // directory, same rule.
          const alsoDoomed = join(machine.home, 'doomed-by-click');
          mkdirSync(alsoDoomed, { recursive: true });
          const clickCommand = `rm -r ${JSON.stringify(alsoDoomed)}`;
          await session.execute('device', clickCommand);
          const browser = await openBrowser();
          held.browser = browser;
          const clicked = await approveThroughTheButton(browser.browser, PLAN, session.workspace, clickCommand);
          const clickStillQueued = (await session.parkedCommands()).some((entry) => entry.command === clickCommand);

          // The RPC/browser work can finish before genesis makes its first
          // model call. Drain through an explicit turn before collecting spend.
          await session.prompt('The approval checks are finished. Reply with only OK. Do not run commands or use tools.');

          return [
            {
              what: 'parked',
              reached: row !== null && row.executor === 'device',
              detail: row === null
                ? `the gated command did not park: the queue holds ${String(queued.length)} row(s) `
                  + `and the exec answered ${JSON.stringify(firstText.slice(0, 240))}`
                : `${row.id} is parked on ${row.executor}: ${row.command}`,
            },
            {
              what: 'not-run-while-parked',
              reached: survivedTheAsk,
              detail: survivedTheAsk
                ? 'the directory still existed while the command was waiting on the owner'
                : 'THE COMMAND RAN BEFORE ANYBODY APPROVED IT: the directory was gone while its '
                  + 'row was still in the queue',
            },
            {
              what: 'decided',
              reached: row !== null && decided.includes(row.id),
              detail: `decideDeferredApprovals answered ${JSON.stringify(decided)}`,
            },
            {
              what: 'queue-cleared',
              reached: row !== null && !stillQueued,
              detail: stillQueued
                ? `the decided row ${String(row?.id)} is STILL in the queue after approval`
                : `the queue holds ${String(after.length)} row(s) and none of them is the decided one`,
            },
            {
              what: 'approved-command-ran',
              reached: gone,
              detail: gone
                ? 'the re-issued command ran on the machine and the directory is gone'
                : 'the approved command still has not run: the directory is there and the exec '
                  + `answered ${JSON.stringify(String(second?.stdout ?? second?.error ?? '').slice(0, 240))}`,
            },
            {
              what: 'button-clears-every-box',
              reached: clicked.approved && !clickStillQueued && approvalClearsSelection(
                { boxes: clicked.boxesBefore, checked: clicked.checkedBefore },
                { boxes: clicked.boxesAfter, checked: clicked.checkedAfter },
              ),
              detail: clicked.approved
                ? `after the click the card shows ${String(clicked.checkedAfter)} checked box(es) `
                  + `of ${String(clicked.boxesAfter)} (before: ${String(clicked.checkedBefore)} `
                  + `of ${String(clicked.boxesBefore)}); command ${clickStillQueued ? 'remains queued' : 'left the queue'}`
                : `the Approve button was never reached: ${clicked.why}`,
            },
          ] satisfies EvalSubgoal[];
        },
      }, observations);
    } finally {
      await held.browser?.close();

      if (held.machine !== null) {
        const left = await detachMachine(account, held.machine);

        if (left !== null) console.warn(`    [first-run] ${CASE} teardown: ${left}`);
      }
    }
  });
});

/** What this case attached and must put away. A named owner rather than two
 *  loose bindings: the case body is a closure, so a plain `let` still reads as
 *  its initializer afterwards and every teardown line would be unreachable. */
interface CaseState {
  machine: AttachedMachine | null;
  browser: TestChrome | null;
}

/** What the click did, and what the card looked like on both sides of it. */
interface ButtonRun {
  readonly approved: boolean;
  readonly why: string;
  readonly boxesBefore: number;
  readonly checkedBefore: number;
  readonly boxesAfter: number;
  readonly checkedAfter: number;
}

/**
 * Load the deployed workspace in Chrome, click Approve, and count the boxes.
 *

 * The counts come from the DOM rather than from React state, because the defect
 * was a rendered checkbox: a person saw ticks after clicking Approve, and what
 * the component believed about `selected` is not the claim.
 */
async function approveThroughTheButton(
  browser: Browser, plan: PublicSessionPlan, workspace: string, command: string,
): Promise<ButtonRun> {
  const empty = { boxesBefore: 0, checkedBefore: 0, boxesAfter: 0, checkedAfter: 0 };
  const page = await signedInPage(browser, plan.identity);

  try {
    return await drive({ page, origin: plan.origin, workspace, command, empty });
  } finally {
    await page.close();
  }
}

/** The page's own walk to the queue and back. Split out so the header, the
 *  navigation and the failure wording are one readable sequence. */
interface DriveOptions {
  readonly page: Page;
  readonly origin: string;
  readonly workspace: string;
  readonly command: string;
  readonly empty: Omit<ButtonRun, 'approved' | 'why'>;
}

async function drive({ page, origin, workspace, command, empty }: DriveOptions): Promise<ButtonRun> {
  await page.goto(`${origin}/workspace/${encodeURIComponent(workspace)}`, {
    waitUntil: 'domcontentloaded',
  });
  // The tab exists offscreen while the inspector opens. The locator waits
  // for stable click geometry; CSS visibility alone does not establish it.
  await page.locator('button[aria-label="Work"]').setTimeout(PAINT_MS).click();
  // A selector that never appears is this case's finding, not an error to
  // propagate: "the parked card never rendered" is a product answer and the
  // subgoal below states it. Anything that is NOT the wait expiring — a closed
  // page, a navigation error — is rethrown, so a broken harness cannot read as
  // an empty queue.
  let button: Awaited<ReturnType<Page['waitForSelector']>> = null;

  try {
    const panel = await page.waitForFunction(parkedCommandPanel, {}, command);
    const element = panel.asElement();

    if (element !== null) {
      for (const candidate of await element.$$('button')) {
        const label = await candidate.evaluate((node) => node.textContent ?? '');

        if (!isApprovalButtonLabel(label)) continue;
        button = candidate;
        break;
      }
    }
  } catch (cause) {
    // THE WAIT EXPIRING, and nothing else. Puppeteer names that one rejection
    // `TimeoutError`; an expiry is a finding about the product's card, which
    // the subgoal below states, while a closed page or a navigation fault is
    // the harness breaking and must not read as an empty queue.
    if (!(cause instanceof Error) || cause.name !== 'TimeoutError') throw cause;
  }

  if (button === null) {
    return {
      approved: false,
      why: 'the parked-commands card never rendered an Approve button on '
        + `${origin}/workspace/${workspace} within ${String(PAINT_MS)}ms`,
      ...empty,
    };
  }

  const before = await countBoxes(page, command);
  await button.click();

  // The click issues an RPC and re-renders. Settling is observed on the CARD —
  // the button leaves its busy state — rather than waited out on a timer.
  // Settling is OBSERVED on the card — the busy state clearing — and a card
  // that never settles is counted as it stands: the assertion is about which
  // boxes are ticked, and a stuck button with every box ticked is the defect.
  // The expiry is therefore tolerated by name and nothing else is.
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('input[type="checkbox"]:disabled').length === 0,
    );
  } catch (cause) {
    // Same rule: a card that never settles is COUNTED as it stands, because the
    // assertion is about which boxes are ticked and a stuck button with every
    // box ticked is the defect itself.
    if (!(cause instanceof Error) || cause.name !== 'TimeoutError') throw cause;
  }

  const after = await countBoxes(page, command);

  return {
    approved: true,
    why: '',
    boxesBefore: before.boxes,
    checkedBefore: before.checked,
    boxesAfter: after.boxes,
    checkedAfter: after.checked,
  };
}

function parkedCommandPanel(command: string): HTMLElement | null {
  const row = [...document.querySelectorAll('label')].find((label) => label.textContent?.includes(command)
    && label.querySelector('input[type="checkbox"]') !== null);

  return row?.closest('section') ?? null;
}

async function countBoxes(page: Page, command: string): Promise<{ boxes: number; checked: number }> {
  const panel = await page.evaluateHandle(parkedCommandPanel, command);
  const selected = panel.asElement();

  if (selected === null) return { boxes: 0, checked: 0 };

  return selected.evaluate((element) => {
    const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .filter((box) => element.contains(box));

    return { boxes: boxes.length, checked: boxes.filter((box) => box.checked).length };
  });
}

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
