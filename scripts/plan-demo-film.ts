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
 * palettegen/paletteuse two-pass (requires ffmpeg + ffprobe on PATH — a host
 * prerequisite, nothing this script installs) — GitHub's README renderer animates GIF
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

// The shared contract is dependency-free: this program reads the cue table
// and handle shape straight from it without typechecking the timeline's
// component-land imports, and the drive cannot drift from the product's own
// declaration. Its `declare global` covers `window.__kinuLandingMovie` here.
import type { LandingMovieHandle, MovieCue } from '@kinu.run/core';

declare global {
  interface Window {
    /** Installed by this script's evaluateOnNewDocument virtual clock. */
    __setDemoNow?: (value: number) => void;
  }
}

/** What a seeker can ask the live movie for: the cue table and the duration.
 *  The handle's methods do not cross `page.evaluate` — Puppeteer returns a
 *  serialized copy, so reading the handle itself would type functions the
 *  copy does not carry. */
const movieStats = (page: Page): Promise<Pick<LandingMovieHandle, 'cues' | 'duration'> | undefined> => (
  page.evaluate((): Pick<LandingMovieHandle, 'cues' | 'duration'> | undefined => {
    const movie = window.__kinuLandingMovie;

    return movie === undefined ? undefined : { cues: movie.cues, duration: movie.duration };
  })
);

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

/** The recorder's own cadence — densify the window before each published cue
 *  so the frames bracket whatever the movie does there. It deliberately does
 *  NOT read the timeline's cursor timing: capture policy stays independent of
 *  private animation constants, and the cue table is the contract. */
const APPROACH_WINDOW_MS = 800;

const APPROACH_STEP_MS = 160;

/** The cues whose approach is sampled densely: the click and the two beats
 *  the cursor travels to. */
const CURSOR_ARRIVALS: readonly MovieCue[] = ['submitted', 'approve', 'finalText'];

/** One evidence still: `at` an absolute stamp or `cue` a beat name resolved
 *  off the live movie's table, `offsetMs` shifting either (negative for the
 *  approach). */
export type EvidenceStamp = { readonly name: string; readonly offsetMs?: number }
  & ({ readonly at: number } | { readonly cue: MovieCue });

/** The beats the recorder saves stills of next to the GIF, so a review can
 *  see what the animation actually says without decoding it. */
export const EVIDENCE_STAMPS: readonly EvidenceStamp[] = [
  { name: 'first', at: 0 },
  { name: 'review', cue: 'planReady' },
  // The cursor mid-approach with the approve row scrolled into view — proof
  // the click lands on a control the reader can see.
  { name: 'preapprove', cue: 'approve', offsetMs: -400 },
  { name: 'approve', cue: 'approve' },
];

/**
 * The capture plan. Dense while the cursor travels or a beat just landed,
 * sparse through holds, derived from the same cue table the live movie plays.
 * A GIF holds a frame for as long as its duration says, so the cadence is a
 * clarity budget, not a size one. The last frame holds the settled state
 * before the loop restarts.
 */
export function capturePlan(cues: LandingMovieHandle['cues'], end: number): readonly CaptureFrame[] {
  const stamps = new Set<number>();

  for (let at = 0; at < end; at += 560) stamps.add(at);

  for (const at of Object.values(cues)) stamps.add(Math.min(at + 40, end));

  for (const name of CURSOR_ARRIVALS) {
    const arrival = cues[name];

    if (arrival === undefined) throw new Error(`the movie publishes no "${name}" cue`);

    for (let at = Math.max(0, arrival - APPROACH_WINDOW_MS); at <= arrival; at += APPROACH_STEP_MS) stamps.add(at);
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
  await page.evaluateOnNewDocument((theme: string, epoch: number) => {
    // The landing reads its mode from localStorage before first paint, and
    // the fixtures stamp themselves off Date.now() at module evaluation —
    // so the virtual epoch starts NOW, not at the first seek: a fixture's
    // createdAt and a seek's stamp must share one clock or an approved plan
    // reads older than the pending one.
    localStorage.setItem('theme', theme);
    let virtual = epoch;
    Object.defineProperty(window, '__setDemoNow', { value: (at: number) => { virtual = at; } });
    Date.now = () => virtual;
  }, THEME, VIRTUAL_EPOCH);
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
function approachingApprove(at: number, cues: LandingMovieHandle['cues']): boolean {
  const approve = cues['approve'];

  return approve !== undefined && at >= approve - APPROACH_WINDOW_MS && at <= approve + APPROACH_WINDOW_MS;
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
      // The scrollable ancestor of the decisions row is the Work pane's own
      // overflow container — found, not named, because the row is a sibling
      // of the document scroller inside PlanReviewView, not its child.
      let pane: HTMLElement | null = decisions instanceof HTMLElement ? decisions.parentElement : null;

      while (pane !== null && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;

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
export type CueStamp = { readonly at: number } | { readonly cue: MovieCue };

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
  const movie = await movieStats(page);

  if (movie === undefined) throw new Error('the landing movie handle went away after load');

  const cues = movie.cues;
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

/** One distinct frame of the manifest — named by basename, since the
 *  manifest lives in the frames directory itself and relative names never
 *  need quoting — and how long it is held. */
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

  const handle = await movieStats(page);

  if (handle === undefined) throw new Error('the landing movie handle went away after load');

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

    const file = `frame-${String(entries.length).padStart(3, '0')}.png`;
    writeFileSync(join(framesDir, file), shot);
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
    // ffmpeg's default gifflags — offsetting and transdiff — are the GIF's
    // own delta encoding: a frame may crop to its changed rectangle and mark
    // unchanged pixels transparent, which is legal under disposal 0/1. The
    // film test's parser bounds what that means; frame 0's opacity is proven
    // by decoding it in plan-demo-film.test.ts.
    '-lavfi', 'paletteuse=dither=bayer:bayer_scale=4',
    out,
  ]);
}

// ffprobe's JSON prints most numbers as strings ("duration": "15.400000")
// and answers "N/A" for the ones it cannot read — so every field is taken as
// string-or-number and each read is finite-checked: a parse that returns
// NaN/Infinity would pass a width assertion onto a broken file.
const ProbeOutputSchema = v.object({
  streams: v.array(v.object({
    width: v.union([v.number(), v.string()]),
    height: v.union([v.number(), v.string()]),
    nb_read_frames: v.union([v.number(), v.string()]),
    duration: v.union([v.number(), v.string()]),
  })),
});

/** Strictly-positive integer, or throws — the GIF's geometry and frame count
 *  must be real before a caller can trust them. */
function positiveInt(value: number, field: string, out: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`ffprobe's ${field} for ${out} is ${String(value)}, not a positive integer`);
  }

  return value;
}

/** Finite and non-negative, or throws — durations may be 0, never NaN/N/A. */
function finiteSeconds(value: number, field: string, out: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`ffprobe's ${field} for ${out} is ${String(value)}, not a finite duration`);
  }

  return value;
}

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
  const stream = probe.streams[0];

  if (stream === undefined) throw new Error(`ffprobe found no video stream in ${out}`);

  const packetsRaw = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=duration_time',
    '-of', 'csv=p=0',
    out,
  ]).toString();

  const packetDurations = packetsRaw.split('\n').filter((line) => line.length > 0)
    .map((line, index) => finiteSeconds(Number(line), `packet ${String(index)} duration`, out));

  return {
    width: positiveInt(Number(stream.width), 'width', out),
    height: positiveInt(Number(stream.height), 'height', out),
    frames: positiveInt(Number(stream.nb_read_frames), 'frame count', out),
    durationS: finiteSeconds(Number(stream.duration), 'duration', out),
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
    // The four moments a reviewer asks for: the opening state, the plan
    // awaiting its decision, the cursor on approach, and the click itself.
    const movie = await movieStats(page);

    if (movie === undefined) throw new Error('the landing movie handle went away after load');

    for (const stamp of EVIDENCE_STAMPS) {
      const target = 'at' in stamp ? stamp.at : movie.cues[stamp.cue];

      if (target === undefined) throw new Error(`the movie publishes no "${'cue' in stamp ? stamp.cue : String(stamp.at)}" cue`);

      const { png } = await captureCueFrame(page, origin, { at: target + (stamp.offsetMs ?? 0) });
      writeFileSync(join(evidenceDir, `kinu-plan-demo-${stamp.name}.png`), png);
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

  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    const result = await filmMovie(page, origin, out, evidenceDir);
    console.log(JSON.stringify(result, null, 2));
    await page.close();
  });
  process.exit(0);
}
