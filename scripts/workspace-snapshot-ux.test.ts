import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { withGallery } from './gallery-harness';

const frames = '/tmp/workspace-planes-2026-09-06';

test('Files recovers current workspace data after a failed read and reconnect', async () => {
  mkdirSync(frames, { recursive: true });
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1920, height: 1100 });
    await page.goto(`${origin}/gallery.html?frame=workspacepage&workspaceFault=1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-composer-root]');
    // The first open belongs to the initial connection.
    await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
    await page.click('button[title="Agent"]');
    await page.waitForFunction(() => document.body.textContent?.includes('Memory before'));
    await page.click('button[title="Files"]');
    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('before.txt'));
    await page.screenshot({ path: `${frames}/01-before.png`, fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.workspaceFault = '1'; });
    await page.click('[aria-label="Refresh"]');
    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('Network connection lost'));
    await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
    await page.waitForFunction(() => document.body.textContent?.includes('Showing last known data'));
    expect(await page.$eval('[data-files-surface]', (el) => el.textContent)).toContain('before.txt');
    await page.screenshot({ path: `${frames}/02-fault.png`, fullPage: true });
    await page.evaluate(() => {
      document.documentElement.dataset.workspaceFault = '0';
      document.documentElement.dataset.workspaceRevision = 'current';
      window.dispatchEvent(new Event('gallery-reconnect'));
    });
    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('current.txt'));
    const recovered = await page.$eval('[data-files-surface]', (el) => el.textContent);
    expect(recovered).not.toContain('before.txt');
    expect(recovered).not.toContain('Network connection lost');
    await page.screenshot({ path: `${frames}/03-recovered.png`, fullPage: true });
    await page.click('button[title="Agent"]');
    await page.waitForFunction(() => document.body.textContent?.includes('Memory current'));
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Memory before');
    await page.screenshot({ path: `${frames}/04-memory-recovered.png`, fullPage: true });
    await page.close();
  });
});

// Review job 183: with the 5 s poll gone, a page opened onto a device command already waiting on its owner (after the
// away email) showed no ask card, and the command stayed blocked.
test('a page opened onto a waiting device consent shows its card with no frame', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await page.goto(`${origin}/gallery.html?frame=workspacepage&consent=waiting`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-device-bind="c-1"]');
    expect(await page.$eval('[data-device-bind="c-1"]', (card) => card.textContent)).toContain('git push origin main');
    await page.close();
  });
});

// Review job 183: a `reads_changed` frame sent while the socket was down is never replayed, so a reconnect re-reads
// every live read once, the Work tab's own included.
test('a task written while the socket was down shows on the Work tab after the reconnect', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[aria-label="Work"]');
    // The stub's first open belongs to the initial connection.
    await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
    await page.click('[aria-label="Work"]');
    // The fixture's plan opens in review; the task list is behind it.
    await page.waitForSelector('[data-back-to-work]');
    await page.click('[data-back-to-work]');
    await page.waitForFunction(() => document.querySelector('[data-back-to-work]') === null);
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Written during the outage');

    await page.evaluate(() => {
      document.documentElement.dataset.workMoved = '1';
      window.dispatchEvent(new Event('gallery-reconnect'));
    });

    await page.waitForFunction(() => document.body.textContent?.includes('Written during the outage') === true);
    await page.close();
  });
});
