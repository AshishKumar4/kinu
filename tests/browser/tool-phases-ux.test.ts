/**
 * A long turn's phases in the real chat (the owner, 2026-10-19): each run of calls folds behind a short line, thinking
 * streams outside the runs as it always has, and the earlier phases roll up under one more line, the newest phase open
 * below it while the turn runs and the answer below it once the turn has. A model's line for a phase replaces the
 * calls' own once the phase has ended, and never before.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery } from '../../scripts/gallery-harness';

/** The thread's blocks as the chat draws them: rollups, phases and thoughts, each with where it stands. */
function laidOut(page: Page) {
  return page.$$eval('.p-thread-column [data-turn-rollup], .p-thread-column [data-tool-run]', (lines) => lines.map((line) => ({
    kind: line.hasAttribute('data-turn-rollup') ? 'rollup' : 'phase',
    rolledUp: line.hasAttribute('data-tool-run') && line.closest('[data-turn-rollup]') !== null,
    phases: line.getAttribute('data-turn-rollup'),
    state: line.getAttribute('data-tool-run'),
    title: line.getAttribute('data-phase-title'),
    now: line.querySelector('[data-tool-run-now]') !== null,
  })));
}

async function opened(newPage: () => Promise<Page>, origin: string, query: string): Promise<Page> {
  const page = await newPage();

  await page.setViewport({ width: 1280, height: 1000 });
  await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=longturn${query}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.p-thread-column [data-tool-run], .p-thread-column [data-turn-rollup]');

  return page;
}

describe('a long turn, in the real chat', () => {
  test('settled, its five phases are one line above the answer, and opening it shows each phase and the words between', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await opened(newPage, origin, '');
      const top = (await laidOut(page)).filter((line) => !line.rolledUp);

      expect(top).toEqual([{ kind: 'rollup', rolledUp: false, phases: '5', state: null, title: 'calls', now: false }]);
      // The answer, and the thought that led to it, stand outside the rollup.
      expect(await page.evaluate(() => [...document.querySelectorAll('.p-thread-column .prose-chat')].filter((words) => words.closest('[data-turn-rollup]') === null).length)).toBe(1);

      await page.click('[data-turn-rollup] > button');
      await page.waitForSelector('[data-turn-rollup] [data-disclosure-body="open"]');
      expect(await page.$$eval('[data-turn-rollup] [data-tool-run]', (phases) => phases.filter((phase) => phase.getClientRects().length > 0).length)).toBe(5);
      // Its words to the owner after each of the first four phases are inside it, shown once it opens.
      expect(await page.$$eval('[data-turn-rollup] .prose-chat', (words) => words.filter((said) => said.getClientRects().length > 0).length)).toBe(4);

      await page.click('[data-turn-rollup] [data-tool-run] > button');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-turn-rollup] [data-tool-run] [data-tool-state]')].some((row) => row.getClientRects().length > 0));
      await page.close();
    });
  });

  test('live in production, the four phases before stay rolled up and the running one is open, saying what it does now', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await opened(newPage, origin, '&at=37');

      await page.waitForSelector('[data-tool-run="live"]');
      expect((await laidOut(page)).filter((line) => !line.rolledUp)).toEqual([
        { kind: 'rollup', rolledUp: false, phases: '4', state: null, title: 'calls', now: false },
        { kind: 'phase', rolledUp: false, phases: null, state: 'live', title: 'calls', now: true },
      ]);
      await page.close();
    });
  });

  test('a thought streaming after the running phase stands outside it, and the phase stays live', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await opened(newPage, origin, '&at=37&thinking=1');

      await page.waitForSelector('[data-tool-run="live"]');

      const after = await page.evaluate(() => {
        const phase = document.querySelector('[data-tool-run="live"]');
        const thought = document.querySelector('.p-thread-column [data-live-indicator="reasoning"]');

        return { thought: thought !== null, outside: thought !== null && phase !== null && !phase.contains(thought) };
      });

      expect(after).toEqual({ thought: true, outside: true });
      expect((await laidOut(page)).find((line) => line.state === 'live')?.now).toBe(false);
      await page.close();
    });
  });

  test('early in the turn, one phase before the running one is a line already, so nothing rolls up', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await opened(newPage, origin, '&at=12');

      await page.waitForSelector('[data-tool-run="live"]');
      expect((await laidOut(page)).map((line) => line.kind)).toEqual(['phase', 'phase']);
      await page.close();
    });
  });

  test("a model's lines name the ended phases and the turn; the running phase keeps its calls' line until it ends", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const settled = await opened(newPage, origin, '&lines=model');

      expect(await settled.$eval('[data-turn-rollup]', (line) => line.getAttribute('data-phase-title'))).toBe('model');
      await settled.click('[data-turn-rollup] > button');
      await settled.waitForSelector('[data-turn-rollup] [data-disclosure-body="open"]');
      expect(await settled.$$eval('[data-turn-rollup] [data-tool-run]', (phases) => phases.map((phase) => phase.getAttribute('data-phase-title'))))
        .toEqual(['model', 'model', 'model', 'model', 'model']);
      await settled.close();

      const live = await opened(newPage, origin, '&at=37&lines=model');

      await live.waitForSelector('[data-tool-run="live"]');
      expect((await laidOut(live)).filter((line) => !line.rolledUp).map((line) => line.title)).toEqual(['model', 'calls']);
      await live.close();
    });
  });

  test('a running answer gets no lines; a settled one on screen asks once, and its lines land on it', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const live = await opened(newPage, origin, '&at=37&lines=asked');

      await live.waitForSelector('[data-tool-run="live"]');
      await live.evaluate(() => new Promise((settle) => { setTimeout(settle, 1500); }));
      expect(await live.evaluate(() => ({
        running: document.querySelector('[data-tool-run="live"]') !== null,
        written: document.querySelector('[data-phase-title="model"]') !== null,
      }))).toEqual({ running: true, written: false });
      await live.close();

      const settled = await opened(newPage, origin, '&lines=asked');

      await settled.waitForFunction(() => document.querySelector('[data-turn-rollup]')?.getAttribute('data-phase-title') === 'model');
      expect(await settled.evaluate(() => document.documentElement.dataset.phaseLinesAsked)).toBe('lt-a1;');
      await settled.close();
    });
  });
});
