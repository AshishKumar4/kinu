/**
 * Photograph every state of the Drive design at desktop and mobile widths in both themes, into
 * ~/kinu-logs/drive-design/. The states are the ones the frame's review bar lists, read from the page, so the
 * shots cannot drift from what the owner can click. Each shot is as tall as its content.
 *
 *   bun scripts/drive-design-shots.ts                         # through the gallery harness (a frozen build)
 *   bun scripts/drive-design-shots.ts --dev http://127.0.0.1:5271 --only slates,files --vp desktop --theme dark
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';
import { withGallery } from './gallery-harness';
import { withTestChrome } from './test-chrome';

const OUT = join(import.meta.dir, '..', '..', 'kinu-logs', 'drive-design');

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 860 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

const THEMES = ['dark', 'light'] as const;

interface DesignView {
  readonly id: string;
  readonly query: string;
}

interface Shot {
  readonly view: DesignView;
  readonly viewport: (typeof VIEWPORTS)[number];
  readonly theme: (typeof THEMES)[number];
}

function flag(name: string): string[] | undefined {
  const at = process.argv.indexOf(`--${name}`);

  return at < 0 ? undefined : process.argv[at + 1]?.split(',');
}

/** A filter flag keeps what it names; an absent flag keeps everything. */
function kept(name: string, value: string): boolean {
  return flag(name)?.includes(value) ?? true;
}

/** The states as the review bar links them. */
async function designViews(page: Page, origin: string): Promise<DesignView[]> {
  await page.goto(`${origin}/gallery.html?frame=drive-design`, { waitUntil: 'networkidle0' });
  await page.click('[data-design-review]');

  const views = await page.$$eval('[data-design-view]', (links) => links.map((link) => ({
    id: link.getAttribute('data-design-view') ?? '',
    query: link.getAttribute('data-design-query') ?? '',
  })));

  if (views.length === 0) throw new Error('the review bar listed no states');

  return views;
}

/** The deepest overflow on the page: the Drive scrolls inside `main`, and a dialog inside its own box. */
async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    let most = 0;

    for (const element of document.querySelectorAll<HTMLElement>('*')) {
      const style = getComputedStyle(element);

      if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
      most = Math.max(most, element.scrollHeight - element.clientHeight);
    }

    return most;
  });
}

async function shootOne(page: Page, origin: string, shot: Shot): Promise<string> {
  const { view, viewport, theme } = shot;
  const size = { width: viewport.width, height: viewport.height };

  await page.setViewport(size);
  await page.goto(`${origin}/gallery.html?frame=drive-design${view.query}&theme=${theme}&review=0`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('main');
  await page.evaluate(() => document.fonts.ready);
  const extra = await overflow(page);

  if (extra > 0) await page.setViewport({ ...size, height: size.height + extra });

  // One frame for the resize to lay out, then the animations' end state.
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => setTimeout(resolve, 260));

    return promise;
  });

  const path = join(OUT, `${view.id}-${viewport.name}-${theme}.png`);
  await page.screenshot({ path });

  return path;
}

async function shoot(newPage: () => Promise<Page>, origin: string): Promise<string[]> {
  const listing = await newPage();
  const views = await designViews(listing, origin).finally(() => listing.close());

  const shots: Shot[] = views.filter((view) => kept('only', view.id)).flatMap((view) => VIEWPORTS
    .filter((viewport) => kept('vp', viewport.name))
    .flatMap((viewport) => THEMES.filter((theme) => kept('theme', theme)).map((theme) => ({ view, viewport, theme }))));

  const written: string[] = [];

  for (const shot of shots) {
    const page = await newPage();

    try {
      written.push(await shootOne(page, origin, shot));
    } finally {
      await page.close();
    }
  }

  return written;
}

async function shootDev(origin: string): Promise<string[]> {
  return withTestChrome((browser) => shoot(() => browser.newPage(), origin));
}

mkdirSync(OUT, { recursive: true });

const dev = flag('dev')?.[0];

const written = dev === undefined ? await withGallery((gallery) => shoot(gallery.newPage, gallery.origin)) : await shootDev(dev);

process.stdout.write(`${String(written.length)} shots in ${OUT}\n`);
