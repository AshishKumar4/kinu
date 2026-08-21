/**
 * Shoot the web film.
 *
 * The landing's § 03 film is the signed-in product photographing itself: four
 * real surfaces — chat, tool calls, the swarm search, activity — rendered by
 * the design gallery's fixture transport, which feeds the app's own components
 * the repo's recorded run data. Nothing here is a mock-up drawn for marketing;
 * a surface that stops rendering breaks this shoot.
 *
 * Output is one animated WebP at `packages/cf-backend/public/assets/`, which
 * ships in `dist/client` and is served signed-out (`/assets/` is on the public
 * bypass list). Stills are captured at 2× and encoded stepped-with-a-short-
 * cross-fade at 6 fps: a film of surfaces, not of motion, so the low rate is
 * the point — it is what keeps four 1280-wide frames under the page's media
 * budget.
 *
 * Run: `bun scripts/web-film.ts` (needs ffmpeg with libwebp_anim).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withGallery } from './gallery-harness';

/** The four surfaces, in the order the product is used: a workspace begins,
 *  the agent works, a hard task becomes a search, the queue asks for you.
 *  `settled` is a string from each frame's own fixture data, so the shot
 *  proves the surface rendered its recorded content rather than merely
 *  mounting. Frames whose fixtures photograph deliberate failure states (the
 *  MCTS notice, the quiet-failure catalogue) are not film: the film shows the
 *  product working, and it must not need a touched-up frame to do it. */
const SHOTS = [
  { frame: 'home', settled: 'What is this workspace for?' },
  { frame: 'streaming', settled: 'Running the regression suite' },
  { frame: 'forkswarmfull', settled: 'Search explorer' },
  { frame: 'work', settled: 'commands waiting on your approval' },
] as const;

const WIDTH = 1280;
const HEIGHT = 800;
const HOLD_S = 2.4;
const FADE_S = 0.45;
const OUT = join(import.meta.dir, '..', 'packages', 'cf-backend', 'public', 'assets', 'kinu-film-web.webp');

const shots = mkdtempSync(join(tmpdir(), 'kinu-web-film-'));
try {
  await withGallery(async ({ browser, origin }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.evaluateOnNewDocument(() => { localStorage.setItem('palette', 'silk'); });
    for (const [at, shot] of SHOTS.entries()) {
      await page.goto(`${origin}/gallery.html?frame=${shot.frame}`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(
        (marker: string) => document.body.innerText.includes(marker),
        { timeout: 15_000 },
        shot.settled,
      );
      // Fonts and the last layout tick; a screenshot of a half-painted surface
      // is exactly the fabrication this script exists to make impossible.
      await page.evaluate(async () => {
        await document.fonts.ready;
        const { promise, resolve } = Promise.withResolvers<void>();
        requestAnimationFrame(() => resolve());
        await promise;
      });
      writeFileSync(join(shots, `${at}.png`), await page.screenshot());
    }
    await page.close();
  });

  const chain = SHOTS.map((_, at) => ['-loop', '1', '-t', String(HOLD_S + FADE_S), '-i', join(shots, `${at}.png`)]).flat();
  const fades = SHOTS.slice(1).map((_, at) =>
    `[v${at}][${at + 1}:v]xfade=transition=fade:duration=${FADE_S}:offset=${((at + 1) * HOLD_S).toFixed(2)}[v${at + 1}]`);
  execFileSync('ffmpeg', [
    '-y', ...chain,
    '-filter_complex', [
      '[0:v]null[v0]', ...fades,
      `[v${SHOTS.length - 1}]scale=${WIDTH}:-2:flags=lanczos,fps=6[out]`,
    ].join(';'),
    '-map', '[out]',
    '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '52', '-compression_level', '6',
    '-loop', '0', OUT,
  ], { stdio: 'inherit' });

  const bytes = statSync(OUT).size;
  console.log(`wrote ${OUT}: ${(bytes / 1024).toFixed(0)} KiB, ${SHOTS.length} surfaces`);
} finally {
  rmSync(shots, { recursive: true, force: true });
}
