import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { withGallery } from './gallery-harness';

const frames = '/tmp/workspace-planes-2026-09-06';

test('Files recovers current workspace data after a failed read and reconnect', async () => {
  mkdirSync(frames, { recursive: true });
  await withGallery(async ({ browser, origin }) => {
    const page = await browser.newPage();
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
    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('current.txt'), { timeout: 10_000 });
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
}, 120_000);
