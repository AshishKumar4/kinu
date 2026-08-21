/**
 * Shoot the web films.
 *
 * Two films come out of one shoot, both photographed from the design gallery's
 * fixture transport, which feeds the app's own components the repo's recorded
 * run data. Nothing here is a mock-up drawn for marketing; a surface that
 * stops rendering breaks this shoot.
 *
 *   · The README banner film (`docs/assets/`) opens the repository page:
 *     steering a swarm mid-turn, the exploration liveness view as the search
 *     grows, and a node transcript.
 *
 * Stills are captured at 2× and cut into full-canvas frames: one frame per
 * surface, three blend frames per crossfade. Every frame replaces the whole
 * canvas — none blends over a retained one — so playback cannot depend on a
 * decoder's animation-compositing behavior. The previous cut leaned on exactly
 * that: ffmpeg's animator emitted partial diff rectangles flagged
 * alpha-blend-over-retained-canvas, and the surfaces leaked on top of each
 * other. Frames are stepped at reading pace, not motion pace; the low rate is
 * what keeps the films under the media budgets their pages carry.
 *
 * Run: `bun scripts/web-film.ts` (needs ffmpeg with libwebp).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 *  the agent works, a hard task becomes a search, the queue asks for you.
 *  The landing keeps its copy of the cut in `packages/cf-backend/public/assets/`
 *  for any non-§03 use; the README banner is the embed this film ships in. */
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
const HOLD_MS = 2400;
const BLEND_MS = 140;
const BLEND_FRAMES = 3;
const QUALITY = 52;
const ASSETS = join(import.meta.dir, '..', 'packages', 'cf-backend', 'public', 'assets');
const DOCS = join(import.meta.dir, '..', 'docs', 'assets');

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

/** One full-canvas frame of the film, cut from the photographed stills: a
 *  surface held on screen, or one midpoint of a crossfade toward the next
 *  surface. Opaque by construction — the cut refuses any frame that could
 *  blend over a retained canvas. */
interface Frame {
  readonly data: Buffer;
  readonly ms: number;
}

function cutStill(source: string, out: string): void {
  execFileSync('ffmpeg', ['-y', '-i', source, '-vf',
    `scale=${WIDTH}:-2:flags=lanczos,format=rgb24`, '-frames:v', '1', out]);
}

function cutBlend(before: string, after: string, share: number, out: string): void {
  // The next surface laid over the previous one at `share` opacity: a real
  // midpoint of the crossfade, computed from the two stills alone.
  execFileSync('ffmpeg', ['-y', '-i', before, '-i', after, '-filter_complex',
    `[1:v]format=rgba,colorchannelmixer=aa=${share}[layer];` +
    `[0:v][layer]overlay=shortest=1,format=rgb24,scale=${WIDTH}:-2:flags=lanczos`,
    '-frames:v', '1', out]);
}

/** Lift the frame's encoded image chunk, header and all, out of ffmpeg's
 *  single-frame WebP — an ANMF's Frame Data is a list of chunks, not bare
 *  bits — refusing anything with an alpha plane: an alpha-bearing frame is
 *  how the previous cut learned to blend, so it never ships again. */
function frameChunk(encoded: Buffer): Buffer {
  if (encoded.toString('ascii', 0, 4) !== 'RIFF' || encoded.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('ffmpeg produced something other than WebP');
  }
  const carried: Buffer[] = [];
  for (let at = 12; at + 8 <= encoded.length;) {
    const fourcc = encoded.toString('ascii', at, at + 4);
    const size = encoded.readUInt32LE(at + 4);
    if (fourcc === 'ALPH') throw new Error('a film frame carries an alpha plane');
    if (fourcc === 'VP8 ' || fourcc === 'VP8L') carried.push(encoded.subarray(at, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  if (carried.length !== 1) throw new Error(`expected one image chunk in a frame, found ${carried.length}`);
  return carried[0];
}

function unsigned24(value: number, into: Buffer, at: number): void {
  into[at] = value & 255;
  into[at + 1] = (value >> 8) & 255;
  into[at + 2] = (value >> 16) & 255;
}

function riffChunk(fourcc: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** Assemble the animated WebP by hand. Every ANMF entry spans the whole
 *  canvas and is flagged do-not-blend, so each frame replaces the picture
 *  outright — the container carries no compositing instruction a decoder
 *  could get wrong. */
function assemble(frames: readonly Frame[], out: string): void {
  const canvas = Buffer.alloc(10);
  canvas[0] = 0x02; // animation; deliberately no alpha-plane flag
  unsigned24(WIDTH - 1, canvas, 4);
  unsigned24(HEIGHT - 1, canvas, 7);
  const animation = Buffer.alloc(6).fill(0xff, 0, 4); // background color is moot under full coverage; loop forever

  const parts = [riffChunk('VP8X', canvas), riffChunk('ANIM', animation)];
  for (const { data, ms } of frames) {
    const header = Buffer.alloc(16);
    unsigned24(0, header, 0);
    unsigned24(0, header, 3);
    unsigned24(WIDTH - 1, header, 6);
    unsigned24(HEIGHT - 1, header, 9);
    unsigned24(ms, header, 12);
    header[15] = 0x02; // blending method: do not blend. Disposal (bit 0) stays
    // "leave in place": with full coverage, the next frame overwrites everything.
    parts.push(riffChunk('ANMF', Buffer.concat([header, data])));
  }

  const body = Buffer.concat(parts);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write('WEBP', 8, 'ascii');
  writeFileSync(out, Buffer.concat([riff, body]));
}

function encodeFrame(png: string, work: string, at: number): Frame['data'] {
  const encoded = join(work, `${at}.webp`);
  execFileSync('ffmpeg', ['-y', '-i', png, '-c:v', 'libwebp', '-lossless', '0',
    '-q:v', String(QUALITY), '-compression_level', '6', '-pix_fmt', 'yuv420p', encoded]);
  return frameChunk(readFileSync(encoded));
}

/** Cut the shoot into its film: each surface held, each crossfade stepped
 *  through its midpoints, every frame a full replacement of the canvas. */
function film(shots: readonly Shot[], stills: string, work: string, out: string): number {
  const still = (at: number) => join(stills, `${at}.png`);
  const frames: Frame[] = [];
  for (const [at] of shots.entries()) {
    const held = join(work, `hold-${at}.png`);
    cutStill(still(at), held);
    frames.push({ data: encodeFrame(held, work, frames.length), ms: HOLD_MS });
    if (at + 1 === shots.length) break;
    for (let step = 1; step <= BLEND_FRAMES; step++) {
      const blended = join(work, `blend-${at}-${step}.png`);
      cutBlend(still(at), still(at + 1), step / (BLEND_FRAMES + 1), blended);
      frames.push({ data: encodeFrame(blended, work, frames.length), ms: BLEND_MS });
    }
  }
  assemble(frames, out);
  return frames.length;
}

const landingStills = mkdtempSync(join(tmpdir(), 'kinu-web-film-'));
const readmeStills = mkdtempSync(join(tmpdir(), 'kinu-readme-film-'));
const cuttingRoom = mkdtempSync(join(tmpdir(), 'kinu-film-cut-'));
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
  const landingFrames = film(LANDING_SHOTS, landingStills, cuttingRoom, landingOut);
  const readmeFrames = film(README_SHOTS, readmeStills, cuttingRoom, readmeOut);

  for (const [out, shots, frames] of [
    [landingOut, LANDING_SHOTS, landingFrames],
    [readmeOut, README_SHOTS, readmeFrames],
  ] as const) {
    const bytes = statSync(out).size;
    console.log(`wrote ${out}: ${(bytes / 1024).toFixed(0)} KiB, ${shots.length} surfaces, ${frames} full-canvas frames`);
  }
} finally {
  rmSync(landingStills, { recursive: true, force: true });
  rmSync(readmeStills, { recursive: true, force: true });
  rmSync(cuttingRoom, { recursive: true, force: true });
}
