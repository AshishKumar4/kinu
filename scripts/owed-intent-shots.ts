import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from 'puppeteer';
import type { OwedOwnerIntent } from '@kinu.run/core';
import { withGallery, type Gallery } from './gallery-harness';

const out = process.argv[2];

if (out === undefined) throw new Error('Give the directory for the owed-intent PNGs.');

const directory = resolve(out);

mkdirSync(directory, { recursive: true });

const STATES = [
  { kind: 'decision', query: 'frame=planreview&intent=decision', status: '[data-plan-footer] [role="status"]', controls: '[data-plan-decisions] button' },
  { kind: 'answers', query: 'frame=workspacepage&transcript=asked&questions=open&intent=answers', status: '[data-question-card] [role="status"]', controls: '[data-question-card] button, [data-question-card] input, [data-question-card] textarea' },
  { kind: 'retry', query: 'frame=workspacepage&transcript=refused&intent=retry', status: '[data-agent-pane] p[role="status"]', controls: '[data-turn-failure] button' },
] as const;

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 860 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

async function open(gallery: Gallery, query: string, viewport: (typeof VIEWPORTS)[number], theme: 'dark' | 'light'): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height });
  await page.evaluateOnNewDocument((mode) => { localStorage.setItem('theme', mode); }, theme);
  await page.goto(`${gallery.origin}/gallery.html?${query}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  return page;
}

async function replaceIntents(page: Page, intents: readonly OwedOwnerIntent[]): Promise<void> {
  await page.evaluate((next) => { window.dispatchEvent(new CustomEvent('gallery:owed-intents', { detail: next })); }, intents);
  await painted(page);
}

async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => { requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); }); }));
}

async function photograph(gallery: Gallery): Promise<void> {
  for (const state of STATES) {
    for (const { viewport, theme } of VIEWPORTS.flatMap((size) => (['dark', 'light'] as const).map((mode) => ({ viewport: size, theme: mode })))) {
      const page = await open(gallery, state.query, viewport, theme);

      try {
        const path = join(directory, `${state.kind}-${viewport.name}-${theme}.png`);
        await page.screenshot({ path });
        process.stdout.write(`${path}\n`);

        const measured = await page.$eval(state.status, (line, controls) => {
          const box = line.getBoundingClientRect();
          const buttons = [...document.querySelectorAll(controls)];
          const send = document.querySelector('[data-composer-root] button[aria-label="Send"]')?.getBoundingClientRect();

          return {
            theme: document.documentElement.dataset.mode,
            visible: box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
            overflow: document.documentElement.scrollWidth > innerWidth,
            controls: buttons.length,
            disabled: buttons.every((button) => button.matches(':disabled')),
            sendVisible: send !== undefined && send.top >= 0 && send.bottom <= innerHeight,
          };
        }, state.controls);

        if (measured.theme !== theme || !measured.visible || measured.overflow || !measured.disabled
          || (state.kind === 'retry' ? measured.controls !== 0 : measured.controls === 0)
          || (state.kind !== 'decision' && !measured.sendVisible)) {
          throw new Error(`${state.kind}/${viewport.name}/${theme}: ${JSON.stringify(measured)}`);
        }
      } finally {
        await page.close();
      }
    }
  }
}

async function verifyAnswers(gallery: Gallery): Promise<void> {
  const page = await open(gallery, 'frame=workspacepage&transcript=asked&questions=open&answer=owed', VIEWPORTS[0], 'dark');
  const status = STATES[1].status;

  try {
    await page.click('[data-question-card] input[type="radio"]');
    await page.click('[data-question-answer]');
    await painted(page);
    const kept = await page.$eval('[data-question-answer]', (button) => button.matches(':disabled'));

    if (!kept || await page.$(status) === null) throw new Error('An owed answer did not retain its card with a disabled Answer control.');

    for (const unrelated of [
      { id: 'other-actor', kind: 'answers', target: 'q-1', actor: 'another-agent' },
      { id: 'other-question', kind: 'answers', target: 'another-question', actor: null },
    ] satisfies readonly OwedOwnerIntent[]) {
      await replaceIntents(page, [unrelated]);
      const enabled = await page.$eval('[data-question-answer]', (button) => !button.matches(':disabled'));

      if (!enabled || await page.$(status) !== null) throw new Error('Another question or actor blocked this answer.');
    }

    await replaceIntents(page, [{ id: 'matching', kind: 'answers', target: 'q-1', actor: null }]);

    if (await page.$(status) === null) throw new Error('A matching answer did not show its owed line.');
    await replaceIntents(page, []);

    if (await page.$(status) !== null) throw new Error('A retired answer kept its owed line.');
    process.stdout.write('answers: receipt retains the card; actor/target match; live retirement clears the line\n');
  } finally {
    await page.close();
  }
}

async function verifyRetry(gallery: Gallery): Promise<void> {
  const page = await open(gallery, STATES[2].query, VIEWPORTS[0], 'dark');
  const status = STATES[2].status;

  try {
    if (await page.$(status) === null) throw new Error('The owed Retry did not show its line.');

    for (const unrelated of [
      { id: 'other-actor', kind: 'retry', target: 'rf-u1', actor: 'another-agent' },
      { id: 'other-turn', kind: 'retry', target: 'an-older-user-message', actor: null },
    ] satisfies readonly OwedOwnerIntent[]) {
      await replaceIntents(page, [unrelated]);

      if (await page.$(status) !== null || await page.$('[data-turn-failure] button') === null) throw new Error('Another actor or turn blocked Retry.');
    }

    await replaceIntents(page, [{ id: 'matching', kind: 'retry', target: 'rf-u1', actor: null }]);

    if (await page.$(status) === null) throw new Error('A matching Retry did not show its owed line.');
    await replaceIntents(page, []);

    if (await page.$(status) !== null || await page.$('[data-turn-failure] button') === null) throw new Error('A retired Retry did not restore its control.');
    process.stdout.write('retry: actor/newest-user match; live retirement restores Retry\n');
  } finally {
    await page.close();
  }
}

async function verifyDecision(gallery: Gallery): Promise<void> {
  const page = await open(gallery, 'frame=workspacepage&plan=annotated-heading&decision=owed', VIEWPORTS[0], 'dark');
  const status = STATES[0].status;

  try {
    const tab = 'nav[aria-label="Pages"] button[aria-label*="applyCoupon"]';
    await page.click(tab);
    await page.waitForSelector('[data-plan-decisions] button');
    await page.click('[data-plan-decisions] button:last-child');
    await painted(page);
    const locked = await page.$$eval('[data-plan-decisions] button', (buttons) => buttons.every((button) => button.matches(':disabled')));

    if (!locked || await page.$(status) === null) throw new Error('An owed decision did not show its line with locked controls.');
    await replaceIntents(page, [{ id: 'other-plan', kind: 'decision', target: 'another-plan', actor: null }]);
    const enabled = await page.$$eval('[data-plan-decisions] button', (buttons) => buttons.every((button) => !button.matches(':disabled')));

    if (!enabled || await page.$(status) !== null) throw new Error('Another plan blocked this decision.');
    process.stdout.write('decision: receipt locks both controls; another plan does not\n');
  } finally {
    await page.close();
  }
}

await withGallery(async (gallery) => {
  if (!process.argv.includes('--verify-only')) {
    await photograph(gallery);

    return;
  }

  await verifyAnswers(gallery);
  await verifyRetry(gallery);
  await verifyDecision(gallery);
});
