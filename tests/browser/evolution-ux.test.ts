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
    await page.click(`${panel} [data-section="evolution"] > button[aria-expanded="false"]`);
    await page.waitForSelector(`${panel} [data-gepa-run="gepa_2"]`);

    // gepa_2's candidates are held; gepa_1, picked after it, answers first.
    await page.click(`${panel} [data-gepa-run="gepa_2"]`);
    await page.click(`${panel} [data-gepa-run="gepa_1"]`);
    await page.waitForSelector(`${panel} [data-gepa-candidates="gepa_1"]`);
    await page.evaluate(() => { window.dispatchEvent(new Event('gallery:release-gepa')); });
    await page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); }));

    const shown = await page.$eval(`${panel} [data-gepa-candidates]`, (list) => ({
      run: list.getAttribute('data-gepa-candidates'),
      candidates: [...list.querySelectorAll('[data-gepa-candidate]')].map((row) => row.getAttribute('data-gepa-candidate')),
    }));

    expect(shown).toEqual({ run: 'gepa_1', candidates: ['cand_1a', 'cand_1c'] });
    await page.close();
  });
});
