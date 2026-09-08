import { describe, expect, test } from 'bun:test';
import { withGallery } from './gallery-harness';
import type { Page } from 'puppeteer';

async function serveSlate(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    if (!url.hostname.endsWith('.preview.example.test')) { await request.continue(); return; }
    if (url.pathname === '/ping') {
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'served by the slate' }) });
      return;
    }
    await request.respond({ status: 200, contentType: 'text/html', body: [
      '<!doctype html><p data-slate-preview>pending</p><script>',
      'fetch("/ping").then(r => r.json()).then(value => { document.querySelector("p").textContent = value.message; })',
      '.catch(cause => { document.querySelector("p").textContent = "blocked: " + cause.message; });',
      '</script>',
    ].join('') });
  });
}

async function selectPlan(page: Page, label: string): Promise<void> {
  const value = await page.$eval('[aria-label="Plan history"]', (element, text) => [...element.querySelectorAll('option')].find(option => option.textContent?.includes(text))?.value, label);
  if (!value) throw new Error('Missing plan: ' + label);
  await page.select('[aria-label="Plan history"]', value);
}

/** One whole plan-history read cycle, elapsed. The failure banner appears only
 *  once a read has run past whatever just happened, and — because a resource
 *  that has already loaded keeps its value through a failure — it clears only
 *  once the next read has succeeded. Both edges are the barrier; the caller
 *  must have seen the pane's first read land, or the banner it waits for is
 *  the fresh pane's own empty state. */
async function readCycleElapsed(page: Page): Promise<void> {
  await page.click('[data-break-plans]');
  await page.waitForFunction(() => document.querySelector('[data-work-plans]')?.textContent?.includes('Plan history temporarily unavailable'));
  await page.click('[data-break-plans]');
  await page.waitForFunction(() => !document.querySelector('[data-work-plans]')?.textContent?.includes('Plan history temporarily unavailable'));
}

describe('the Slate preview frame', () => {
  test('a Slate calls its own preview origin without reaching the host document', async () => {
    await withGallery(async ({ browser, origin }) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      try {
        await serveSlate(page);
        await page.setViewport({ width: 720, height: 800 });
        await page.goto(`${origin}/gallery.html?frame=slate`, { waitUntil: 'networkidle0' });
        const frameElement = await page.waitForSelector('iframe');
        if (frameElement === null) throw new Error('Slate preview iframe did not mount');
        const frame = await frameElement.contentFrame();
        if (!frame) throw new Error('the Slate preview did not create an iframe context');
        await frame.waitForSelector('[data-slate-preview]', { timeout: 30_000 });
        expect(await frame.$eval('[data-slate-preview]', (element) => element.textContent))
          .toBe('served by the slate');
        expect(await frame.evaluate(() => {
          try { return window.parent.document.title; }
          catch (cause) { if (!(cause instanceof DOMException)) throw cause; return cause.name; }
        })).toBe('SecurityError');
      } finally {
        await page.close();
      }
    });
  }, 120_000);

  test('removing the selected Slate returns the work surface to Work', async () => {
    await withGallery(async ({ browser, origin }) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      try {
        await serveSlate(page);
        await page.setViewport({ width: 720, height: 800 });
        await page.goto(`${origin}/gallery.html?frame=workslatefallback`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('button[title="Fallback Probe"][aria-current="true"]');
        await page.evaluate(() => { window.dispatchEvent(new Event('gallery:slate-unpublish')); });
        await page.waitForSelector('button[aria-label="Work"][aria-current="true"]');
        expect(await page.$('button[title="Fallback Probe"]')).toBeNull();
      } finally {
        await page.close();
      }
    });
  }, 120_000);
});


test('preview tabs deduplicate live slates, fill the surface and keep plans in Work', async () => {
  await withGallery(async ({ browser, origin }) => {
    const page = await browser.newPage();
    try {
      await serveSlate(page);
      for (const width of [1100, 390]) {
        await page.setViewport({ width, height: 850 });
        await page.goto(`${origin}/gallery.html?frame=previewtabs`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[aria-label="Dashboard"]');
        expect(await page.$('[aria-label="Output"]')).toBeNull();
        expect(await page.$('[aria-label="Duplicate dashboard port"]')).toBeNull();
        expect(await page.$('[data-work-plans]')).toBeNull();
        expect(await page.$('[aria-label="Diffs"]')).toBeNull();
        for (const title of ['Dashboard', 'Sandbox app', 'Device app']) {
          await page.click(`[aria-label="${title}"]`);
          const iframe = await page.waitForSelector('iframe');
          if (!iframe) throw new Error('Preview missing');
          const frame = await iframe.contentFrame();
          if (!frame) throw new Error('Preview frame missing');
          await frame.waitForSelector('[data-slate-preview]');
          expect(await frame.$eval('[data-slate-preview]', el => el.textContent)).toBe('served by the slate');
          expect(await iframe.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(600);
        }
        await page.click('[data-new-plan]');
        await page.waitForSelector('[data-plan-review-root]');
        expect(await page.$eval('[aria-label="Work"]', el => el.getAttribute('aria-current'))).toBe('true');
        await page.evaluate(() => {
          const button = [...document.querySelectorAll('button')].find(el => el.textContent?.includes('Approve & implement'));
          if (!button) throw new Error('Approval missing');
          button.click();
        });
        await page.waitForFunction(() => document.querySelector('[data-plan-status]')?.textContent === 'Approved');
        await page.click('[data-break-plans]');
        await page.waitForFunction(() => document.querySelector('[data-work-plans]')?.textContent?.includes('Plan history temporarily unavailable'));
        expect(await page.$('[aria-label="Plan history"]')).not.toBeNull();
        expect(await page.$eval('[data-plan-status]', el => el.textContent)).toBe('Approved');
        expect(await page.$eval('[data-work-plans]', el => el.textContent)).toContain('Implement refresh action');
        await page.click('[data-break-plans]');
        await page.waitForFunction(() => !document.querySelector('[data-work-plans]')?.textContent?.includes('Plan history temporarily unavailable'));
        const earlier = await page.$eval('[aria-label="Plan history"]', el => [...el.querySelectorAll('option')].find(option => option.textContent?.includes('Earlier'))?.value);
        if (!earlier) throw new Error('Earlier plan revision missing');
        await page.select('[aria-label="Plan history"]', earlier);
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Earlier'));
        await page.click('[data-new-preview]');
        await page.waitForSelector('[aria-label="Report"][aria-current="true"]');
        await page.click('[aria-label="Work"]');
        await page.click('[data-refresh-preview]');
        expect(await page.$eval('[aria-label="Work"]', el => el.getAttribute('aria-current'))).toBe('true');
        await page.click('[data-add-diff]');
        await page.waitForSelector('[aria-label="Diffs"]');
        await page.click('[aria-label="Sandbox app"]');
        await page.click('[data-show-actors]');
        await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Plan history"] option')].some(el => el.textContent?.includes('Worker plan')));
        expect(await page.$eval('[aria-label="Sandbox app"]', el => el.getAttribute('aria-current'))).toBe('true');
        await page.click('[aria-label="Work"]');
        await page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent?.includes('Older plans / more actors'))?.click());
        await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Plan history"] option')].some(el => el.textContent?.includes('Nested delivery')));
        await selectPlan(page, 'Archived delivery');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Archived'));
        expect(await page.$('[data-plan-decisions]')).toBeNull();
        expect(await page.$eval('[data-work-plans]', el => el.textContent)).toContain('Retained actor history');
        expect(await page.$eval('[data-work-plans]', el => el.textContent)).toContain('Deliver archive');
        await selectPlan(page, 'Nested delivery');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Nested'));
        expect(await page.$('[data-plan-decisions]')).toBeNull();

        // ── A plan arrives from an actor this walk has never named ──────
        // `courier` is on the workspace roster but on no `children` page, so no
        // amount of "Older plans / more actors" reaches it. Only the hint does,
        // and the hint is worth nothing until the exact authorized read answers.
        expect(await page.$eval('[aria-label="Plan history"]', el => el.textContent)).not.toContain('Courier');
        // A pending plan of the reader's OWN is not a reason to bury news the
        // workspace has never shown. Re-submitting the root plan puts this pane
        // back in the state arrivals were once suppressed in, while the reader
        // is off on a preview tab.
        await page.click('[data-new-plan]');
        await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Plan history"] option')]
          .some(el => el.textContent?.includes('Dashboard delivery') && el.textContent.includes('pending')));
        await page.click('[aria-label="Device app"]');
        await page.waitForSelector('[aria-label="Device app"][aria-current="true"]');
        // Neither a malformed reference nor one the workspace never issued may
        // move the user. The stale one is reported where every unreadable actor
        // is; the malformed one never becomes a reference at all, so if it had
        // leaked past the schema the read would have failed instead of warned.
        await page.click('[data-notify-malformed]');
        await page.click('[data-notify-stale]');
        await page.waitForFunction(() => document.querySelector('[data-work-plans]')?.textContent?.includes('courier: The requested subordinate or retained history is unavailable.'));
        expect(await page.$eval('[aria-label="Device app"]', el => el.getAttribute('aria-current'))).toBe('true');
        expect(await page.$eval('[data-work-plans]', el => el.textContent)).not.toContain('Could not load workspace plan history');
        expect(await page.$eval('[data-plan-title]', el => el.textContent)).toContain('Nested');
        // The real reference: Work takes the user, the exact plan is on screen.
        await page.click('[data-notify-plan]');
        await page.waitForSelector('[aria-label="Work"][aria-current="true"]');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Courier rollout'));
        expect(await page.$eval('[data-work-plans]', el => el.textContent)).toContain('Deliver courier');
        // Focused, never decided, and the chat is still the one the user chose.
        expect(await page.$('[data-plan-decisions]')).toBeNull();
        expect(await page.$eval('[data-plan-owner]', el => el.getAttribute('data-plan-owner'))).toBe('main');
        // One presentation policy: a live actor's arrival is neither labelled
        // nor described as retained, and its review is an explicit navigation.
        expect(await page.$eval('[aria-label="Plan history"] option:checked', el => el.textContent)).not.toContain('retained');
        expect(await page.$eval('[data-work-plans]', el => el.textContent)).not.toContain('Retained actor history');
        expect(await page.$eval('[data-work-plans]', el => el.textContent)).toContain('Review in courier conversation');
        // A repeat of a reference already seen is not an arrival: the selection
        // the user has since made stands. The history failure is the barrier —
        // it only appears once a whole read cycle has run past the repeat.
        await selectPlan(page, 'Nested delivery');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Nested'));
        await page.click('[data-notify-plan]');
        await page.click('[data-break-plans]');
        await page.waitForFunction(() => document.querySelector('[data-work-plans]')?.textContent?.includes('Plan history temporarily unavailable'));
        expect(await page.$eval('[data-plan-title]', el => el.textContent)).toContain('Nested');
        await page.click('[data-break-plans]');
        await page.waitForFunction(() => !document.querySelector('[data-work-plans]')?.textContent?.includes('Plan history temporarily unavailable'));
        expect(await page.$eval('[data-plan-title]', el => el.textContent)).toContain('Nested');
        await page.click('[aria-label="Sandbox app"]');
        await page.click('[data-worker-plan]');
        await page.waitForSelector('[aria-label="Work"][aria-current="true"]');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Worker revision two'));
        expect(await page.$eval('[data-plan-owner]', el => el.getAttribute('data-plan-owner'))).toBe('main');
        expect(await page.$('[data-plan-decisions]')).toBeNull();
        await page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent?.includes('Review in worker conversation'))?.click());
        await page.waitForSelector('[data-plan-owner="worker"]');
        await page.waitForSelector('[data-plan-decisions]');
        await page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent?.includes('Approve & implement'))?.click());
        await page.waitForFunction(() => document.querySelector('[data-plan-status]')?.textContent === 'Approved');
        expect(await page.$eval('[data-plan-title]', el => el.textContent)).toContain('Worker revision two');
        // ── The hint is spent for the CONNECTION, not for one pane ──────
        // Walking back out to the workspace conversation and into the actor's
        // again remounts both panes. An arrival the reader was already shown
        // may not arrive a second time, and the pane a conversation opens
        // answers for ITS actor — the courier's arrival is the newest plan in
        // this workspace, and "newest anywhere" is the root pane's own default.
        await page.click('[data-open-workspace]');
        await page.waitForSelector('[data-plan-owner="main"]');
        // The fresh root pane has read: the actor's plan and the arrived one
        // are both in its history, so what it opened on is settled.
        await page.waitForFunction(() => {
          const labels = [...document.querySelectorAll('[aria-label="Plan history"] option')].map(el => el.textContent ?? '');
          return labels.some(label => label.includes('Worker revision two')) && labels.some(label => label.includes('Courier rollout'));
        });
        await readCycleElapsed(page);
        expect(await page.$eval('[data-plan-title]', el => el.textContent)).toContain('Dashboard delivery');
        await selectPlan(page, 'Worker revision two');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Worker revision two'));
        await page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent?.includes('Review in worker conversation'))?.click());
        await page.waitForSelector('[data-plan-owner="worker"]');
        // The arrived plan is in THIS pane's history too, so every precondition
        // a replay needs is met, and a whole further read cycle runs past it.
        await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Plan history"] option')].some(el => el.textContent?.includes('Courier rollout')));
        await readCycleElapsed(page);
        expect(await page.$eval('[data-plan-title]', el => el.textContent)).toContain('Worker revision two');
        expect(await page.$eval('[data-plan-title]', el => el.textContent)).not.toContain('Courier');
        // Spending the hint never discards the reference: the pane keeps
        // resolving it, so the arrived plan stays reachable in history.
        expect(await page.$eval('[aria-label="Plan history"]', el => el.textContent)).toContain('Courier rollout');
      }
    } finally { await page.close(); }
  });
}, 120_000);
