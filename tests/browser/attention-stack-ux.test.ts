/**
 * The attention stack docked to the composer: what waits on the owner's answer, newest on top and open, the rest
 * behind it. It reads the queue the Work tab reads, so the two never disagree, and each answer is the call Work makes.
 */
import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { withGallery } from '../../scripts/gallery-harness';

/** The stack's cards: the open one first, then those behind it, nearest first. */
function stacked(page: Page): Promise<(string | null)[]> {
  return page.$$eval('[data-attention-card], [data-attention-behind]', (cards) => {
    const open = cards.filter((card) => card.hasAttribute('data-attention-card')).map((card) => card.getAttribute('data-attention-card'));
    const behind = cards.filter((card) => card.hasAttribute('data-attention-behind')).map((card) => card.getAttribute('data-attention-behind')).reverse();

    return [...open, ...behind];
  });
}

/** Presses the open card's answer named `words`. */
async function answer(page: Page, words: string): Promise<void> {
  await page.$$eval('[data-attention-card] button', (buttons, label) => {
    const button = buttons.find((each) => each.textContent?.trim() === label);

    if (!(button instanceof HTMLElement)) throw new Error(`no ${label} on the open card`);
    button.click();
  }, words);
}

/** The decisions sent to the agent, in order, as `[id, decision]`. */
async function decisions(page: Page): Promise<string[][]> {
  const recorded = await page.evaluate(() => document.documentElement.dataset.galleryDecisions ?? '[]');

  return v.parse(v.array(v.array(v.string())), JSON.parse(recorded));
}

/** Opens the inspector's Work tab on its list: the frame's plan, awaiting review, opens the tab on its review. */
async function openWork(page: Page): Promise<void> {
  await page.click('nav[aria-label="Workspace"] [aria-label="Work"]');

  if (await page.$('[data-back-to-work]') !== null) await page.click('[data-back-to-work]');
}

/** Work's own count of what waits, or 0 once its Needs you section is gone. */
function workCount(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.querySelector('[data-section="work-needs-you"] .p-label + span')?.textContent ?? '0'));
}

async function opened(page: Page, origin: string, query: string): Promise<void> {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${origin}/gallery.html?frame=workspacepage${query}`, { waitUntil: 'networkidle0' });
}

test('two approvals arrive as a stack: the newer open, answering it opens the other, and both answers reach the agent', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=two');
    await page.waitForSelector('[data-attention-stack]');

    expect(await stacked(page)).toEqual(['action:park-publish', 'action:park-push']);
    expect(await page.$eval('[data-attention-card]', (card) => card.textContent)).toContain('npm publish --access public');
    expect(await page.$eval('[data-attention-position]', (position) => position.textContent)).toBe('· 1 of 2');
    // The Work tab reads the same queue: what it counts is what the stack holds.
    await openWork(page);
    await page.waitForFunction(() => document.querySelector('[data-section="work-needs-you"]') !== null);
    expect(await workCount(page)).toBe(2);

    await answer(page, 'Approve');
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'action:park-push');
    expect(await stacked(page)).toEqual(['action:park-push']);
    expect(await page.$('[data-attention-position]')).toBeNull();

    await answer(page, 'Always allow');
    await page.waitForFunction(() => document.querySelector('[data-attention-stack]') === null);
    expect(await decisions(page)).toEqual([['park-publish', 'approved'], ['park-push', 'always']]);

    // Each answer reaches the agent and shows in the chat as the event it is, not a card that still asks.
    await page.waitForFunction(() => {
      const text = document.querySelector('#chat')?.textContent ?? '';

      return text.includes('You approved') && text.includes('You always allowed');
    });
    await page.waitForFunction(() => document.querySelector('[data-section="work-needs-you"]') === null);
    await page.close();
  });
});

test('only what waits on the owner is stacked, newest first; an older card can be answered first', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=mixed&consent=waiting');
    await page.waitForSelector('[data-attention-stack]');

    // The version under trial waits on nobody: it stays in Work. The workspace's pane stacks its agents' asks too.
    expect(await page.$eval('[data-attention-stack]', (stack) => stack.getAttribute('data-attention-count'))).toBe('7');
    expect(await stacked(page)).toEqual(['action:park-publish', 'action:park-push', 'action:park-write']);
    expect(await page.$eval('[data-attention-behind="action:park-write"]', (strip) => strip.textContent)).toContain('+4');

    await page.click('[data-attention-behind="action:park-write"]');
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'action:park-write');
    expect(await page.$eval('[data-attention-card]', (card) => card.textContent)).toContain('Show the change');

    await answer(page, 'Deny');
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'action:park-publish');
    expect(await decisions(page)).toEqual([['park-write', 'denied']]);
    await page.close();
  });
});

// Staging d930f2537 (2026-10-09): the product flow answered the next card 0.2 s after it opened, while the queue's
// re-read after the first answer was still in flight, and the click was dropped: the answer was never sent.
test('the next card answers at once, while the queue is still being read again after the first answer', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=two&asksHold=1');
    await page.waitForSelector('[data-attention-stack]');

    await answer(page, 'Approve');
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'action:park-push');
    // The re-read is held: the next card is answered before it lands.
    await answer(page, 'Deny');
    await page.waitForFunction(() => (document.documentElement.dataset.galleryDecisions ?? '').includes('park-push'));

    expect(await decisions(page)).toEqual([['park-publish', 'approved'], ['park-push', 'denied']]);
    await page.evaluate(() => { window.dispatchEvent(new Event('gallery:release-asks')); });
    await page.waitForFunction(() => document.querySelector('[data-attention-stack]') === null);
    await page.close();
  });
});

test('a refused answer keeps its card open and says why; the next try lands', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=two&decide=refused');
    await page.waitForSelector('[data-attention-stack]');

    await answer(page, 'Approve');
    await page.waitForSelector('[data-attention-card] [role="alert"]');
    expect(await page.$eval('[data-attention-card] [role="alert"]', (alert) => alert.textContent)).toContain('the approval store is unavailable');
    expect(await stacked(page)).toEqual(['action:park-publish', 'action:park-push']);

    await answer(page, 'Approve');
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'action:park-push');
    expect(await decisions(page)).toEqual([['park-publish', 'approved']]);
    await page.close();
  });
});

test('an agent\'s own pane stacks the asks that agent raised, and none of the workspace\'s', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=mixed&consent=waiting');
    await page.waitForSelector('[data-attention-stack]');
    await page.evaluate(async () => { await window.galleryNavigate?.('/workspace/checkout-fixes/agents/coupon-auditor'); });

    const pane = '[data-agent-pane="checkout-fixes/agents/coupon-auditor"]';

    await page.waitForSelector(`${pane} [data-attention-stack]`);
    expect(await page.$$eval(`${pane} [data-attention-card], ${pane} [data-attention-behind]`, (cards) => cards.map((card) => card.getAttribute('data-attention-card') ?? card.getAttribute('data-attention-behind'))))
      .toEqual(['action:plan:coupon-auditor:pa-1:1']);
    expect(await page.$eval(`${pane} [data-attention-card]`, (card) => card.textContent)).toContain('Audit every coupon rule');
    await page.close();
  });
});
