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
        expect(await page.$('[aria-label="Changes"]')).toBeNull();

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
        await page.waitForSelector('[aria-label="Changes"]');
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
        expect(await page.$eval('[data-preview-surface]', el => el.textContent)).toContain("Review in courier's conversation");
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
        await clickControl(page, "Review in worker's conversation");
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

test('a change-set read that fails raises the Changes tab, which says what failed', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    try {
      await page.setViewport({ width: 1100, height: 850 });
      await page.goto(`${origin}/gallery.html?frame=previewtabs`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Dashboard"]');
      expect(await page.$('[aria-label="Changes"]')).toBeNull();
      // Nothing changed anywhere, so only the failure can raise the tab. Unseen, Changes reads only on an event it
      // listens to; the window taking focus is one.
      await page.click('[data-break-diff]');
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
      await page.waitForSelector('[aria-label="Changes"]');
      await page.click('[aria-label="Changes"]');
      await page.waitForSelector('[data-changes-error]');
      expect(await page.$eval('[data-changes] header', el => el.textContent?.trim())).toBe("Can't read Workspace");
      expect(await page.$eval('[data-changes-error]', el => el.textContent)).toBe('the change-set read failed');
    } finally { await page.close(); }
  });
});

/** Opens the Changes tab of the preview-tabs frame with two edited workspace files, and a machine when asked.
 *  `narrow` holds the surface at the inspector's default width; otherwise it spans the window. */
async function openChanges(newPage: () => Promise<Page>, origin: string, machine: boolean, narrow = false): Promise<Page> {
  const page = await newPage();

  await page.setViewport({ width: 1280, height: 850 });
  await page.goto(`${origin}/gallery.html?frame=previewtabs`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[aria-label="Dashboard"]');
  await page.click('[data-add-diff]');

  if (machine) await page.click('[data-add-machine]');

  if (narrow) await page.click('[data-narrow-pane]');
  await page.waitForSelector('[aria-label="Changes"]');
  await page.click('[aria-label="Changes"]');

  return page;
}

async function pickSource(page: Page, scope: string, label: string): Promise<void> {
  await page.click(`${scope} [data-source-menu]`);
  await page.waitForSelector('[role="menuitemradio"]');
  await page.$$eval('[role="menuitemradio"]', (items, wanted) => {
    items.find((item) => item.textContent?.includes(wanted))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, label);
}

/**
 * Resolves once the pane's own observer, made before this one, has measured the pane as it stands.
 * The rows can land in a commit before the pane's first measurement, which comes at the next frame.
 */
async function measuredPane(page: Page): Promise<void> {
  await page.$eval('[data-changes]', (pane) => new Promise<void>((resolve) => {
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      resolve();
    });

    observer.observe(pane);
  }));
}

/** Resolves after the pane's own observer, made before this one, has taken the new width. */
async function resizePane(page: Page): Promise<void> {
  // Boxed, so the handle comes back before the promise settles.
  const resized = await page.evaluateHandle(() => ({ done: new Promise<void>((resolve) => {
    const pane = document.querySelector('[data-changes]');

    if (pane === null) throw new Error('no Changes pane to resize');

    const before = pane.clientWidth;

    const observer = new ResizeObserver(() => {
      if (pane.clientWidth === before) return;

      observer.disconnect();
      resolve();
    });

    observer.observe(pane);
  }) }));

  await page.click('[data-narrow-pane]');
  await resized.evaluate((box) => box.done);
}

async function drawn(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
}

test('a wide pane shows every file expanded beside the tree, with no expand button; narrowed, it opens one file at a time', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await openChanges(newPage, origin, false);
    const cards = (): Promise<string[]> => page.$$eval('[data-file-card]', (all) => all.map((card) => card.getAttribute('data-file-card') ?? ''));

    try {
      // Wide, both diffs are drawn without a click once the read lands, and the tree marks the first file.
      await page.waitForSelector('[data-changes] [data-file-row="src/ready.ts"]');
      await measuredPane(page);
      expect(await page.$eval('[data-changes]', (pane) => pane.getAttribute('data-changes'))).toBe('expanded');
      expect(await cards()).toEqual(['src/app.ts', 'src/ready.ts']);
      expect(await page.$('[data-changes] button[aria-label^="Expand"]')).toBeNull();
      expect(await page.$eval('[data-file-row][aria-current="true"]', (row) => row.getAttribute('data-file-row'))).toBe('src/app.ts');
      await page.focus('[data-review-stack]');
      await page.keyboard.press('j');
      await drawn(page);
      expect(await page.$eval('[data-file-row][aria-current="true"]', (row) => row.getAttribute('data-file-row'))).toBe('src/ready.ts');

      // At the inspector's default width the same pane lists the files, and a row opens one.
      await resizePane(page);
      expect(await page.$eval('[data-changes]', (pane) => pane.getAttribute('data-changes'))).toBe('list');
      expect(await cards()).toEqual([]);
      await page.click('[data-file-row="src/ready.ts"]');
      await drawn(page);
      expect(await page.$eval('[data-open-file]', (el) => el.textContent)).toBe('ready.ts');

      // Widened again, the pane expands at the file it had open, not the first.
      await resizePane(page);
      expect(await page.$eval('[data-changes]', (pane) => pane.getAttribute('data-changes'))).toBe('expanded');
      expect(await page.$eval('[data-file-row][aria-current="true"]', (row) => row.getAttribute('data-file-row'))).toBe('src/ready.ts');
    } finally { await page.close(); }
  });
});

test('after Mark reviewed, the source menu still reaches a machine\'s changes', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await openChanges(newPage, origin, true);

    try {
      await page.waitForSelector('[data-file-row="src/device.ts"]');
      await pickSource(page, '[data-changes]', 'Workspace');
      await page.click('[data-mark-reviewed]');
      await page.waitForSelector('[data-changes="reviewed"]');
      await pickSource(page, '[data-changes="reviewed"]', 'Your PC');
      await page.waitForSelector('[data-file-row="src/device.ts"]');
    } finally { await page.close(); }
  });
});

declare global {
  interface Window {
    /** The workspace frame's router (`GalleryNavigator` in gallery.tsx). */
    galleryNavigate?: (path: string) => Promise<void>;
  }
}

test('a workspace switch clears the sandbox-starting line of the workspace left behind', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    try {
      await page.setViewport({ width: 1280, height: 860 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-composer-root]');
      // The sandbox lists a port the page pins, then its next listing answers as starting: the pin stays, the line shows.
      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await page.waitForSelector('[aria-label="Arrived app"]');
      await page.evaluate(() => { document.documentElement.dataset.sandboxStarting = '1'; });
      await page.waitForSelector('[data-preview-starting]');
      // The next workspace's listing never lands, so only the switch itself can clear the line.
      await page.evaluate(async () => {
        document.documentElement.dataset.listingHeld = '1';
        await window.galleryNavigate?.('/workspace/billing-cleanup');
      });
      // The switch's reset drops the pin and the line in one render, so once the pin has gone the line must be gone.
      await page.waitForFunction(() => document.querySelector('[aria-label="Arrived app"]') === null);
      expect(await page.$('[data-preview-starting]')).toBeNull();
    } finally { await page.close(); }
  });
});

test('a note on a changed line stands in for Mark reviewed, leaves the diff when its code moves, and clears once sent', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await openChanges(newPage, origin, false, true);
    const text = (selector: string): Promise<string> => page.$eval(selector, (element) => element.textContent ?? '');

    try {
      await page.click('[data-file-row="src/app.ts"]');
      await page.click('[data-changes="file"] [data-note-row][data-new="1"] > span:first-child');
      await page.waitForSelector('button[title="Comment"]');
      await page.click('button[title="Comment"]');
      await page.waitForSelector('textarea[placeholder="Add a comment..."]');
      await page.type('textarea[placeholder="Add a comment..."]', 'Read it from the config instead.');
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForSelector('[data-notes-bar]');

      // While a note is unsent, Send feedback is the one action: marking reviewed would move the side it quotes.
      expect(await text('[data-notes-bar]')).toContain('1 note for the agent');
      expect(await page.$('[data-mark-reviewed]')).toBeNull();
      expect(await page.$$eval('[data-note-mark]', (marks) => marks.length)).toBeGreaterThan(0);

      // Two lines, pressed then Shift-pressed, quote as the diff reads them, so the note keeps its mark.
      await page.click('[data-changes] [aria-label="Next file (j)"]');
      await page.waitForFunction(() => (document.querySelector('[data-changes="file"]')?.textContent ?? '').includes('hidden = false'));
      await page.click('[data-changes="file"] [data-note-row][data-new="1"] > span:first-child');
      await page.keyboard.down('Shift');
      await page.click('[data-changes="file"] [data-note-row][data-new="2"] > span:first-child');
      await page.keyboard.up('Shift');
      await page.waitForSelector('button[title="Comment"]');
      await page.click('button[title="Comment"]');
      await page.waitForSelector('textarea[placeholder="Add a comment..."]');
      await page.type('textarea[placeholder="Add a comment..."]', 'Both flags belong in one place.');
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForFunction(() => (document.querySelector('[data-notes-bar]')?.textContent ?? '').includes('2 notes'));
      expect(await page.$$eval('[data-changes="file"] [data-note-mark]', (marks) => marks.length)).toBeGreaterThan(0);
      await page.click('[data-changes] [aria-label="Previous file (k)"]');
      await page.waitForSelector('[data-changes="file"] [data-note-row][data-new="1"]');

      // The bar that counts the notes opens their list over the pane.
      await page.click('[data-notes-bar] button');
      await page.waitForFunction(() => (document.querySelector('[data-notes-page]')?.textContent ?? '').includes('Read it from the config instead.'));
      expect(await text('[data-notes-page]')).toContain('app.ts · line 1, newexport const ready = true;');
      expect(await text('[data-notes-page]')).toContain('ready.ts · lines 1–2, newexport const shown = true;');
      expect(await text('[data-notes-page]')).not.toContain('changed since');

      // Picked from the list, a note opens its file, and the list closes.
      await page.$$eval('[data-notes-page] [data-annotation-id]', (cards) => {
        cards.find((card) => card.textContent?.includes('Both flags belong in one place.'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForFunction(() => document.querySelector('[data-notes-page]') === null);
      expect(await page.$eval('[data-open-file]', (el) => el.textContent)).toBe('ready.ts');
      await page.click('[data-changes] [aria-label="Previous file (k)"]');
      await page.waitForFunction(() => document.querySelector('[data-open-file]')?.textContent === 'app.ts');

      // The agent rewrites the line: the note's mark leaves the diff, and the list says its code moved.
      await page.click('[data-edit-again]');
      await page.waitForFunction(() => (document.querySelector('[data-changes="file"]')?.textContent ?? '').includes('isReady()'));
      expect(await page.$$('[data-note-mark]')).toHaveLength(0);
      await page.click('[data-notes-bar] button');
      await page.waitForFunction(() => (document.querySelector('[data-notes-page]')?.textContent ?? '').includes('changed since'));

      // Sent, the notes and their list clear, and the list of files offers Mark reviewed again.
      await page.click('[data-notes-bar] [data-send-feedback]');
      await page.waitForFunction(() => document.querySelectorAll('[data-send-feedback], [data-notes-page]').length === 0);
      await page.click('[data-changes] [aria-label="All files"]');
      await page.waitForSelector('[data-changes="list"] [data-mark-reviewed]');
    } finally { await page.close(); }
  });
});

test('a mouse wheel over the inspector strip scrolls it sideways, so a tab past its edge is reachable', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    try {
      // The default inspector width, with three slates' tabs ahead of the workspace's own.
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&slates=3`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.p-tabstrip button[aria-label="Tally"]');
      const strip = await page.$('.p-tabstrip:has(button[aria-label="Tally"])');
      const box = await strip?.boundingBox();

      if (strip === null || strip === undefined || box === null || box === undefined) throw new Error('the inspector strip is not drawn');

      // Whether the strip's last tab ends inside the strip's visible edge.
      const lastTabShown = (): Promise<boolean> => strip.evaluate((element) => {
        const last = [...element.querySelectorAll('button[aria-label]')].at(-1)?.getBoundingClientRect();

        return last !== undefined && last.right <= element.getBoundingClientRect().right + 1;
      });

      expect(await lastTabShown()).toBe(false);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel({ deltaY: 2000 });

      expect(await lastTabShown()).toBe(true);
    } finally { await page.close(); }
  });
});

/** The chat's inline previews in document order: each slate's id, and whether its card is unfolded. */
function inlinePreviews(page: Page): Promise<[string, boolean][]> {
  return page.$$eval('[data-slate-inline]', (cards) => cards.map((card): [string, boolean] => [
    card.getAttribute('data-slate-inline') ?? '',
    card.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true',
  ]));
}

/** The chat with the board shown twice and the notes once between, each preview's page served. */
async function openSlateThread(page: Page, origin: string, viewport: { width: number; height: number }): Promise<void> {
  await serveSlate(page);
  await page.setViewport(viewport);
  await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=slates&slates=2`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('[data-slate-inline]').length === 3);
  await drawn(page);
}

async function openFromChat(page: Page, slate: string): Promise<void> {
  const cards = await page.$$(`[data-slate-inline="${slate}"]`);
  const open = await cards.at(-1)?.$(`button[aria-label="Open ${slate} in the work surface"]`);

  if (open === null || open === undefined) throw new Error(`the last ${slate} preview offers no way to open it`);
  await open.click();
  await drawn(page);
}

describe('inline slate previews in the chat', () => {
  test('opening a slate from the chat brings a hidden inspector up on it; its previews fold behind the later one and while it is shown', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await openSlateThread(page, origin, { width: 1280, height: 860 });

        // The later board keeps its preview; the earlier one folds under it.
        expect(await inlinePreviews(page)).toEqual([['board', false], ['notes', true], ['board', true]]);

        // With the inspector hidden, the preview's open control brings it up on the board.
        if (await page.$('[data-inspector-collapse]') !== null) await page.click('[data-inspector-collapse]');
        await page.waitForSelector('[data-inspector-expand]');
        await openFromChat(page, 'board');
        expect(await page.$('[data-inspector-collapse]')).not.toBeNull();
        expect(await page.$('.p-tabstrip button[aria-label="Board"][aria-current="true"]')).not.toBeNull();

        // Shown beside the chat, the board's preview folds; moved off it, the preview comes back.
        expect(await inlinePreviews(page)).toEqual([['board', false], ['notes', true], ['board', false]]);
        await page.click('.p-tabstrip button[aria-label="Work"]');
        await drawn(page);
        expect(await inlinePreviews(page)).toEqual([['board', false], ['notes', true], ['board', true]]);

        // The top bar folds and unfolds a preview by hand.
        await page.click('[data-slate-inline="board"] button[aria-expanded]');
        await drawn(page);
        expect(await inlinePreviews(page)).toEqual([['board', true], ['notes', true], ['board', true]]);
        await page.click('[data-slate-inline="notes"] button[aria-expanded]');
        await drawn(page);
        expect(await inlinePreviews(page)).toEqual([['board', true], ['notes', false], ['board', true]]);
      } finally { await page.close(); }
    });
  });

  test('a preview the reader opened by hand stays open while its slate is shown beside the chat, until that ends', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      const toggleLater = async (): Promise<void> => {
        const bars = await page.$$('[data-slate-inline="board"] button[aria-expanded]');

        await bars.at(-1)?.click();
        await drawn(page);
      };

      try {
        await openSlateThread(page, origin, { width: 1280, height: 860 });

        // The reader folds the later board and opens it again: a choice of their own.
        await toggleLater();
        await toggleLater();
        expect(await inlinePreviews(page)).toEqual([['board', false], ['notes', true], ['board', true]]);

        // Shown beside the chat, a preview folds by itself, but not one the reader opened.
        await openFromChat(page, 'board');
        expect(await inlinePreviews(page)).toEqual([['board', false], ['notes', true], ['board', true]]);

        // Moved off it, that reason ends and takes the reader's choice with it: shown again, the preview folds.
        await page.click('.p-tabstrip button[aria-label="Work"]');
        await drawn(page);
        await openFromChat(page, 'board');
        expect(await inlinePreviews(page)).toEqual([['board', false], ['notes', true], ['board', false]]);
      } finally { await page.close(); }
    });
  });

  test('with reduced motion, a preview folds and unfolds completely in the next frame', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await openSlateThread(page, origin, { width: 1280, height: 860 });

        // Each click on the notes preview's top bar: its body's height before, in the next frame, and once every
        // finite animation on the page has ended.
        const steps = await page.$eval('[data-slate-inline="notes"] button[aria-expanded]', async (bar) => {
          const body = document.getElementById(bar.getAttribute('aria-controls') ?? '');

          if (!(bar instanceof HTMLElement) || body === null) throw new Error('the top bar names no body it folds');
          const frame = (): Promise<void> => new Promise((resolve) => { requestAnimationFrame(() => resolve()); });
          const heights: { before: number; next: number; settled: number }[] = [];

          for (const _ of ['fold', 'unfold']) {
            const before = body.getBoundingClientRect().height;

            bar.click();
            await frame();
            const next = body.getBoundingClientRect().height;

            await Promise.allSettled(document.getAnimations()
              .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
              .map((animation) => animation.finished));
            await frame();
            heights.push({ before, next, settled: body.getBoundingClientRect().height });
          }

          return heights;
        });

        for (const { before, next, settled } of steps) {
          expect(settled).not.toBeCloseTo(before, 0);
          expect(next).toBeCloseTo(settled, 1);
        }
      } finally { await page.close(); }
    });
  });

  test('on a phone, opening a slate from the chat shows the Workspace pane on it, and the chat keeps its previews', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      // The pane switch's two buttons carry no hook of their own; their names are what a reader reads.
      const pressed = (name: string): Promise<string | null> => page.$$eval('button[aria-pressed]', (buttons, wanted) =>
        buttons.find((button) => button.textContent?.trim().startsWith(wanted))?.getAttribute('aria-pressed') ?? null, name);

      try {
        await openSlateThread(page, origin, { width: 390, height: 844 });
        expect(await pressed('Chat')).toBe('true');
        await openFromChat(page, 'board');
        expect(await pressed('Workspace')).toBe('true');
        expect(await page.$('.p-tabstrip button[aria-label="Board"][aria-current="true"]')).not.toBeNull();

        // The two panes never share the screen, so back in the chat the board's preview is still unfolded.
        await page.$$eval('button[aria-pressed]', (buttons) => {
          buttons.find((button) => button.textContent?.trim().startsWith('Chat'))?.click();
        });
        await page.waitForFunction(() => document.querySelectorAll('[data-slate-inline]').length === 3);
        await drawn(page);
        expect(await inlinePreviews(page)).toEqual([['board', false], ['notes', true], ['board', true]]);
      } finally { await page.close(); }
    });
  });
});
