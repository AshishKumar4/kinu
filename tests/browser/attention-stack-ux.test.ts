/**
 * The attention stack docked to the composer: what waits on the owner's answer, newest on top and open, the rest
 * behind it. It reads the queue the Work tab reads, so the two never disagree, and each answer is the call Work makes.
 */
import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { withGallery } from '../../scripts/gallery-harness';
import { answerStackCard, untickOwnRow } from '../../scripts/product-flows';

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

/** Presses the open card's button that starts with `words` (a parked batch counts its choice: "Approve 1"). */
async function press(page: Page, words: string): Promise<void> {
  await page.$$eval('[data-attention-card] button', (buttons, label) => {
    const button = buttons.find((each) => each.textContent?.trim().startsWith(label) === true);

    if (!(button instanceof HTMLElement)) throw new Error(`no ${label} on the open card`);
    button.click();
  }, words);
}

/** Unticks a parked command in the open card's batch. */
async function untick(page: Page, id: string): Promise<void> {
  await page.click(`[data-attention-card] [data-parked-command="${id}"] input`);
}

/** The decisions sent to the agent, in order, as `[id, decision]`. */
async function decisions(page: Page): Promise<string[][]> {
  const recorded = await page.evaluate(() => document.documentElement.dataset.galleryDecisions ?? '[]');

  return v.parse(v.array(v.array(v.string())), JSON.parse(recorded));
}

/** Opens the inspector's Work tab on its list. */
async function openWork(page: Page): Promise<void> {
  await page.click('nav[aria-label="Workspace"] [aria-label="Work"]');
}

/** Work's own count of what waits, or 0 once its Needs you section is gone. */
function workCount(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.querySelector('[data-section="work-needs-you"] .p-label + span')?.textContent ?? '0'));
}

async function opened(page: Page, origin: string, query: string): Promise<void> {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${origin}/gallery.html?frame=workspacepage${query}`, { waitUntil: 'networkidle0' });
}

test('two parked commands are one card: some are chosen and decided, the rest stay, and every answer reaches the agent', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=two');
    await page.waitForSelector('[data-attention-stack]');

    // Both are on the newer one's card, each ticked; none waits behind it, and one card has no place to count.
    expect(await stacked(page)).toEqual(['action:park-publish']);
    expect(await page.$('[data-attention-position]')).toBeNull();
    expect(await page.$$eval('[data-attention-card] [data-parked-command] input', (boxes) => boxes.map((box) => box instanceof HTMLInputElement && box.checked)))
      .toEqual([true, true]);
    expect(await page.$eval('[data-attention-card]', (card) => card.textContent)).toContain('npm publish --access public');
    // The Work tab reads the same queue: what it counts is what the stack holds.
    await openWork(page);
    await page.waitForFunction(() => document.querySelector('[data-section="work-needs-you"]') !== null);
    expect(await workCount(page)).toBe(2);

    await untick(page, 'park-push');
    await press(page, 'Approve 1');
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'action:park-push');
    expect(await stacked(page)).toEqual(['action:park-push']);
    expect(await page.$('[data-attention-position]')).toBeNull();

    // One left is its own card again.
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

/** What each row of the open card says "always" stands for, by row. */
function alwaysSaid(page: Page): Promise<(string | null)[][]> {
  return page.$$eval('[data-attention-card] [data-parked-always]', (rows) => rows.map((row) => [row.getAttribute('data-parked-always'), row.textContent]));
}

test("a shared slate's change is always allowed for that slate, named on its card before it is pressed", async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    // One change: its card says what it is, whose share asks it, and what always would allow.
    await opened(page, origin, '&asks=effect');
    await page.waitForSelector('[data-attention-card="action:effect-issue"]');
    const one = await alwaysSaid(page);

    expect(one.map(([scope]) => scope)).toEqual(['slate']);
    expect(one[0]?.[1]).toContain('create_issue');
    expect(one[0]?.[1]).toContain('acme');
    expect(one[0]?.[1]).toContain('issue-triage');
    expect(await page.$eval('[data-attention-card]', (card) => card.textContent ?? '')).not.toContain('Run this command');
    await answer(page, 'Always for this slate');
    await page.waitForFunction(() => document.querySelector('[data-attention-stack]') === null);
    expect(await decisions(page)).toEqual([['effect-issue', 'always']]);

    // Two changes are one card, each naming what always allows of it.
    await opened(page, origin, '&asks=effects');
    await page.waitForSelector('[data-attention-card] [data-parked-command="effect-notes"]');
    expect((await alwaysSaid(page)).map(([scope]) => scope)).toEqual(['slate', 'slate']);
    await press(page, 'Always for this slate');
    await page.waitForFunction(() => document.querySelector('[data-attention-stack]') === null);

    // Beside a command, each row says where its always stands: the slate's shares, or this environment.
    await opened(page, origin, '&asks=effect-mixed');
    await page.waitForSelector('[data-attention-card] [data-parked-command="park-push"]');
    expect((await alwaysSaid(page)).map(([scope]) => scope)).toEqual(['slate', 'environment']);
    await press(page, 'Always allow');
    await page.waitForFunction(() => document.querySelector('[data-attention-stack]') === null);
    await page.close();
  });
});

test('only what waits on the owner is stacked, newest first; an older card can be answered first', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=mixed&consent=waiting');
    await page.waitForSelector('[data-attention-stack]');

    // The version under trial waits on nobody: it stays in Work. The workspace's pane stacks its agents' asks too; the
    // three parked commands share the newest one's card.
    expect(await page.$eval('[data-attention-stack]', (stack) => stack.getAttribute('data-attention-count'))).toBe('6');
    expect((await stacked(page))[0]).toBe('action:park-publish');
    expect(await page.$$eval('[data-attention-card] [data-parked-command]', (rows) => rows.map((row) => row.getAttribute('data-parked-command'))))
      .toEqual(['park-publish', 'park-push', 'park-write']);
    expect(await page.$eval('[data-attention-card] [data-parked-write="park-write"] button', (button) => button.getAttribute('aria-expanded'))).toBe('false');

    // An older card behind is answered first.
    const older = (await stacked(page)).at(-1) ?? '';

    await page.click(`[data-attention-behind="${older}"]`);
    await page.waitForFunction((key) => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === key, {}, older);

    // Back on the parked card, one command alone is denied.
    await page.click('[data-attention-behind="action:park-publish"]');
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'action:park-publish');
    await untick(page, 'park-publish');
    await untick(page, 'park-push');
    await press(page, 'Deny 1');
    await page.waitForFunction(() => document.querySelectorAll('[data-attention-card] [data-parked-command]').length === 2);
    expect(await decisions(page)).toEqual([['park-write', 'denied']]);
    await page.close();
  });
});

test('an account-memory proposal waits in the stack as the user object sends it, and keeping it there decides it', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=two&memory=waiting');
    await page.waitForSelector('[data-attention-card="memory:amp_city"], [data-attention-behind="memory:amp_city"]');

    // Newest first: the parked commands' card, the newer parked 30 s ago, then the proposal, a minute old; the command
    // parked 90 s ago is on the commands' card, not behind it.
    expect(await stacked(page)).toEqual(['action:park-publish', 'memory:amp_city']);
    await page.click('[data-attention-behind="memory:amp_city"]');
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'memory:amp_city');
    expect(await page.$eval('[data-attention-card]', (card) => card.textContent)).toContain('owner_city: "Lisbon"');

    await answer(page, 'Keep for every workspace');
    await page.waitForFunction(() => document.documentElement.dataset.galleryMemoryDecisions === 'amp_city:accept ');
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'action:park-publish');
    // The two parked commands are one card again.
    expect(await stacked(page)).toEqual(['action:park-publish']);
    await page.close();
  });
});

// A roster socket a proxy will not upgrade leaves the page on HTTP reads: what waits on the owner comes from the
// memory read then, and must still wait in the stack.
test('an account-memory proposal still waits in the stack when the roster socket cannot open', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=two&memory=waiting&rosterSocket=refused');
    await page.waitForSelector('[data-attention-card="memory:amp_city"], [data-attention-behind="memory:amp_city"]');

    expect(await stacked(page)).toEqual(['action:park-publish', 'memory:amp_city']);
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

    await untick(page, 'park-push');
    await press(page, 'Approve 1');
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

test('a plan in the stack opens on its own page, from whichever tool the inspector shows', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=plan');
    await page.waitForSelector('[data-attention-stack]');
    const plan = await page.$eval('[data-attention-card]', (card) => card.getAttribute('data-attention-card') ?? '');

    expect(plan).toStartWith('action:plan:');
    await page.click('#inspector button[aria-label="Files"]');
    await page.waitForSelector('#inspector button[aria-label="Files"][aria-current="true"]');

    // The plan is not answered here: the card stays, and the inspector leaves Files for the plan's page.
    await answer(page, 'Review plan');
    await page.waitForFunction(() => document.querySelector('#inspector button[aria-label="Files"][aria-current="true"]') === null);
    const shown = await page.$eval('#inspector nav [aria-current="true"]', (tab) => ({ nav: tab.closest('nav')?.getAttribute('aria-label'), tab: tab.getAttribute('aria-label') }));

    expect(shown).toEqual({ nav: 'Pages', tab: expect.stringContaining('SESSIONS_DB') });
    await page.waitForSelector('[data-plan-review-root]');
    expect(await stacked(page)).toEqual([plan]);
    await page.close();
  });
});

test('a refused answer keeps its card open and says why; the next try lands', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=two&decide=refused');
    await page.waitForSelector('[data-attention-stack]');

    await untick(page, 'park-push');
    await press(page, 'Approve 1');
    await page.waitForFunction(() => (document.querySelector('[data-attention-card]')?.textContent ?? '').includes('the approval store is unavailable'));
    // The choice stands: the refused one is still the one ticked.
    expect(await page.$$eval('[data-attention-card] [data-parked-command] input', (boxes) => boxes.map((box) => box instanceof HTMLInputElement && box.checked)))
      .toEqual([true, false]);

    await press(page, 'Approve 1');
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
    await page.evaluate(async () => { await window.galleryNavigate?.('/workspace/api-worker/agents/binding-auditor'); });

    const pane = '[data-agent-pane="api-worker/agents/binding-auditor"]';

    await page.waitForSelector(`${pane} [data-attention-stack]`);
    expect(await page.$$eval(`${pane} [data-attention-card], ${pane} [data-attention-behind]`, (cards) => cards.map((card) => card.getAttribute('data-attention-card') ?? card.getAttribute('data-attention-behind'))))
      .toEqual(['action:plan:binding-auditor:pa-1:1']);
    expect(await page.$eval(`${pane} [data-attention-card]`, (card) => card.textContent)).toContain('Audit the binding of every route');
    await page.close();
  });
});

test("a parked command's row in Work opens its card in the workspace's chat, from an agent's chat too", async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=mixed&consent=waiting');
    await page.waitForSelector('[data-attention-stack]');
    // Something else is shown first.
    const first = (await stacked(page)).at(-1) ?? '';

    await page.click(`[data-attention-behind="${first}"]`);
    await page.waitForFunction((key) => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === key, {}, first);
    await page.evaluate(async () => { await window.galleryNavigate?.('/workspace/api-worker/agents/binding-auditor'); });
    await openWork(page);
    await page.waitForSelector('[data-pending-action="park-write"]');

    // The workspace's own chat is shown, its stack open on that command's card, the batch it is part of.
    await page.click('[data-pending-action="park-write"]');
    await page.waitForFunction(() => document.querySelector('[data-agent-pane="api-worker/main"] [data-attention-card]')?.getAttribute('data-attention-card') === 'action:park-write');
    expect(await page.$$eval('[data-attention-card] [data-parked-command]', (rows) => rows.map((row) => row.getAttribute('data-parked-command'))))
      .toEqual(['park-publish', 'park-push', 'park-write']);
    await page.close();
  });
});

test("a card that arrives while the owner is on the open one waits behind it, so the press lands where they aimed", async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=two');
    await page.waitForSelector('[data-attention-stack]');
    expect(await stacked(page)).toEqual(['action:park-publish']);

    // A plan newer than both commands would take the front of a stack nobody is on; the pointer is on this one.
    await page.hover('[data-attention-card] button');
    await page.evaluate(() => { window.dispatchEvent(new Event('gallery:arrive-ask')); });
    await page.waitForFunction(() => document.querySelector('[data-attention-stack]')?.getAttribute('data-attention-count') === '3');
    expect((await stacked(page))[0]).toBe('action:park-publish');

    // The commands decided, the next opens: the newest that waits.
    await press(page, 'Approve all');
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'action:plan-late');
    await page.close();
  });
});

// 2026-10-17, staging's approval-stack row: a card another run raised took the front between the flow finding its
// batch's box and pressing it ("Node is detached from document"). The flow's steps open its own card in the press.
test("the flow's untick and answer land on its own batch card after another card took the front", async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await opened(page, origin, '&asks=two');
    await page.waitForSelector('[data-attention-stack]');
    await page.evaluate(() => { window.dispatchEvent(new Event('gallery:arrive-ask')); });
    await page.waitForFunction(() => document.querySelector('[data-attention-card]')?.getAttribute('data-attention-card') === 'action:plan-late');

    await untickOwnRow(page, 'action:park-publish', 'park-push');
    await answerStackCard(page, 'action:park-publish', 'Approve 1');
    await page.waitForFunction(() => (document.documentElement.dataset.galleryDecisions ?? '[]') !== '[]');

    expect(await decisions(page)).toEqual([['park-publish', 'approved']]);
    await page.close();
  });
});
