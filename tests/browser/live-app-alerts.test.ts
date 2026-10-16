/**
 * The owner's alerts through the real dev stack (owner, 2026-10-15: "I only want a sound if the agent turn finishes and
 * I'm not on the tab, or something needs my attention"). A turn of ten tool calls makes no sound and no notification
 * while the owner looks at the page; the same turn with the tab hidden makes one of each, at its end; a parked command's
 * approval card makes one of each. Every sound a page can make is counted, so the desktop client's old bell, or any
 * other, would show as a sound too. The roster's frames are read as the page's own listener finishes each one.
 */
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
      try { const frame = JSON.parse(event.data); if (frame.type === 'workspace' && frame.entry) seen.push([frame.name, frame.entry.overview?.activity ?? null, frame.entry.decisions]); } catch {}
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

/** Sends `ask` from the composer; `away`, the owner leaves the tab before the send lands. */
async function sendTurn(page: Page, ask: string, away: boolean): Promise<void> {
  const composer = await typeIntoComposer(page, ask);
  const ledger = await frameLedger(page);

  try {
    await page.evaluate((hidden) => { document.documentElement.dataset.hidden = hidden ? '1' : '0'; }, away);

    await composer.press('Enter');
    await waitOn(page, "the turn's close on its socket", ledger.turnClosed());
  } finally {
    await ledger.stop();
  }
}

interface AlertsVerdict {
  readonly looking: { sounds: number; notices: number };
  readonly away: { sounds: number; notices: number };
  readonly approval: { sounds: number; notices: number };
}

let verdict: AlertsVerdict | null = null;

afterAll(() => { process.stderr.write(`live-app-alerts verdict: ${JSON.stringify(verdict)}\n`); });

test('ten tool calls: silent while the owner looks; one sound and one notification at the end while away; one for an approval', async () => {
  const model = await startScriptedModel(alertsTurn);

  try {
    await withLiveApp(async ({ browser, newPage, origin }) => {
      await registerScriptedModel(origin, model.baseURL);
      await browser.defaultBrowserContext().overridePermissions(origin, ['notifications']);
      const workspace = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-alerts-${String(Date.now() % 100_000)}`, model: SCRIPTED_MODEL_SPEC });
      const page = await newPage();
      const cdp = await page.createCDPSession();

      await page.setViewport({ width: 1280, height: 860 });
      await page.evaluateOnNewDocument(COUNTERS);
      // A headless page has no focus of its own: the owner at their desk is a page shown and focused.
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await page.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'load' });
      await until(page, 'the live composer', `[...document.querySelectorAll('#chat textarea')].some((t) => !t.disabled)`);

      let from = await rosterSeen(page);

      await sendTurn(page, TEN_ASK, false);
      await until(page, 'the roster to say the looked-at turn ended', rosterSettled(workspace, from, 0));
      const looking = await counts(page);

      from = await rosterSeen(page);
      await sendTurn(page, TEN_ASK, true);
      await until(page, 'the roster to say the turn ended while away', rosterSettled(workspace, from, 0));
      const afterAway = await counts(page);

      from = await rosterSeen(page);
      await sendTurn(page, PARK_ASK, true);
      await until(page, 'the roster to say the turn parked its command', rosterSettled(workspace, from, 1));
      const afterApproval = await counts(page);

      verdict = {
        looking,
        away: { sounds: afterAway.sounds - looking.sounds, notices: afterAway.notices - looking.notices },
        approval: { sounds: afterApproval.sounds - afterAway.sounds, notices: afterApproval.notices - afterAway.notices },
      };
    });
  } finally {
    await model.stop();
  }

  expect(verdict).toEqual({ looking: { sounds: 0, notices: 0 }, away: { sounds: 1, notices: 1 }, approval: { sounds: 1, notices: 1 } });
});
