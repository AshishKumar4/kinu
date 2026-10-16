/**
 * The owner's alerts through the real dev stack (owner, 2026-10-15: "I only want a sound if the agent turn finishes and
 * I'm not on the tab, or something needs my attention"). A turn of ten tool calls makes no sound and no notification
 * while the owner looks at the page; the same turn with the tab hidden makes one of each, at its end; a parked command's
 * approval makes one of each. Away is away from Kinu: with a second tab of it in front, nothing; both tabs hidden, one
 * alert for the browser; another device looking, nothing; both devices away, one alert each. Every sound a page can
 * make is counted, so the desktop client's old bell, or any other, would show as a sound too. The roster's frames are
 * read as the page's own listener finishes each one. */
import { afterAll, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { createWorkspace, LOOPBACK_IDENTITY } from '../../evals/src/workspace-roster';
import { SCRIPTED_MODEL_SPEC } from '../../packages/test-utils/src/scripted-model-spec';
import { frameLedger, typeIntoComposer, until, waitOn } from '../../scripts/browser-page';
import { withLiveApp } from '../../scripts/live-app-harness';
import { registerScriptedModel, startScriptedModel } from '../../scripts/scripted-model';
import type { ScriptedAnswer, ScriptedRequest } from '../../scripts/scripted-protocol';

const TEN_ASK = 'Alerts probe: run ten commands.';

const PARK_ASK = 'Alerts probe: push the alerts release.';

/** Trips the gate's force-push rule, so it waits on the owner's approval; it reaches nothing if it ran. */
const PARKED = 'git --git-dir=/dev/null push --force origin alerts-release';

function alertsTurn(request: ScriptedRequest): ScriptedAnswer {
  if (request.ask.includes(TEN_ASK)) {
    const ran = request.askTurn.filter((call) => call.name === 'shell').length;

    return ran < 10 ? { toolCall: { name: 'shell', arguments: { runtime: 'workspace', command: `echo alert-${String(ran + 1)}` } } } : { text: 'TEN RAN' };
  }

  if (request.ask.includes(PARK_ASK)) {
    return request.askTurn.length === 0 ? { toolCall: { name: 'shell', arguments: { runtime: 'workspace', command: PARKED } } } : { text: 'PARKED' };
  }

  return { text: 'Done.' };
}

/**
 * Counts, in every frame, each sound and notification a document can make, and records each roster frame once the
 * app's own listener has run on it: the alert, if any, is decided by then.
 */
const COUNTERS = `(() => {
  const root = () => document.documentElement;
  // A headless tab is never hidden, whatever is in front of it: the tab the owner left is \`data-hidden\` on the root.
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (root().dataset.hidden === '1' ? 'hidden' : 'visible') });
  // The root does not exist yet as this runs: the document is watched for it.
  let hidden;
  new MutationObserver(() => {
    if (root()?.dataset.hidden === hidden) return;
    hidden = root()?.dataset.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-hidden'] });
  const bump = (name) => { root().dataset[name] = String(Number(root().dataset[name] ?? '0') + 1); };
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (...args) { bump('tones'); return start.apply(this, args); };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) { bump('plays'); return play.apply(this, args); };
  const Shown = window.Notification;
  window.Notification = new Proxy(Shown, { construct(target, args) { bump('notices'); return Reflect.construct(target, args); } });
  const Socket = window.WebSocket;
  window.WebSocket = new Proxy(Socket, { construct(target, args) {
    const socket = Reflect.construct(target, args);
    if (!String(args[0]).includes('/api/user/workspaces/live')) return socket;
    const add = socket.addEventListener.bind(socket);
    socket.addEventListener = (type, listener, options) => add(type, type !== 'message' ? listener : (event) => {
      listener(event);
      const seen = JSON.parse(root().dataset.roster ?? '[]');
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'workspace' && frame.entry) seen.push([frame.name, frame.entry.overview?.activity ?? null, frame.entry.decisions]);
        if (frame.type === 'account_foreground') root().dataset.accountLooking = String(frame.looking);
      } catch {}
      root().dataset.roster = JSON.stringify(seen);
    }, options);
    return socket;
  } });
})()`;

const CountsSchema = v.object({ tones: v.number(), plays: v.number(), notices: v.number() });

/** Sounds heard (a chime is two notes; any media play is a sound too) and notifications shown, so far. */
async function counts(page: Page): Promise<{ sounds: number; notices: number }> {
  const read = v.parse(CountsSchema, await page.evaluate(() => {
    const data = document.documentElement.dataset;

    return { tones: Number(data.tones ?? '0'), plays: Number(data.plays ?? '0'), notices: Number(data.notices ?? '0') };
  }));

  return { sounds: read.tones / 2 + read.plays, notices: read.notices };
}

/** Whether the roster has told the page, since frame `from`, that the workspace stopped working with `decisions`. */
const rosterSettled = (workspace: string, from: number, decisions: number) => `(() => {
  const seen = JSON.parse(document.documentElement.dataset.roster ?? '[]').slice(${String(from)}).filter(([name]) => name === ${JSON.stringify(workspace)});
  const worked = seen.findIndex(([, activity]) => activity === 'working');
  return worked >= 0 && seen.slice(worked).some(([, activity, held]) => activity !== 'working' && held === ${String(decisions)});
})()`;

const rosterSeen = async (page: Page) => v.parse(v.number(), await page.evaluate(`JSON.parse(document.documentElement.dataset.roster ?? '[]').length`));

/** A tab of Kinu on the workspace, counting its sounds, focused as a window in front is: the owner's, until it hides. */
async function openTab(open: () => Promise<Page>, origin: string, workspace: string): Promise<Page> {
  const page = await open();
  const cdp = await page.createCDPSession();

  await page.setViewport({ width: 1280, height: 860 });
  await page.evaluateOnNewDocument(COUNTERS);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'load' });
  await until(page, 'the live composer', `[...document.querySelectorAll('#chat textarea')].some((t) => !t.disabled)`);

  return page;
}

/** Shows or hides each tab, then waits until every tab's roster socket says the account's pages looked at number `looking`. */
async function lookAt(tabs: readonly { readonly page: Page; readonly hidden: boolean }[], looking: number): Promise<void> {
  for (const { page, hidden } of tabs) await page.evaluate((hide) => { document.documentElement.dataset.hidden = hide ? '1' : '0'; }, hidden);

  for (const { page } of tabs) await until(page, `the account to count ${String(looking)} page(s) looked at`, `document.documentElement.dataset.accountLooking === '${String(looking)}'`);
}

/** Sends `ask` from `page`'s composer and waits for its turn's close and for every tab to have heard the roster say so,
 *  with `decisions` then waiting. */
async function runTurn(page: Page, ask: string, { tabs, workspace, decisions }: { tabs: readonly Page[]; workspace: string; decisions: number }): Promise<void> {
  const from = await Promise.all(tabs.map(rosterSeen));
  const composer = await typeIntoComposer(page, ask);
  const ledger = await frameLedger(page);

  try {
    await composer.press('Enter');
    await waitOn(page, "the turn's close on its socket", ledger.turnClosed());
  } finally {
    await ledger.stop();
  }

  for (const [at, tab] of tabs.entries()) await until(tab, 'the roster to say the turn ended', rosterSettled(workspace, from[at] ?? 0, decisions));
}

/** Sounds and notifications over every tab, so far. */
async function total(tabs: readonly Page[]): Promise<{ sounds: number; notices: number }> {
  const each = await Promise.all(tabs.map(counts));

  return { sounds: each.reduce((sum, tab) => sum + tab.sounds, 0), notices: each.reduce((sum, tab) => sum + tab.notices, 0) };
}

/** What a step added to `before`. */
const since = (before: { sounds: number; notices: number }, after: { sounds: number; notices: number }) => ({ sounds: after.sounds - before.sounds, notices: after.notices - before.notices });

type Heard = { sounds: number; notices: number };

interface AlertsVerdict {
  readonly looking: Heard;
  readonly away: Heard;
  readonly approval: Heard;
  /** Two tabs of one browser: one in front, then both hidden. */
  readonly tabFront: Heard;
  readonly tabsAway: Heard;
  /** Two devices: one looking, then both away. */
  readonly deviceLooking: Heard;
  readonly devicesAway: Heard;
}

let verdict: AlertsVerdict | null = null;

afterAll(() => { process.stderr.write(`live-app-alerts verdict: ${JSON.stringify(verdict)}\n`); });

test('silent while the owner looks at Kinu anywhere; once at a turn\'s end or an approval while away, once per browser', async () => {
  const model = await startScriptedModel(alertsTurn);

  try {
    await withLiveApp(async ({ browser, newPage, origin }) => {
      await registerScriptedModel(origin, model.baseURL);
      await browser.defaultBrowserContext().overridePermissions(origin, ['notifications']);
      const workspace = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-alerts-${String(Date.now() % 100_000)}`, model: SCRIPTED_MODEL_SPEC });

      // One tab.
      const page = await openTab(newPage, origin, workspace);
      let before = await total([page]);

      await lookAt([{ page, hidden: false }], 1);
      await runTurn(page, TEN_ASK, { tabs: [page], workspace, decisions: 0 });
      const looking = since(before, await total([page]));

      before = await total([page]);
      await lookAt([{ page, hidden: true }], 0);
      await runTurn(page, TEN_ASK, { tabs: [page], workspace, decisions: 0 });
      const away = since(before, await total([page]));

      // A second tab of the same browser.
      const second = await openTab(newPage, origin, workspace);
      const tabs = [page, second];

      before = await total(tabs);
      await lookAt([{ page, hidden: true }, { page: second, hidden: false }], 1);
      await runTurn(page, TEN_ASK, { tabs, workspace, decisions: 0 });
      const tabFront = since(before, await total(tabs));

      before = await total(tabs);
      await lookAt([{ page, hidden: true }, { page: second, hidden: true }], 0);
      await runTurn(page, TEN_ASK, { tabs, workspace, decisions: 0 });
      const tabsAway = since(before, await total(tabs));

      await second.close();

      // Another device: a browser of its own, signed in to the same account.
      const device = await browser.createBrowserContext();

      await device.overridePermissions(origin, ['notifications']);
      const phone = await openTab(() => device.newPage(), origin, workspace);
      const devices = [page, phone];

      before = await total(devices);
      await lookAt([{ page, hidden: true }, { page: phone, hidden: false }], 1);
      await runTurn(page, TEN_ASK, { tabs: devices, workspace, decisions: 0 });
      const deviceLooking = since(before, await total(devices));

      before = await total(devices);
      await lookAt([{ page, hidden: true }, { page: phone, hidden: true }], 0);
      await runTurn(page, TEN_ASK, { tabs: devices, workspace, decisions: 0 });
      const devicesAway = since(before, await total(devices));

      await phone.close();
      await device.close();

      // Last, as the decision it leaves waits for the rest of the run: a turn that ends on it is that decision still.
      before = await total([page]);
      await runTurn(page, PARK_ASK, { tabs: [page], workspace, decisions: 1 });
      const approval = since(before, await total([page]));

      verdict = { looking, away, approval, tabFront, tabsAway, deviceLooking, devicesAway };
    });
  } finally {
    await model.stop();
  }

  expect(verdict).toEqual({
    looking: { sounds: 0, notices: 0 }, away: { sounds: 1, notices: 1 }, approval: { sounds: 1, notices: 1 },
    tabFront: { sounds: 0, notices: 0 }, tabsAway: { sounds: 1, notices: 1 },
    deviceLooking: { sounds: 0, notices: 0 }, devicesAway: { sounds: 2, notices: 2 },
  });
});
