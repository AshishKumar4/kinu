// The Agent tab's mail (docs/MAIL.md §7): the address under the agent's name, and a Mail section of its threads while it
// has any, each opening in Mail; nothing new while it has none.
import { expect, test } from 'bun:test';
import { withGallery } from '../../scripts/gallery-harness';

const PANEL = '[data-gallery-panel^="Loaded — everything"]';

test('with mail, the tab names its address and lists its threads; without, it shows nothing new', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await page.setViewport({ width: 1280, height: 1400 });
    await page.goto(`${origin}/gallery.html?frame=agent&mail=1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector(`${PANEL} [data-section="agent-mail"]`);

    expect(await page.$eval(`${PANEL} [data-agent-address]`, (line) => line.textContent)).toBe('api-worker.ashish@kinu.run');
    expect(await page.$$eval(`${PANEL} [data-agent-mail-thread]`, (rows) => rows.map((row) => [row.getAttribute('href'), row.textContent ?? ''])))
      .toEqual([
        ['/mail/t-alert', expect.stringContaining('Notification: api — HTTP 5xx error rate')],
        ['/mail/t-forged', expect.stringContaining('Not verified')],
      ]);
    // Sections keep their order: Profile, then Mail, then Memory.
    expect(await page.$$eval(`${PANEL} [data-section]`, (sections) => sections.map((section) => section.getAttribute('data-section')).slice(0, 3)))
      .toEqual(['agent-who', 'agent-mail', 'memory']);

    await page.goto(`${origin}/gallery.html?frame=agent`, { waitUntil: 'networkidle0' });
    await page.waitForSelector(`${PANEL} [data-section="memory"]`);
    expect(await page.$(`${PANEL} [data-section="agent-mail"]`)).toBeNull();
    expect(await page.$(`${PANEL} [data-agent-address]`)).toBeNull();
    await page.close();
  });
});
