/**
 * The inspector's bar and its Environment panel, as a reader meets them: the workspace's own tools stay in reach
 * however many pages are open, each one names itself, and the environments are named in the product's words, with
 * a PC that is not connected offered rather than listed.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery } from '../../scripts/gallery-harness';

const TOOL_NAMES = ['Work', 'Changes', 'Files', 'Swarms', 'Agent', 'Environment', 'Activity'];

/**
 * Each of the bar's tools by name: `reachable` when its centre is on screen and a press there lands on it, `hidden`
 * when it is drawn but clipped or covered. The bar is found from a page tab (`Tally`), as whatever holds both it and
 * the Activity tool, so the reading does not depend on how the bar is built.
 */
function toolsInReach(page: Page): Promise<Record<string, string>> {
  return page.evaluate((names) => {
    let bar = document.querySelector('button[aria-label="Tally"]');

    while (bar !== null && bar.querySelector('button[aria-label="Activity"]') === null) bar = bar.parentElement;

    const found = bar;

    if (found === null) throw new Error('no bar holds both a page tab and Activity');

    return Object.fromEntries(names.flatMap((name) => {
      const tool = found.querySelector(`button[aria-label="${name}"]`);

      if (tool === null) return [];
      const box = tool.getBoundingClientRect();
      const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
      const onScreen = box.width > 0 && x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight;
      const hit = onScreen ? document.elementFromPoint(x, y) : null;

      return [[name, hit !== null && tool.contains(hit) ? 'reachable' : 'hidden']];
    }));
  }, TOOL_NAMES);
}

describe('the inspector bar keeps the workspace in reach', () => {
  test('on a phone, with three Slates and a preview open, every tool is on screen and a tap on it lands', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await page.goto(`${origin}/gallery.html?frame=workspacepage&slates=3`, { waitUntil: 'networkidle0' });
        await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
        await page.waitForSelector('button[aria-label="Show workspace"]');
        await page.tap('button[aria-label="Show workspace"]');
        await page.waitForSelector('button[aria-label="Arrived app"]');

        const reach = await toolsInReach(page);

        // The tools a phone must always reach are there to be measured, so the reading below is not vacuous.
        expect(Object.keys(reach)).toEqual(expect.arrayContaining(['Files', 'Agent', 'Environment', 'Activity']));
        expect(Object.entries(reach).filter(([, seen]) => seen !== 'reachable')).toEqual([]);

        // A tap where the Environment tool is drawn opens it.
        const box = await page.$eval('button[aria-label="Environment"]', (tool) => {
          const rect = tool.getBoundingClientRect();

          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });

        await page.touchscreen.tap(box.x, box.y);
        await page.waitForSelector('[data-env-card]');
      } finally { await page.close(); }
    });
  });

  test('a tool shown as an icon names itself on hover and to a screen reader', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(`${origin}/gallery.html?frame=workspacepage&slates=3`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('button[aria-label="Tally"]');

        const tool = await page.waitForSelector('button[aria-label="Environment"]');

        if (tool === null) throw new Error('no Environment tool');
        const read = await page.accessibility.snapshot({ root: tool, interestingOnly: false });

        expect({ role: read?.role, name: read?.name }).toEqual({ role: 'button', name: 'Environment' });

        // The name appears beside the pointer, outside the bar: a tooltip, not an attribute only a mouse rest reveals.
        const named = () => [...document.querySelectorAll('body *')].some((element) => {
          const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('');

          return own.trim() === 'Environment' && element.getBoundingClientRect().width > 0 && element.closest('button') === null
            && getComputedStyle(element).visibility !== 'hidden';
        });

        expect(await page.evaluate(named)).toBe(false);
        await tool.hover();
        await page.waitForFunction(named, { timeout: 5_000 });
      } finally { await page.close(); }
    });
  });
});

describe('the Environment panel', () => {
  test('the Linux container is the cloud computer: its card is a control by that name that opens its terminal', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await page.setViewport({ width: 1280, height: 1000 });
        await page.goto(`${origin}/gallery.html?frame=environment`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-env-card="sandbox"]');

        const card = await page.$('[data-env-card="sandbox"] ::-p-aria([name="Cloud computer"][role="button"])');

        if (card === null) throw new Error('the cloud computer has no control by its name');

        // From the keyboard: the control takes focus and Enter selects it, so its pane offers its terminal and screen.
        await card.focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('::-p-aria([name="Desktop"][role="tab"])');
        expect(await card.evaluate((button) => button.getAttribute('aria-pressed'))).toBe('true');
      } finally { await page.close(); }
    });
  });

  test('a PC that is not connected is offered, not listed, and the offer opens the connect panel in place', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await page.setViewport({ width: 1100, height: 900 });
        await page.goto(`${origin}/gallery.html?frame=environment&offline=device`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-env-card="workspace"]');

        expect(await page.$('[data-env-card="device"]')).toBeNull();
        const offer = await page.$('::-p-aria([name="Connect your PC"][role="button"])');

        if (offer === null) throw new Error('nothing offers to connect a PC');
        await offer.click();
        await page.waitForSelector('[role="dialog"]');
        expect(await page.$('[data-env-card="workspace"]')).not.toBeNull();
      } finally { await page.close(); }
    });
  });

  test('the cloud computer\'s desktop shows in a frame, and opens in a tab of its own at the same address', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await page.setViewport({ width: 1280, height: 1000 });
        await page.goto(`${origin}/gallery.html?frame=environment`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-env-card="sandbox"]');
        await page.click('[data-env-card="sandbox"] ::-p-aria([name="Cloud computer"][role="button"])');
        await page.click('::-p-aria([name="Desktop"][role="tab"])');

        const frame = await page.waitForSelector('iframe[title="Cloud computer\'s desktop"]');
        const link = await page.waitForSelector('::-p-aria([name="Open Cloud computer\'s desktop in a new tab"])');

        if (frame === null || link === null) throw new Error('the desktop or its new-tab link is missing');

        const [src, href, target] = await Promise.all([
          frame.evaluate((element) => (element instanceof HTMLIFrameElement ? element.src : '')),
          link.evaluate((element) => (element instanceof HTMLAnchorElement ? element.href : '')),
          link.evaluate((element) => element.getAttribute('target')),
        ]);

        expect(src).toContain('/kasmvnc/vnc.html?');
        expect(href).toBe(src);
        expect(target).toBe('_blank');
      } finally { await page.close(); }
    });
  });
});
