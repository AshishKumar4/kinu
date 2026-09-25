/**
 * Photograph every state of the Changes-tab design at desktop and phone widths in both themes, into
 * ~/kinu-logs/diff-design/. The states are the ones the frame's review bar lists, read from the page, so the shots
 * cannot drift from what the owner can click. A narrow pane's shot is as tall as its content; a wide pane scrolls
 * inside its stack, so it is photographed at the window's own size, as it is seen. The widest panes need a 1920-pixel
 * window, the `wide` one, to leave the chat its share.
 *
 *   bun scripts/diff-design-shots.ts                         # through the gallery harness (a frozen build)
 *   bun scripts/diff-design-shots.ts --dev http://127.0.0.1:5272 --only changes,file --vp desktop --theme dark
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type LaunchOptions, type Page } from 'puppeteer';
import { withGallery } from './gallery-harness';

const OUT = join(import.meta.dir, '..', '..', 'kinu-logs', 'diff-design');

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 860 },
  { name: 'wide', width: 1920, height: 1080 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

const THEMES = ['dark', 'light'] as const;

interface DesignView {
  readonly id: string;
  readonly query: string;
  /** "desktop", "wide" or "mobile" when only one window shows the state; "both" for the desktop and the phone. */
  readonly width: string;
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

async function designViews(page: Page, origin: string): Promise<DesignView[]> {
  await page.goto(`${origin}/gallery.html?frame=diff-design`, { waitUntil: 'networkidle0' });
  await page.click('[data-design-review]');

  const views = await page.$$eval('[data-design-view]', (links) => links.map((link) => ({
    id: link.getAttribute('data-design-view') ?? '',
    query: link.getAttribute('data-design-query') ?? '',
    width: link.getAttribute('data-design-width') ?? 'both',
  })));

  if (views.length === 0) throw new Error('the review bar listed no states');

  return views;
}

/** The deepest overflow on the page: the panel scrolls inside its column, a wide pane inside its stack. */
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

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector('[data-diff-tinted="pending"]') === null, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}

async function shootOne(page: Page, origin: string, shot: Shot): Promise<string> {
  const { view, viewport, theme } = shot;
  const size = { width: viewport.width, height: viewport.height };

  await page.setViewport(size);
  await page.goto(`${origin}/gallery.html?frame=diff-design${view.query}&theme=${theme}&review=0`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('main');
  await settled(page);
  // A wide pane is photographed as seen; a narrow one grows to its content.
  const extra = view.query.includes('inspector=') ? 0 : await overflow(page);

  if (extra > 0) {
    await page.setViewport({ ...size, height: size.height + extra });
    await settled(page);
  }

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
    .filter((viewport) => kept('vp', viewport.name) && (view.width === viewport.name || (view.width === 'both' && viewport.name !== 'wide')))
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
  const options: LaunchOptions = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  const executablePath = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((candidate) => existsSync(candidate));

  if (executablePath !== undefined) options.executablePath = executablePath;
  const browser = await puppeteer.launch(options);

  try {
    return await shoot(() => browser.newPage(), origin);
  } finally {
    await browser.close();
  }
}

mkdirSync(OUT, { recursive: true });

const dev = flag('dev')?.[0];

const written = dev === undefined ? await withGallery((gallery) => shoot(gallery.newPage, gallery.origin)) : await shootDev(dev);

process.stdout.write(`${String(written.length)} shots in ${OUT}\n`);
