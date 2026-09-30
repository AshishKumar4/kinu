/**
 * The gallery harness's unbounded waits, where they end. No wait carries a clock, so each way a page can stop
 * answering either ends the wait by name or, when the page lives on, is reported when the row's runner says its
 * silence nears the bound. 2026-09-30 (CI run 36687270202 on 9bf467f0d0): the account row sat 480 s on `h1` of the
 * welcome frame, which renders it unconditionally, and the log said only "ended while waiting for h1".
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';

import { SILENCE_NOTICE_ENV } from '../../scripts/deadline';
import { withGallery, type Gallery } from '../../scripts/gallery-harness';
import { scratchDir } from '../../packages/test-utils/src/scratch';

const NEVER = '[data-tab-strip="never-rendered"]';

const inherited = process.env[SILENCE_NOTICE_ENV];

/** The harness's stderr lines as they are written, and the first line that matches, when it comes. */
let lines: string[] = [];

let listeners: Array<(line: string) => void> = [];

const realWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  lines = [];
  listeners = [];
  process.stderr.write = (chunk: string | Uint8Array, ...rest: never[]) => {
    const line = String(chunk);
    lines.push(line);

    for (const listener of listeners) listener(line);

    return realWrite(chunk, ...rest);
  };
});

afterEach(() => {
  process.stderr.write = realWrite;

  if (inherited === undefined) delete process.env[SILENCE_NOTICE_ENV];
  else process.env[SILENCE_NOTICE_ENV] = inherited;
});

function written(fragment: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const already = lines.find((line) => line.includes(fragment));

  if (already !== undefined) resolve(already);
  else listeners.push((line) => { if (line.includes(fragment)) resolve(line); });

  return promise;
}

/** A notice file the test writes to as the runner would; set before the gallery starts, as the runner's env is. */
function noticeFile(): string {
  const path = join(scratchDir('silence-notice'), 'notice');
  writeFileSync(path, '');
  process.env[SILENCE_NOTICE_ENV] = path;

  return path;
}

async function tabsPage(gallery: Gallery): Promise<Page> {
  const page = await gallery.newPage();
  await page.goto(`${gallery.origin}/gallery.html?frame=tabs`, { waitUntil: 'networkidle0' });

  return page;
}

test('a wait on a page whose browser died ends by naming it, not in silence', async () => {
  await withGallery(async (gallery) => {
    const page = await tabsPage(gallery);
    const cdp = await page.browser().target().createCDPSession();
    const waiting = page.waitForSelector(NEVER);

    // The browser's own session dies with it, so its answer never comes: the wait's end is what is awaited.
    await Promise.race([Promise.allSettled([cdp.send('Browser.crash')]), Promise.allSettled([waiting])]);
    await expect(waiting).rejects.toThrow('the browser disconnected');
  });
});

test('a wait on a page whose tab closed ends by naming it, not in silence', async () => {
  await withGallery(async (gallery) => {
    const page = await tabsPage(gallery);
    const { targetInfo } = await (await page.createCDPSession()).send('Target.getTargetInfo');
    const cdp = await page.browser().target().createCDPSession();
    const waiting = page.waitForSelector(NEVER);

    await cdp.send('Target.closeTarget', { targetId: targetInfo.targetId });
    await expect(waiting).rejects.toThrow('the page closed');
  });
});

test('told the row nears its bound, a stuck wait says what the page shows, and keeps waiting', async () => {
  const notice = noticeFile();

  await withGallery(async (gallery) => {
    const page = await tabsPage(gallery);
    const settled = Promise.allSettled([page.waitForSelector(NEVER)]);
    const shows = written('gallery-harness: the page shows');

    appendFileSync(notice, 'silent 360.0s of 480s\n');

    const stuck = await written('gallery-harness: stuck');
    expect(stuck).toContain(NEVER);
    expect(stuck).toContain('frame=tabs');
    expect(stuck).toContain('open requests: none');

    const view = await shows;
    expect(view).toContain('readyState: complete');
    expect(view).toMatch(/elements: \d+/u);
    expect(view).toMatch(/root: \d+ elements/u);
    const shot = /screenshot: (\S+)/u.exec(view)?.[1] ?? '';
    expect(existsSync(shot)).toBe(true);
    // A report ends nothing: the wait is still open.
    expect(await Promise.race([settled.then(() => 'ended'), Promise.resolve('open')])).toBe('open');

    await page.close();
    await settled;
  });
});

/**
 * 2026-09-30 (CI run 36692757065 on 965d472d4e): the report said readyState complete, 98 elements, empty text: a blank
 * app. What blanked it happened before the report, so the report carries what went wrong since the page opened.
 */
test('a stuck wait reports what went wrong on its page since it opened, and whether the app root is empty', async () => {
  const notice = noticeFile();

  await withGallery(async (gallery) => {
    const page = await tabsPage(gallery);
    await Promise.allSettled([page.addScriptTag({ content: "throw new Error('planted before the wait');" })]);
    await Promise.allSettled([page.evaluate(() => fetch('/no-such-chunk.js'))]);
    await page.evaluate(() => { document.getElementById('root')?.replaceChildren(); });
    const settled = Promise.allSettled([page.waitForSelector(NEVER)]);
    const shows = written('gallery-harness: the page shows');

    appendFileSync(notice, 'silent 360.0s of 480s\n');

    const faults = await written('gallery-harness: faults since the page opened');
    expect(faults).toContain('planted before the wait');
    expect(faults).toContain('HTTP 404');
    expect(faults).toContain('no-such-chunk.js');
    expect(await shows).toContain('root: empty');

    await page.close();
    await settled;
  });
});

test('a stuck page that answers nothing is reported without it, and says so', async () => {
  const notice = noticeFile();

  await withGallery(async (gallery) => {
    const page = await tabsPage(gallery);
    // A paused script is a live page that answers nothing, the shape the CI hang had; it spends no CPU.
    const cdp = await page.createCDPSession();
    const paused = Promise.withResolvers<void>();
    cdp.once('Debugger.paused', () => { paused.resolve(); });
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.pause');
    // The pause takes the next script to run; this one is held there until the resume.
    const held = Promise.allSettled([cdp.send('Runtime.evaluate', { expression: 'document.title' })]);
    await paused.promise;
    const settled = Promise.allSettled([page.waitForSelector(NEVER)]);

    appendFileSync(notice, 'silent 360.0s of 480s\n');

    const stuck = await written('gallery-harness: stuck');
    expect(stuck).toContain(NEVER);
    expect(stuck).toContain('asking the page');
    expect(lines.some((line) => line.includes('gallery-harness: the page shows'))).toBe(false);

    await cdp.send('Debugger.resume');
    await held;
    await written('gallery-harness: the page shows');
    await page.close();
    await settled;
  });
});

/**
 * A frame whose page chunk never loads (a rejected dynamic import) threw outside every boundary, and React emptied
 * the root: the blank app the CI stuck report found. Under the app's own boundary it says what broke.
 */
test('a frame whose page chunk fails to load shows the failure, not a blank root', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      if (/\/WelcomePage-[^/]+\.js$/u.test(request.url())) await request.abort();
      else await request.continue();
    });
    await page.goto(`${origin}/gallery.html?frame=welcome&step=0`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#root [data-failure]');

    expect(await page.$eval('#root [data-failure]', (node) => node.textContent ?? '')).toContain('This view crashed');
    await page.close();
  });
});

/** A chunk the server cannot read is a 500 that names the file, so the page fails where it can be seen. */
test('a chunk the server cannot read is refused with its reason, and the page shows the failure', async () => {
  await withGallery(async ({ newPage, origin, dist }) => {
    const chunk = readdirSync(join(dist, 'assets')).find((name) => /^WelcomePage-[^/]+\.js$/u.test(name)) ?? '';
    const path = join(dist, 'assets', chunk);
    const refused = written(`gallery-harness: could not read /assets/${chunk}`);

    chmodSync(path, 0o000);

    try {
      const page = await newPage();
      await page.goto(`${origin}/gallery.html?frame=welcome&step=0`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#root [data-failure]');

      expect(await refused).toContain('EACCES');
      await page.close();
    } finally {
      chmodSync(path, 0o644);
    }
  });
});
