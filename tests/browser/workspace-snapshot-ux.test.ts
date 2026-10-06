import { expect, test } from 'bun:test';
import { withGallery } from '../../scripts/gallery-harness';


test('Files recovers current workspace data after a failed read and reconnect', async () => {
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
    await page.evaluate(() => { document.documentElement.dataset.workspaceFault = '1'; });
    await page.click('[aria-label="Refresh"]');
    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('Network connection lost'));
    await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
    await page.waitForFunction(() => document.body.textContent?.includes('Showing last known data'));
    expect(await page.$eval('[data-files-surface]', (el) => el.textContent)).toContain('before.txt');
    await page.evaluate(() => {
      document.documentElement.dataset.workspaceFault = '0';
      document.documentElement.dataset.workspaceRevision = 'current';
      window.dispatchEvent(new Event('gallery-reconnect'));
    });
    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('current.txt'));
    const recovered = await page.$eval('[data-files-surface]', (el) => el.textContent);
    expect(recovered).not.toContain('before.txt');
    expect(recovered).not.toContain('Network connection lost');
    await page.click('button[title="Agent"]');
    await page.waitForFunction(() => document.body.textContent?.includes('Memory current'));
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Memory before');
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

// A device command is shown as it would run: bidi and zero-width characters that could disguise it appear as marks,
// and the card offers one binding, to the machine, beside Not now.
test('a waiting device command shows its hidden characters as marks and offers one binding', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await page.goto(`${origin}/gallery.html?frame=workspacepage&consent=spoofed`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-device-bind="c-1"]');

    const card = await page.$eval('[data-device-bind="c-1"]', (element) => ({
      text: element.textContent ?? '',
      buttons: [...element.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? ''),
    }));

    expect(card.text).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u);
    expect(card.text).toContain('\uFFFD');
    // Two choices, and the one that binds names the device: no one-off grant.
    expect(card.buttons).toHaveLength(2);
    expect(card.buttons.filter((label) => label.includes('studio'))).toHaveLength(1);
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

test('a delayed snapshot cannot overwrite any surface refreshed after it was admitted', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.goto(origin + '/gallery.html?frame=snapshotrace', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('[data-snapshot-race-state]')?.textContent?.includes('initial snapshot'));
    await page.evaluate(() => { document.documentElement.dataset.snapshotRaceHold = '1'; });
    await page.click('[data-snapshot-race-retry]');
    await page.waitForFunction(() => document.documentElement.dataset.snapshotRaceWaiting === '1');
    await page.evaluate(() => { document.documentElement.dataset.snapshotRaceRevision = 'current'; });
    await page.click('[data-snapshot-race-refresh]');
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-snapshot-race-state]')?.textContent ?? '';

      return ['current memory', 'current-executor', 'current-plan', 'current-slate'].every((value) => text.includes(value));
    });
    await page.evaluate(() => {
      document.documentElement.dataset.snapshotRaceHold = '0';
      window.dispatchEvent(new Event('gallery:release-snapshot'));
    });
    // The identity field proves the old snapshot actually landed, not merely that the new
    // surface reads won before the held response came back.
    await page.waitForFunction(() => document.querySelector('[data-snapshot-race-state]')?.textContent?.includes('held snapshot'));
    const observed = await page.$eval('[data-snapshot-race-state]', (element) => JSON.parse(element.textContent ?? 'null'));
    expect(observed).toEqual({
      snapshot: 'held snapshot', memory: 'current memory', executors: ['current-executor'],
      plan: 'current-plan', presence: { work: true, explorations: false }, slates: ['current-slate'],
    });
    await page.close();
  });
});

