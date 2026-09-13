#!/usr/bin/env bun
/**
 * Cut the README's planning walkthrough GIF from the landing page's plan
 * movie.
 *
 * One timeline exists (`landing-movie-timeline.ts`): the landing plays it, the
 * public-page tests seek it, and this script photographs it. Every frame here
 * is a Chrome screenshot of the real DOM at a timeline stamp, driven through
 * the same `window.__kinuLandingMovie` handle the tests use, so the shipped
 * animation cannot drift from what the landing shows. Regenerate it with:
 *
 *   bun scripts/plan-demo-film.ts              # writes docs/assets/kinu-plan-demo.gif
 *   bun scripts/plan-demo-film.ts --out /tmp/demo.gif
 *
 * Frames are captured as PNGs and muxed to GIF with the system ffmpeg's
 * palettegen/paletteuse two-pass — GitHub's README renderer animates GIF
 * everywhere, and the palette pass keeps the dark theme's ink clean under
 * 256 colours. Frame durations ride in the concat manifest, so a held beat
 * costs one screenshot, not one per tick.
 *
 * The plan document is taller than the pane it opens in and its Approve
 * button sits under the fold; rather than a storyboard jump, the pane scrolls
 * with the DOM's own scrollIntoView on the decisions row as the cursor
 * travels to it — the same thing a reader's wheel would do.
 *
 * Tool duration chips read Date.now(); the page clock is virtualised to the
 * timeline stamp before each seek, so a chip says the beat's true duration
 * instead of how long two screenshots happened to take.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from 'puppeteer';
import * as v from 'valibot';

import { withGallery } from './gallery-harness';
import { scratchDir } from '../packages/test-utils/src/scratch';

// The walkthrough's deterministic drive, declared here rather than imported,
// for the reason `public-pages.test.ts` gives: the timeline module quotes the
// product's fixtures, and importing it would drag the product's DOM
// components under the scripts program's own JSX runtime. The shape is kept
// identical to `LandingMovieHandle` in `landing-movie-timeline.ts`.
interface LandingMovieHandle {
  readonly duration: number;
  readonly cues: Record<string, number>;
  seek(at: number): Promise<void>;
  play(): void;
  pause(): void;
  state(): { t: number; playing: boolean; settled: boolean };
}

declare global {
  interface Window {
    __kinuLandingMovie?: LandingMovieHandle;
    /** Installed by this script's evaluateOnNewDocument virtual clock. */
    __setDemoNow?: (value: number) => void;
  }
}

const REPO = resolve(import.meta.dir, '..');

/** Where the README reads the animation from. */
export const DEFAULT_OUT = resolve(REPO, 'docs/assets/kinu-plan-demo.gif');

/** Fixed page epoch so duration chips render identically on every run. */
const VIRTUAL_EPOCH = 1_755_993_600_000;

/** The stage the movie plays on, and the theme the README shows it in. */
const STAGE_SELECTOR = '[data-landing-frame="plan"]';

const THEME = 'dark';

export interface CaptureFrame {
  readonly at: number;
  readonly holdMs: number;
}

/** `CURSOR_TRAVEL_MS` in `landing-movie-timeline.ts`: the cursor dwells on a
 *  target and travels for this long, arriving exactly at the next cue. */
const CURSOR_TRAVEL_MS = 700;

/** The cues the cursor arrives at, by name: `submitted` (the composer),
 *  `approve` (the click) and `finalText` (the slate tab). The cursor enters at
 *  `CURSOR_ENTER_AT`, which the handle does not publish, but the base cadence
 *  photographs it where it sits before it moves. */
const CURSOR_ARRIVALS = ['submitted', 'approve', 'finalText'] as const;

/** The beats the recorder saves stills of next to the GIF, so a review can
 *  see what the animation actually says without decoding it: `at` an absolute
 *  stamp, or `cue` the named cue to resolve from the live movie. */
export const EVIDENCE_STAMPS: readonly { name: string; at?: number; cue?: string }[] = [
  { name: 'first', at: 0 },
  { name: 'review', cue: 'planReady' },
  { name: 'approve', cue: 'approve' },
];

/**
 * The capture plan. Dense while the cursor travels or a beat just landed,
 * sparse through holds, derived from the same cue table the live movie plays.
 * A GIF holds a frame for as long as its duration says, so the cadence is a
 * clarity budget, not a size one. The last frame holds the settled state
 * before the loop restarts.
 */
export function capturePlan(cues: Record<string, number>, end: number): readonly CaptureFrame[] {
  const stamps = new Set<number>();

  for (let at = 0; at < end; at += 560) stamps.add(at);

  for (const at of Object.values(cues)) stamps.add(Math.min(at + 40, end));

  for (const name of CURSOR_ARRIVALS) {
    const arrival = cues[name];

    if (arrival === undefined) throw new Error(`the movie publishes no "${name}" cue`);

    for (let at = Math.max(0, arrival - CURSOR_TRAVEL_MS); at <= arrival; at += 160) stamps.add(at);
  }

  const approve = cues['approve'];

  if (approve !== undefined) stamps.add(approve + 200);
  const ordered = [...stamps].filter((at) => at <= end).sort((a, b) => a - b);

  return ordered.map((at, index) => {
    const next = ordered[index + 1];

    return { at, holdMs: next === undefined ? 2_600 : Math.max(30, next - at) };
  });
}

/** A rectangle in page coordinates, as a screenshot clip. */
interface StageRegion { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface FilmResult {
  readonly out: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly frames: number;
  readonly durationS: number;
}

/** Load the landing in a fresh page, in the README's theme, with the movie
 *  paused at its start and its stage scrolled into view. */
async function openMovie(page: Page, origin: string): Promise<StageRegion> {
  await page.setViewport({ width: 1024, height: 1000 });
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: THEME },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ]);
  await page.evaluateOnNewDocument((theme: string) => {
    // The landing reads its mode from localStorage before first paint.
    localStorage.setItem('theme', theme);
    const real = Date.now.bind(Date);
    let virtual: number | null = null;
    Object.defineProperty(window, '__setDemoNow', { value: (at: number) => { virtual = at; } });
    Date.now = () => virtual ?? real();
  }, THEME);
  await page.goto(`${origin}/landing.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => window.__kinuLandingMovie !== undefined && document.fonts.status === 'loaded',
    { timeout: 20_000 },
  );
  const applied = await page.evaluate(() => document.documentElement.dataset.mode);

  if (applied !== THEME) throw new Error(`asked for the ${THEME} theme, the landing rendered ${String(applied)}`);

  const stageBox = await page.evaluate((selector: string) => {
    const stage = document.querySelector(selector);
    stage?.scrollIntoView({ block: 'center' });
    window.__kinuLandingMovie?.pause();
    const rect = stage?.getBoundingClientRect();

    return rect === undefined ? null : {
      x: Math.round(rect.x + window.scrollX),
      y: Math.round(rect.y + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, STAGE_SELECTOR);

  if (stageBox === null) throw new Error('the plan movie stage is not on the landing');

  return stageBox;
}

/**
 * True while the cursor is travelling to the Approve button: the window in
 *  which the plan pane has to be scrolled so the click lands on something
 *  the reader can see.
 */
function approachingApprove(at: number, cues: Record<string, number>): boolean {
  const approve = cues['approve'];

  return approve !== undefined && at >= approve - CURSOR_TRAVEL_MS && at <= approve + CURSOR_TRAVEL_MS;
}

/** Seek the live timeline, then — during the approve approach — scroll the
 *  plan pane with the DOM's own scrollIntoView when its decision row is
 *  offscreen, and re-seek so the cursor re-anchors on the moved target.
 *  Settles every running CSS animation so the shot is deterministic: a
 *  one-shot animation is photographed finished (a just-mounted message must
 *  never sit at opacity 0); a looping one is parked at its first frame. */
async function seekTo(page: Page, at: number, revealApprove: boolean): Promise<void> {
  await page.evaluate(async (now: number, target: number, reveal: boolean, selector: string) => {
    window.__setDemoNow?.(now);
    await window.__kinuLandingMovie?.seek(target);

    if (reveal) {
      const stage = document.querySelector(selector);
      const decisions = stage?.querySelector('[data-plan-decisions]');
      const pane = decisions?.closest('[data-plan-scroll]');

      if (decisions instanceof HTMLElement && pane instanceof HTMLElement) {
        const paneRect = pane.getBoundingClientRect();
        const rowRect = decisions.getBoundingClientRect();
        const offscreen = rowRect.bottom > paneRect.bottom || rowRect.top < paneRect.top;

        if (offscreen) {
          decisions.scrollIntoView({ block: 'nearest' });
          // The target moved under the cursor; re-anchor it.
          await window.__kinuLandingMovie?.seek(target);
        }
      }
    }

    for (const animation of document.getAnimations()) {
      if (animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY) {
        animation.currentTime = 0;
        animation.pause();
      } else {
        animation.finish();
      }
    }
  }, VIRTUAL_EPOCH + at, at, revealApprove, STAGE_SELECTOR);
}

/** A timeline stamp, absolute or the name of the cue to resolve off the live
 *  movie's published table — a name follows the timeline when beats move. */
export type CueStamp = { readonly at: number } | { readonly cue: string };

/** Photograph the whole stage once at the given stamp — one real frame of
 *  the real DOM, in the README's theme. The recorder saves the
 *  EVIDENCE_STAMPS shots next to the GIF so a review can see what the
 *  animation says without decoding it; the test drives the same path on a
 *  named cue. */
export async function captureCueFrame(
  page: Page,
  origin: string,
  stamp: CueStamp,
): Promise<{ png: Uint8Array; phase: string; stage: StageRegion }> {
  const stageBox = await openMovie(page, origin);
  const cues = await page.evaluate(() => window.__kinuLandingMovie?.cues ?? {});
  const at = 'at' in stamp ? stamp.at : cues[stamp.cue];

  if (at === undefined) {
    throw new Error(`the movie publishes no "${'cue' in stamp ? stamp.cue : String(stamp.at)}" stamp`);
  }

  await seekTo(page, at, approachingApprove(at, cues));
  const png = await page.screenshot({ type: 'png', clip: stageBox });

  const phase = await page.evaluate(
    (selector: string) => document.querySelector(selector)?.getAttribute('data-movie-phase') ?? '',
    STAGE_SELECTOR,
  );

  return { png: new Uint8Array(png), phase, stage: stageBox };
}

/** One distinct frame of the manifest, and how long it is held. */
export interface ManifestEntry {
  readonly file: string;
  holdMs: number;
}

/** Photograph the movie's frames into `framesDir` as PNGs. Held beats
 *  screenshot identically twice; a duplicate shot folds into the previous
 *  entry's hold instead of paying a second palette entry. */
export async function captureFrames(
  page: Page,
  origin: string,
  framesDir: string,
): Promise<{ entries: readonly ManifestEntry[]; stage: StageRegion }> {
  const stageBox = await openMovie(page, origin);

  const handle = await page.evaluate(() => {
    const movie = window.__kinuLandingMovie;

    return movie === undefined ? null : { cues: movie.cues, duration: movie.duration };
  });

  if (handle === null) throw new Error('the landing movie handle went away after load');

  const plan = capturePlan(handle.cues, handle.duration);
  const entries: ManifestEntry[] = [];
  let previous: Uint8Array | null = null;

  for (const step of plan) {
    await seekTo(page, step.at, approachingApprove(step.at, handle.cues));
    const shot = await page.screenshot({ type: 'png', clip: stageBox });
    const bytes = new Uint8Array(shot);
    const last = entries[entries.length - 1];
    const before: Uint8Array | null = previous;

    if (before !== null && last !== undefined
      && bytes.length === before.length && bytes.every((b, i) => b === before[i])) {
      last.holdMs += step.holdMs;
      continue;
    }

    const file = join(framesDir, `frame-${String(entries.length).padStart(3, '0')}.png`);
    writeFileSync(file, shot);
    entries.push({ file, holdMs: step.holdMs });
    previous = bytes;
  }

  return { entries, stage: stageBox };
}

/** The concat manifest: every distinct frame with its hold, the final file
 *  repeated once so ffmpeg honours the last duration. The demuxer prices the
 *  trailing entry at its own 40ms tick — a constant phantom frame per loop,
 *  invisible in the animation and reported by probeGif's per-packet list. */
export function concatManifest(entries: readonly ManifestEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    lines.push(`file '${entry.file}'`, `duration ${String(entry.holdMs / 1000)}`);
  }

  const last = entries[entries.length - 1];

  if (last !== undefined) lines.push(`file '${last.file}'`);

  return `${lines.join('\n')}\n`;
}

/** ffmpeg two-pass: concat the held frames, build a palette from them, then
 *  encode the GIF through it. */
export function muxGif(framesDir: string, manifestPath: string, out: string): void {
  const palette = join(framesDir, 'palette.png');

  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', manifestPath,
    '-vf', 'palettegen=stats_mode=full',
    palette,
  ]);
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', manifestPath,
    '-i', palette,
    '-lavfi', 'paletteuse=dither=bayer:bayer_scale=4',
    out,
  ]);
}

// ffprobe's JSON prints its numbers as strings ("duration": "15.400000"), so
// the schema accepts both spellings and the reads coerce.
const ProbeOutputSchema = v.object({
  streams: v.array(v.object({
    width: v.number(),
    height: v.number(),
    nb_read_frames: v.union([v.number(), v.string()]),
    duration: v.union([v.number(), v.string()]),
  })),
});

export interface GifFacts {
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly durationS: number;
  /** Each packet's own duration in seconds — including the concat demuxer's
   *  40ms trailing phantom — so a caller can assert every hold individually
   *  instead of trusting a summed duration. */
  readonly packetDurations: readonly number[];
}

/** What ffprobe says about the produced GIF — the verification the artifact
 *  carries its own evidence for. */
export function probeGif(out: string): GifFacts {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_read_frames,duration',
    '-of', 'json',
    out,
  ]).toString();

  const probe = v.parse(ProbeOutputSchema, JSON.parse(raw));

  if (probe.streams.length === 0) {
    throw new Error(`ffprobe found no video stream in ${out}`);
  }

  const stream = probe.streams[0];

  if (stream === undefined) throw new Error(`ffprobe found no video stream in ${out}`);

  const packetsRaw = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=duration_time',
    '-of', 'csv=p=0',
    out,
  ]).toString();

  const packetDurations = packetsRaw.split('\n').filter((line) => line.length > 0).map(Number);

  if (packetDurations.some(Number.isNaN)) {
    throw new Error(`ffprobe's packet durations for ${out} did not parse`);
  }

  return {
    width: stream.width,
    height: stream.height,
    frames: Number(stream.nb_read_frames),
    durationS: Number(stream.duration),
    packetDurations,
  };
}

/** Shoot the plan movie and mux it into the README's GIF. */
export async function filmMovie(
  page: Page,
  origin: string,
  out: string,
  evidenceDir?: string,
): Promise<FilmResult> {
  const framesDir = scratchDir(`plan-demo-${String(process.pid)}`);
  const { entries } = await captureFrames(page, origin, framesDir);
  const manifestPath = join(framesDir, 'frames.txt');
  writeFileSync(manifestPath, concatManifest(entries));
  muxGif(framesDir, manifestPath, out);

  const facts = probeGif(out);
  const planned = entries.reduce((sum, entry) => sum + entry.holdMs, 0) / 1000;

  if (facts.packetDurations.length !== entries.length + 1) {
    throw new Error(`GIF has ${String(facts.packetDurations.length)} packets for ${String(entries.length)} held frames plus the phantom`);
  }

  for (const [index, entry] of entries.entries()) {
    // GIF frame delays are centiseconds, so a hold lands within ~20ms of
    // plan; 30ms of slack keeps quantization from failing a true beat.
    if (Math.abs((facts.packetDurations[index] ?? 0) - entry.holdMs / 1000) > 0.03) {
      throw new Error(`GIF packet ${String(index)} holds ${String(facts.packetDurations[index])}s, the timeline planned ${String(entry.holdMs / 1000)}s`);
    }
  }

  if (Math.abs(facts.durationS - planned) > 0.5) {
    throw new Error(`GIF runs ${String(facts.durationS)}s, the timeline planned ${String(planned)}s`);
  }

  if (evidenceDir !== undefined) {
    // The three moments a reviewer asks for: the opening state, the plan
    // awaiting its decision, and the cursor on Approve.
    for (const { name, at, cue } of EVIDENCE_STAMPS) {
      const stamp: CueStamp = at !== undefined ? { at } : { cue: cue ?? '' };
      const { png } = await captureCueFrame(page, origin, stamp);
      writeFileSync(join(evidenceDir, `kinu-plan-demo-${name}.png`), png);
    }
  }

  return {
    out,
    width: facts.width,
    height: facts.height,
    bytes: await Bun.file(out).size,
    frames: facts.frames,
    durationS: facts.durationS,
  };
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--out');
  const named = flag >= 0 ? process.argv[flag + 1] : undefined;
  const out = named === undefined ? DEFAULT_OUT : resolve(named);
  const evidenceFlag = process.argv.indexOf('--evidence');
  const evidenceDir = evidenceFlag >= 0 ? resolve(process.argv[evidenceFlag + 1] ?? '') : undefined;

  await withGallery(async ({ browser, origin }) => {
    const page = await browser.newPage();
    const result = await filmMovie(page, origin, out, evidenceDir);
    console.log(JSON.stringify(result, null, 2));
    await page.close();
  });
  process.exit(0);
}
