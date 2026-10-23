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
 *   parked commands' card renders in its attention stack (where asks are
 *   decided, 35495c16c: two or more parked commands are one card, chosen by
 *   their boxes), the Approve button is clicked, and NO CHECKBOX IS LEFT
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
import type { Browser, ElementHandle, Page } from 'puppeteer';
import * as v from 'valibot';

import { scratchDir, workerSession, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import type { PublicSessionPlan } from '../../evals/src/session';
import type { DeviceAccount } from './device-session';
import { attachMachine, detachMachine, grantDeviceConsent, type AttachedMachine } from './daemon';
import { approvalClearsSelection, isApprovalButtonLabel } from './approval-observation';
import { openBrowser, signedInPage } from '../../evals/src/browser';
import type { TestChrome } from '../../scripts/test-chrome';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · approve-clears';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'Approving the parked commands re-ticked every checkbox instead of clearing them, so '
    + 'the queue looked like it had refilled itself.',
  missedBecause: 'the queue\'s own tests drive the RPC and the read model, where the decided '
    + 'row does disappear. Nothing clicked the button, and the re-tick is in the component: '
    + 'selection is `null`-means-everything and the decision resets it to `null`.',
  provedRedAt: null,
  redDirection: 'both halves are asserted — the RPC half (the decided row is gone and the '
    + 'approved command then runs) and the UI half (no checkbox is left checked after the '
    + 'click). The UI half is the one that was red by hand.',
};

/** The machine this case attaches. One is enough: the subject is the queue, and
 *  the fleet is the next case's subject. */
const MACHINE = 'kinu-first-run-approve';

/** The most wall time the case may take once its session is open. A signed-in
 *  page has no default timeout (`signedInPage`): each wait on it ends when the
 *  card it waits for shows, or this budget ends the case with the evidence as it
 *  stands. With neither, a card that never renders is a silent hang of the whole
 *  tier, which is how the 7fecf0225 staging run ended. A green run takes well
 *  under a minute. */
const BUDGET_MS = 5 * 60_000;

const PLAN = firstRunCasePlan(SUITE, 'approve');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

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
        defect: DEFECT,
        modelCalls: 'expected',
        budgetMs: BUDGET_MS,
        purpose: 'A careful assistant working on the owner\'s own machine.',
        async run({ session }) {
          const machine = await attachMachine({
            account, name: MACHINE, home: scratchDir('first-run-approve'),
          });

          held.machine = machine;
          await grantDeviceConsent(account, machine.deviceId, session.workspace);

          // The thing the gated command will destroy, on the machine, created
          // by this case. Its disappearance is the proof that a permission
          // became an effect — and only after the owner said yes. In a folder
          // of the home, not directly in it: the home lacks a run-later file, so
          // it is sealed, and where the kernel has no Landlock (armada's microVM)
          // the seal is mounts, which keep an entry directly in it too
          // (pc-agent daemon/landlock.js; its removal there is a pc-agent test).
          const doomed = join(machine.home, 'first-run', 'doomed');
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
          // Two more parked rows, so the browser has something to approve that
          // the RPC half did not already clear, and one card holds them with a
          // box each: the stack batches two or more. Same command shape,
          // different directories, same rule.
          const clickCommands = ['doomed-by-click-a', 'doomed-by-click-b'].map((name) => {
            const dir = join(machine.home, name);
            mkdirSync(dir, { recursive: true });

            return `rm -r ${JSON.stringify(dir)}`;
          });

          for (const clickCommand of clickCommands) await session.execute('device', clickCommand);
          const clickIds = (await session.parkedCommands()).filter((entry) => clickCommands.includes(entry.command)).map((entry) => entry.id);
          const browser = await openBrowser();
          held.browser = browser;
          const clicked = await approveThroughTheButton(browser.browser, PLAN, session.workspace, clickIds);
          const clickStillQueued = (await session.parkedCommands()).some((entry) => clickIds.includes(entry.id));

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
                  + `of ${String(clicked.boxesBefore)}); commands ${clickStillQueued ? 'remain queued' : 'left the queue'}`
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
 * Load the deployed workspace in Chrome, click Approve on the parked commands' card, and count the boxes.
 *
 * The counts come from the DOM rather than from React state, because the defect
 * was a rendered checkbox: a person saw ticks after clicking Approve, and what
 * the component believed about `selected` is not the claim.
 */
async function approveThroughTheButton(
  browser: Browser, plan: PublicSessionPlan, workspace: string, ids: readonly string[],
): Promise<ButtonRun> {
  const empty = { boxesBefore: 0, checkedBefore: 0, boxesAfter: 0, checkedAfter: 0 };

  if (ids.length < 2) return { approved: false, why: `the queue held ${String(ids.length)} of the two parked rows, so no card batches them`, ...empty };
  const page = await signedInPage(browser, plan);

  try {
    return await drive({ page, origin: plan.origin, workspace, ids, empty });
  } finally {
    await page.close();
  }
}

/** The page's own walk to the card and back. Split out so the navigation and
 *  the failure wording are one readable sequence. */
interface DriveOptions {
  readonly page: Page;
  readonly origin: string;
  readonly workspace: string;
  /** The parked rows the card must hold, by their queue ids. */
  readonly ids: readonly string[];
  readonly empty: Omit<ButtonRun, 'approved' | 'why'>;
}

/** Whether the stack's open card holds a box for every one of `ids`. */
function cardHolds(ids: readonly string[]): boolean {
  return ids.every((id) => document.querySelector(`[data-attention-card] [data-parked-command="${id}"] input[type="checkbox"]`) !== null);
}

/** Whether the card holds them, or waits behind another ask whose row names one of them. */
function cardOrRowShown(ids: readonly string[]): boolean {
  return ids.every((id) => document.querySelector(`[data-attention-card] [data-parked-command="${id}"] input[type="checkbox"]`) !== null)
    || ids.some((id) => document.querySelector(`[data-attention-behind="action:${id}"]`) !== null);
}

/** The open card's boxes, and how many are ticked. */
function cardBoxes() {
  const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-attention-card] [data-parked-command] input[type="checkbox"]')];

  return { boxes: boxes.length, checked: boxes.filter((box) => box.checked).length };
}

async function drive({ page, origin, workspace, ids, empty }: DriveOptions): Promise<ButtonRun> {
  await page.goto(`${origin}/workspace/${encodeURIComponent(workspace)}`, { waitUntil: 'domcontentloaded' });
  // The parked card is the stack's open one, or waits behind another ask, whose row opens it. A card that never shows
  // ends the case on its budget.
  await page.waitForFunction(cardOrRowShown, {}, ids);

  if (!v.parse(v.boolean(), await page.evaluate(cardHolds, ids))) {
    const behind = await page.$(ids.map((id) => `[data-attention-behind="action:${id}"]`).join(', '));

    await behind?.click();
    await page.waitForFunction(cardHolds, {}, ids);
  }

  let approve: ElementHandle | null = null;

  // The open card's Approve button: "Approve all" for a whole batch.
  for (const candidate of await page.$$('[data-attention-card] button')) {
    if (isApprovalButtonLabel(await candidate.evaluate((node) => node.textContent ?? ''))) approve = candidate;
  }

  if (approve === null) return { approved: false, why: `the parked commands' card on ${origin}/workspace/${workspace} holds no Approve button`, ...empty };
  const before = v.parse(BoxCountSchema, await page.evaluate(cardBoxes));
  await approve.click();

  // The click issues an RPC and re-renders. Settling is OBSERVED on the card —
  // its boxes leave their busy state, or the card leaves with its rows.
  await page.waitForFunction(() => document.querySelectorAll('[data-attention-card] [data-parked-command] input[type="checkbox"]:disabled').length === 0);
  const after = v.parse(BoxCountSchema, await page.evaluate(cardBoxes));

  return {
    approved: true, why: '',
    boxesBefore: before.boxes, checkedBefore: before.checked, boxesAfter: after.boxes, checkedAfter: after.checked,
  };
}

const BoxCountSchema = v.object({ boxes: v.number(), checked: v.number() });
