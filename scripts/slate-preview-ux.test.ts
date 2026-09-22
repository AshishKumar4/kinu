import { describe, expect, test } from 'bun:test';
import { withGallery } from './gallery-harness';
import type { Page } from 'puppeteer';

async function serveSlate(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());

    if (!url.hostname.endsWith('.preview.example.test')) {
      await request.continue();

      return;
    }

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

/** Click the plan card whose header carries `label` — the list's own way of
 *  opening a review, the gesture a reader makes. */
/** Click the plan control whose label reads `text`; those controls carry no
 *  test hook of their own. */
async function clickControl(page: Page, text: string): Promise<void> {
  const clicked = await page.evaluate((label) => {
    const control = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(label));

    control?.click();

    return control !== undefined;
  }, text);

  if (!clicked) throw new Error('Missing plan control: ' + text);
}

async function openPlan(page: Page, label: string): Promise<void> {
  const clicked = await page.evaluate((text) => {
    const card = [...document.querySelectorAll<HTMLButtonElement>('[data-work-plans] button')]
      .find((button) => button.textContent?.includes(text));

    card?.click();

    return card !== undefined;
  }, label);

  if (!clicked) throw new Error('Missing plan card: ' + label);
  await page.waitForSelector('[data-plan-review-root]');
}

/** One whole workspace-work read cycle, elapsed. The failure line appears
 *  only once a read has run past whatever just happened, and — because a
 *  resource that has already loaded keeps its value through a failure — it
 *  clears only once the next read has succeeded. Both edges are the barrier;
 *  the caller must have seen the pane's first read land, or the failure it
 *  waits for is the fresh pane's own first refusal. */
async function readCycleElapsed(page: Page): Promise<void> {
  await page.click('[data-break-plans]');
  await page.waitForFunction(() => document.body.textContent?.includes('Plan history temporarily unavailable'));
  await page.click('[data-break-plans]');
  await page.waitForFunction(() => !document.body.textContent?.includes('Plan history temporarily unavailable'));
}

describe('the Slate preview frame', () => {
  test('a Slate calls its own preview origin without reaching the host document', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await serveSlate(page);
        await page.setViewport({ width: 720, height: 800 });
        await page.goto(`${origin}/gallery.html?frame=slate`, { waitUntil: 'networkidle0' });
        const frameElement = await page.waitForSelector('iframe');

        if (frameElement === null) throw new Error('Slate preview iframe did not mount');
        const frame = await frameElement.contentFrame();

        if (!frame) throw new Error('the Slate preview did not create an iframe context');
        await frame.waitForSelector('[data-slate-preview]');
        expect(await frame.$eval('[data-slate-preview]', (element) => element.textContent))
          .toBe('served by the slate');
        expect(await frame.evaluate(() => {
          try { return window.parent.document.title; }
          catch (cause) {
            if (!(cause instanceof DOMException)) throw cause;

            return cause.name;
          }
        })).toBe('SecurityError');
      } finally {
        await page.close();
      }
    });
  });

  test('removing the selected Slate returns the work surface to Work', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

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
  });
});

/** The two claims a reader checks by looking at the strip and the frame: the
 *  titled previews start at the left edge and lead the fixed surfaces, and the
 *  frame's own chrome is the URL plus the two things you do with a URL. */
test('preview tabs lead the strip from its left edge and the frame keeps two controls', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    try {
      await serveSlate(page);

      for (const width of [1100, 390]) {
        await page.setViewport({ width, height: 850 });
        await page.goto(`${origin}/gallery.html?frame=previewtabs`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[aria-label="Dashboard"]');

        const strip = await page.$eval('[aria-label="Dashboard"]', (first) => {
          const box = first.parentElement;

          if (!(box instanceof HTMLElement)) throw new Error('the tab strip is not an element');
          // Offsets inside the strip's own scrollable content. A phone-width
          // strip is a scroller that brings the current tab into view, so a
          // viewport-relative left would measure the scroll, not the layout.
          const contentLeft = box.getBoundingClientRect().left - box.scrollLeft;

          const tabs = [...box.querySelectorAll<HTMLElement>('button')]
            .map((tab) => ({ name: tab.getAttribute('aria-label'), left: tab.getBoundingClientRect().left - contentLeft }));

          return { padding: parseFloat(getComputedStyle(box).paddingLeft), tabs };
        });

        // Flush with the strip's own content edge: not centred, not indented,
        // and ahead of the fixed surfaces rather than behind them.
        expect(strip.tabs[0]?.name).toBe('Dashboard');
        expect(Math.round(strip.tabs[0].left - strip.padding)).toBe(0);
        const previews = ['Dashboard', 'Sandbox app', 'Device app'];
        const lastPreview = Math.max(...strip.tabs.filter((tab) => previews.includes(tab.name ?? '')).map((tab) => tab.left));
        const firstSurface = Math.min(...strip.tabs.filter((tab) => !previews.includes(tab.name ?? '')).map((tab) => tab.left));
        expect(lastPreview).toBeLessThan(firstSurface);

        await page.click('[aria-label="Dashboard"]');
        await page.waitForSelector('iframe');

        const chrome = await page.$eval('iframe', (frame) => {
          const header = frame.previousElementSibling;

          if (!(header instanceof HTMLElement)) throw new Error('the preview frame has no header');
          const url = header.querySelector('code');

          if (!(url instanceof HTMLElement)) throw new Error('the preview header shows no URL');

          return {
            offset: Math.round(url.getBoundingClientRect().left
              - (header.getBoundingClientRect().left + parseFloat(getComputedStyle(header).paddingLeft))),
            controls: [...header.querySelectorAll('button, a')].map((control) => control.getAttribute('title')),
          };
        });

        // The URL is the header's first thing, flush left — no indent, because
        // the tabs own the label it would otherwise be separated from.
        expect(chrome.offset).toBe(0);
        expect(chrome.controls).toEqual(['Copy the preview URL', 'Open in new tab']);
      }
    } finally { await page.close(); }
  });
});


test('preview tabs deduplicate live slates, fill the surface and keep plans in Work', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    try {
      await serveSlate(page);

      for (const width of [1100, 390]) {
        await page.setViewport({ width, height: 850 });
        await page.goto(`${origin}/gallery.html?frame=previewtabs`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[aria-label="Dashboard"]');
        expect(await page.$('[aria-label="Output"]')).toBeNull();
        expect(await page.$('[aria-label="Duplicate dashboard port"]')).toBeNull();
        // The workspace-wide read lands once and lists the whole roster —
        // there is no unscanned frontier for a live actor to hide behind.
        await page.waitForFunction(() => document.querySelector('[data-work-plans]')?.textContent?.includes('Courier rollout'));
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
        // The approved plan is one card in the list now; the review closes on
        // Back, and a failed read keeps the stale rows under its retry line.
        await page.click('[data-back-to-work]');
        await page.waitForSelector('[data-work-plans]');
        await page.click('[data-break-plans]');
        await page.waitForFunction(() => document.body.textContent?.includes('Plan history temporarily unavailable'));
        expect(await page.$eval('[data-work-plans]', el => el.textContent)).toContain('Dashboard delivery');
        await page.click('[data-break-plans]');
        await page.waitForFunction(() => !document.body.textContent?.includes('Plan history temporarily unavailable'));
        // A superseded revision opens read-only: its decisions are gone, and
        // so is the fresh pending plan's — the approval just made it Approved.
        await openPlan(page, 'Earlier dashboard plan');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Earlier'));
        expect(await page.$('[data-plan-decisions]')).toBeNull();
        await page.click('[data-back-to-work]');
        await page.waitForSelector('[data-work-plans]');
        await page.click('[data-new-preview]');
        // A preview arriving on its own never moves the reader: the surface
        // stays where it was and the strip raises the "Preview ready" chip —
        // only the reader's click on it navigates.
        await page.waitForSelector('[data-preview-ready]');
        expect(await page.$eval('[aria-label="Report"]', el => el.getAttribute('aria-current'))).not.toBe('true');
        await page.click('[data-preview-ready]');
        await page.waitForSelector('[aria-label="Report"][aria-current="true"]');
        await page.click('[aria-label="Work"]');
        await page.click('[data-refresh-preview]');
        expect(await page.$eval('[aria-label="Work"]', el => el.getAttribute('aria-current'))).toBe('true');
        await page.click('[data-add-diff]');
        await page.waitForSelector('[aria-label="Diffs"]');
        await page.click('[aria-label="Sandbox app"]');
        await page.click('[aria-label="Work"]');
        // The roster is always in the read: the dismissed actor's card says
        // retained beside its name, and its plan opens read-only like the
        // live actors' — no per-actor surface claims it.
        expect(await page.$eval('[data-work-plans]', el => el.textContent)).toContain('archive · retained');
        await openPlan(page, 'Archived delivery');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Archived'));
        expect(await page.$('[data-plan-decisions]')).toBeNull();
        await page.click('[data-back-to-work]');
        await openPlan(page, 'Nested delivery');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Nested'));
        expect(await page.$('[data-plan-decisions]')).toBeNull();
        await page.click('[data-back-to-work]');


        // ── A plan arrives whose card is already in the list ────────────
        // The workspace-wide read holds no unscanned frontier: courier's plan
        // is listed from the first load. What the hint owns now is the
        // auto-open — and it is worth nothing until the exact row resolves in
        // the shared read.
        expect(await page.$('[data-plan-review-root]')).toBeNull();
        // A pending plan of the reader's OWN is not a reason to bury news:
        // re-submitting the root plan puts a pending revision back in the
        // list while the reader is off on a preview tab.
        await page.click('[data-new-plan]');
        await page.waitForFunction(() => document.querySelector('[data-work-plans]')?.textContent?.includes('Dashboard delivery'));
        await page.click('[aria-label="Device app"]');
        await page.waitForSelector('[aria-label="Device app"][aria-current="true"]');
        // Neither a malformed reference nor one the workspace never issued may
        // move the user: the malformed one never becomes a reference at all,
        // and the stale one names a revision the read does not hold, so the
        // hint dies unclaimed and no review opens.
        await page.click('[data-notify-malformed]');
        await page.click('[data-notify-stale]');
        await readCycleElapsed(page);
        expect(await page.$('[data-plan-review-root]')).toBeNull();
        expect(await page.$eval('[aria-label="Device app"]', el => el.getAttribute('aria-current'))).toBe('true');
        // The real reference: Work takes the user, the exact plan fills the
        // tab — foreign, so read-only with the way to its owner's conversation.
        await page.click('[data-notify-plan]');
        await page.waitForSelector('[aria-label="Work"][aria-current="true"]');
        await page.waitForSelector('[data-plan-review-root]');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Courier rollout'));
        expect(await page.$('[data-plan-decisions]')).toBeNull();
        expect(await page.$eval('[data-plan-owner]', el => el.getAttribute('data-plan-owner'))).toBe('main');
        // One presentation policy: a live actor's arrival is neither labelled
        // nor described as retained, and its review is an explicit navigation.
        expect(await page.$eval('[data-preview-surface]', el => el.textContent)).not.toContain('retained');
        expect(await page.$eval('[data-preview-surface]', el => el.textContent)).toContain('Review in courier conversation');
        // A repeat of a reference already seen is not an arrival: the claim is
        // spent for the connection, so no amount of waiting re-opens it. The
        // review under it is a stable mount — give the repeat a full read
        // cycle to try, then the open review still stands.
        await page.click('[data-back-to-work]');
        await openPlan(page, 'Nested delivery');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Nested'));
        await page.click('[data-notify-plan]');
        await readCycleElapsed(page);
        expect(await page.$eval('[data-plan-title]', el => el.textContent)).toContain('Nested');
        await page.click('[aria-label="Sandbox app"]');
        await page.click('[data-worker-plan]');
        await page.click('[aria-label="Work"]');
        await page.waitForSelector('[aria-label="Work"][aria-current="true"]');
        // The nested review is still open — surfaces hide, they never unmount,
        // and the review lives in the tab across them. Back is the way out.
        await page.click('[data-back-to-work]');
        await page.waitForFunction(() => document.querySelector('[data-work-plans]')?.textContent?.includes('Worker revision two'));
        await openPlan(page, 'Worker revision two');
        expect(await page.$eval('[data-plan-owner]', el => el.getAttribute('data-plan-owner'))).toBe('main');
        expect(await page.$('[data-plan-decisions]')).toBeNull();
        await clickControl(page, 'Review in worker conversation');
        await page.waitForSelector('[data-plan-owner="worker"]');
        await page.waitForSelector('[data-plan-decisions]');
        await clickControl(page, 'Approve & implement');
        await page.waitForFunction(() => document.querySelector('[data-plan-status]')?.textContent === 'Approved');
        expect(await page.$eval('[data-plan-title]', el => el.textContent)).toContain('Worker revision two');
        // ── The hint is spent for the CONNECTION, not for one pane ──────
        // Walking back out to the workspace conversation and into the actor's
        // again remounts both panes. An arrival the reader was already shown
        // may not arrive a second time: the same review stays open in the
        // pane it landed in, now read-only again under the root's ownership.
        await page.click('[data-open-workspace]');
        await page.waitForSelector('[data-plan-owner="main"]');
        expect(await page.$eval('[data-plan-title]', el => el.textContent)).toContain('Worker revision two');
        await page.click('[data-back-to-work]');
        await page.waitForFunction(() => document.querySelector('[data-work-plans]')?.textContent?.includes('Worker revision two'));
        await page.click('[data-notify-plan]');
        await readCycleElapsed(page);
        expect(await page.$('[data-plan-review-root]')).toBeNull();
        // Spending the hint never discards the reference: the arrived plan
        // stays a card in the list, reachable like every other row.
        expect(await page.$eval('[data-work-plans]', el => el.textContent)).toContain('Courier rollout');
      }
    } finally { await page.close(); }
  });
});
