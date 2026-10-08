/**
 * The inspector's bar and its Environment panel, as a reader meets them: the workspace's own tools stay in reach
 * however many pages are open, each one names itself, and the environments are named in the product's words, with
 * a PC that is not connected offered rather than listed.
 */
import { describe, expect, test } from 'bun:test';
import type { ElementHandle, Page } from 'puppeteer';
import { withGallery } from '../../scripts/gallery-harness';

const TOOL_NAMES = ['Work', 'Changes', 'Files', 'Swarms', 'Agent', 'Environment', 'Activity'];

/** The harness waits forever by default; a control that never comes fails here instead. */
const SOON = { timeout: 10_000 };

/**
 * The control in `scope` that the accessibility tree names `name` with `role`, or null. Read from the tree itself:
 * `::-p-aria` under a CSS scope answers every descendant in this Puppeteer, so it cannot tell a name from its absence.
 */
async function control(page: Page, scope: string, role: string, name: string): Promise<ElementHandle | null> {
  for (const candidate of await page.$$(`${scope} :is(button, a[href], [role])`)) {
    const read = await page.accessibility.snapshot({ root: candidate, interestingOnly: false });

    if (read?.role === role && read.name === name) return candidate;
  }

  return null;
}

async function required(page: Page, scope: string, role: string, name: string): Promise<ElementHandle> {
  const found = await control(page, scope, role, name);

  if (found === null) throw new Error(`no ${role} named ${JSON.stringify(name)} in ${scope}`);

  return found;
}

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
        await page.waitForSelector('button[aria-label="Show workspace"]', SOON);
        await page.tap('button[aria-label="Show workspace"]');
        await page.waitForSelector('button[aria-label="Arrived app"]', SOON);

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
        await page.waitForSelector('button[aria-label="Environment"][aria-current="true"]', SOON);
      } finally { await page.close(); }
    });
  });

  test('a tool shown as an icon names itself on hover and to a screen reader', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(`${origin}/gallery.html?frame=workspacepage&slates=3`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('button[aria-label="Tally"]', SOON);

        const tool = await required(page, 'body', 'button', 'Environment');

        // The name appears beside the pointer, outside the bar: a tooltip, not an attribute only a mouse rest reveals.
        const named = () => [...document.querySelectorAll('body *')].some((element) => {
          const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('');

          return own.trim() === 'Environment' && element.getBoundingClientRect().width > 0 && element.closest('button') === null
            && getComputedStyle(element).visibility !== 'hidden';
        });

        expect(await page.evaluate(named)).toBe(false);
        await tool.hover();
        await page.waitForFunction(named, SOON);
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
        await page.waitForSelector('[data-env-card="sandbox"]', SOON);

        const card = await required(page, '[data-env-card="sandbox"]', 'button', 'Cloud computer');

        // From the keyboard: the control takes focus and Enter selects it, so its pane offers its terminal and screen.
        await card.focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('[data-env-card="sandbox"] [aria-pressed="true"]', SOON);
        expect(await control(page, 'body', 'tab', 'Terminal')).not.toBeNull();
        expect(await control(page, 'body', 'tab', 'Desktop')).not.toBeNull();
      } finally { await page.close(); }
    });
  });

  test('a PC that is not connected is offered, not listed, and the offer opens the connect panel in place', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await page.setViewport({ width: 1100, height: 900 });
        await page.goto(`${origin}/gallery.html?frame=environment&offline=device`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-env-card="workspace"]', SOON);

        expect(await page.$('[data-env-card="device"]')).toBeNull();
        await (await required(page, 'body', 'button', 'Connect your PC')).click();
        await page.waitForSelector('[role="dialog"]', SOON);
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
        await page.waitForSelector('[data-env-card="sandbox"]', SOON);
        await (await required(page, '[data-env-card="sandbox"]', 'button', 'Cloud computer')).click();
        await (await required(page, 'body', 'tab', 'Desktop')).click();

        const frame = await page.waitForSelector('iframe[title="Cloud computer\'s desktop"]', SOON);
        const link = await required(page, 'body', 'link', 'Open Cloud computer\'s desktop in a new tab');

        if (frame === null) throw new Error('the desktop is not framed');

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
