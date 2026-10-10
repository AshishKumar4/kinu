/** The Agent surface's evolution panels: a run or a version shows its own detail, whichever answer comes first. */
import { expect, test } from 'bun:test';
import { withGallery } from '../../scripts/gallery-harness';

// 26244c765: each detail was a detached read that published whatever came back, so a slow answer for the run left
// behind painted under the run selected after it.
test('a self-tuning run shows its own candidates, though the run picked before it answers later', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1280, height: 1400 });
    await page.goto(`${origin}/gallery.html?frame=agent&gepa=held`, { waitUntil: 'networkidle0' });

    // The loaded panel; its Evolution section starts folded.
    const panel = '[data-gallery-panel^="Loaded — everything"]';
    await page.$$eval(`${panel} button`, (buttons) => buttons.find((button) => button.textContent?.includes('Evolution'))?.click());
    await page.waitForFunction((root) => [...document.querySelectorAll(`${root} button`)].some((button) => button.textContent?.includes('6 iters')), {}, panel);

    const pick = (iterations: string) => page.$$eval(`${panel} button`, (buttons, label) => buttons.find((button) => button.textContent?.includes(label))?.click(), iterations);
    const candidates = () => page.$$eval(`${panel} .font-mono.w-14`, (ids) => ids.map((id) => id.textContent));

    await pick('6 iters');
    await pick('4 iters');
    await page.waitForFunction((root) => document.querySelector(root)?.textContent?.includes('cand_1c') === true, {}, panel);
    await page.evaluate(() => { window.dispatchEvent(new Event('gallery:release-gepa')); });
    await page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); }));

    expect(await candidates()).toEqual(['cand_1a', 'cand_1c']);
    await page.close();
  });
});
