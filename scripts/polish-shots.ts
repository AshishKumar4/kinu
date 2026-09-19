/** Throwaway gallery screenshot driver for the polish-0919 batch.
 *  Usage: bun scripts/polish-shots.ts <frame>[&query] <name> [sel=<css>|last:<css>]
 *  One shot per theme (dark, light), desktop viewport, into
 *  /home/mrwhite0racle/kinu-logs/polish-0919/. A sel= clips to that element. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withGallery } from './gallery-harness';

const SHOTS = '/home/mrwhite0racle/kinu-logs/polish-0919';

mkdirSync(SHOTS, { recursive: true });

const frame = process.argv[2] ?? 'home';

const name = process.argv[3] ?? frame;

const clipSel = process.argv.find((arg) => arg.startsWith('sel='))?.slice(4) ?? null;

await withGallery(async ({ newPage, origin }) => {
  for (const theme of ['dark', 'light'] as const) {
    const page = await newPage();

    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
    await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('body');

    if (clipSel === null) {
      await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
    } else {
      const last = clipSel.startsWith('last:');
      const matches = await page.$$(last ? clipSel.slice(5) : clipSel);
      const element = matches[last ? matches.length - 1 : 0];

      if (element !== undefined) await element.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
    }

    console.log(`shot ${name}-${theme}.png`);
    await page.close();
  }
});
