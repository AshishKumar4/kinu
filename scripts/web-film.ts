/**
 * Shoot the web films.
 *
 * Two films come out of one shoot, both photographed from the design gallery's
 * fixture transport, which feeds the app's own components the repo's recorded
 * run data. Nothing here is a mock-up drawn for marketing; a surface that
 * stops rendering breaks this shoot.
 *
 *   · The landing's § 03 film (`packages/cf-backend/public/assets/`) ships in
 *     `dist/client` and is served signed-out (`/assets/` is on the public
 *     bypass list): four surfaces in the order the product is used.
 *   · The README banner film (`docs/assets/`) opens the repository page:
 *     steering a swarm mid-turn, the exploration liveness view as the search
 *     grows, and a node transcript.
 *
 * Stills are captured at 2× and encoded stepped-with-a-short-cross-fade at
 * 6 fps: a film of surfaces, not of motion, so the low rate is the point — it
 * is what keeps the frames under the media budgets their pages carry.
 *
 * Run: `bun scripts/web-film.ts` (needs ffmpeg with libwebp_anim).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'puppeteer';

import { withGallery } from './gallery-harness';

/** A surface, and a string from that frame's own fixture data. The shot only
 *  happens once the surface has RENDERED its recorded content rather than
 *  merely mounted, and `scripts/public-pages.test.ts` holds every marker
 *  against the gallery source, so a fixture that moves breaks this shoot
 *  instead of silently restaging it. Frames whose fixtures photograph
 *  deliberate failure states (the MCTS notice, the quiet-failure catalogue)
 *  are not film: the film shows the product working, and it must not need a
 *  touched-up frame to do it. */
interface Shot {
  readonly frame: string;
  readonly settled: string;
}

/** The four surfaces, in the order the product is used: a workspace begins,
 *  the agent works, a hard task becomes a search, the queue asks for you. */
const LANDING_SHOTS: readonly Shot[] = [
  { frame: 'home', settled: 'What is this workspace for?' },
  { frame: 'streaming', settled: 'Running the regression suite' },
  { frame: 'forkswarmfull', settled: 'Search explorer' },
  { frame: 'work', settled: 'waiting on your approval' },
];

/** The README's three claims, each one frame beat apart: you steer a running
 *  turn and it becomes a measured search; the search grows node by node
 *  (stages 1-4 of the liveness frame, pinned, so the shoot cannot race it);
 *  and every node leaves an inspectable transcript. */
const README_SHOTS: readonly Shot[] = [
  { frame: 'chatsteer', settled: 'Kicked off an ideate swarm over the design space' },
  { frame: 'forklive&stage=1', settled: 'Find why the SAVE20 coupon 500s' },
  { frame: 'forklive&stage=2', settled: 'Find why the SAVE20 coupon 500s' },
  { frame: 'forklive&stage=3', settled: 'Find why the SAVE20 coupon 500s' },
  { frame: 'forklive&stage=4', settled: 'Find why the SAVE20 coupon 500s' },
  { frame: 'transcript', settled: 'Audit packages/checkout/src/apply-coupon.ts' },
];

const WIDTH = 1280;
const HEIGHT = 800;
const HOLD_S = 2.4;
const FADE_S = 0.45;
const ASSETS = join(import.meta.dir, '..', 'packages', 'cf-backend', 'public', 'assets');
const DOCS = join(import.meta.dir, '..', 'docs', 'assets');

function encode(shots: readonly Shot[], stills: string, out: string): void {
  const chain = shots.map((_, at) => ['-loop', '1', '-t', String(HOLD_S + FADE_S), '-i', join(stills, `${at}.png`)]).flat();
  const fades = shots.slice(1).map((_, at) =>
    `[v${at}][${at + 1}:v]xfade=transition=fade:duration=${FADE_S}:offset=${((at + 1) * HOLD_S).toFixed(2)}[v${at + 1}]`);
  execFileSync('ffmpeg', [
    '-y', ...chain,
    '-filter_complex', [
      '[0:v]null[v0]', ...fades,
      `[v${shots.length - 1}]scale=${WIDTH}:-2:flags=lanczos,fps=6[out]`,
    ].join(';'),
    '-map', '[out]',
    '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '52', '-compression_level', '6',
    '-loop', '0', out,
  ], { stdio: 'inherit' });
}

async function capture(page: Page, origin: string, shots: readonly Shot[], stills: string): Promise<void> {
  for (const [at, shot] of shots.entries()) {
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
    writeFileSync(join(stills, `${at}.png`), await page.screenshot());
  }
}

const landingStills = mkdtempSync(join(tmpdir(), 'kinu-web-film-'));
const readmeStills = mkdtempSync(join(tmpdir(), 'kinu-readme-film-'));
try {
  mkdirSync(DOCS, { recursive: true });
  await withGallery(async ({ browser, origin }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.evaluateOnNewDocument(() => { localStorage.setItem('palette', 'silk'); });
    await capture(page, origin, LANDING_SHOTS, landingStills);
    await capture(page, origin, README_SHOTS, readmeStills);
    await page.close();
  });

  const landingOut = join(ASSETS, 'kinu-film-web.webp');
  const readmeOut = join(DOCS, 'kinu-film-readme.webp');
  encode(LANDING_SHOTS, landingStills, landingOut);
  encode(README_SHOTS, readmeStills, readmeOut);

  for (const [out, shots] of [[landingOut, LANDING_SHOTS], [readmeOut, README_SHOTS]] as const) {
    const bytes = statSync(out).size;
    console.log(`wrote ${out}: ${(bytes / 1024).toFixed(0)} KiB, ${shots.length} surfaces`);
  }
} finally {
  rmSync(landingStills, { recursive: true, force: true });
  rmSync(readmeStills, { recursive: true, force: true });
}
