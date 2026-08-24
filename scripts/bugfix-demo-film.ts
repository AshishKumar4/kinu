#!/usr/bin/env bun
/**
 * Cut the README's bug-fix animation from the landing's live demo.
 *
 * One timeline exists (`bugfix-demo-timeline.ts`): the landing plays it, the
 * public-page tests seek it, and this script photographs it. Every frame here
 * is a Chrome screenshot of the real DOM at a timeline stamp the timeline
 * itself publishes (`captureFrames()`), so the shipped animation cannot drift
 * from what the landing shows — regenerate it with:
 *
 *   bun scripts/bugfix-demo-film.ts            # writes docs/assets/kinu-bugfix-demo.webp
 *   bun scripts/bugfix-demo-film.ts --out /tmp/demo.webp
 *
 * The frames come out of Chrome as single-image WebPs and are muxed into one
 * animated WebP here, with no encoder dependency. Every ANMF frame is a
 * full-canvas replace (blend off, dispose none): the superimposed-frames
 * defect class needs partial frames or alpha blending, and this container
 * never emits either. The script verifies that on the produced bytes, then
 * enforces the 2 MB budget.
 *
 * Tool duration chips read Date.now(); the page clock is virtualised to the
 * timeline stamp before each seek, so a chip says the beat's true duration
 * instead of how long two screenshots happened to take.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Type-only: brings the timeline module's `window.__kinuBugfixDemo` global
// declaration into this program without importing any React surface.
import type { DemoCaptureFrame } from '../packages/cf-backend/src/components/landing/bugfix-demo-timeline';

import { withGallery } from './gallery-harness';

declare global {
  interface Window {
    /** Installed by this script's evaluateOnNewDocument virtual clock. */
    __setDemoNow?: (value: number) => void;
  }
}

const REPO = resolve(import.meta.dir, '..');
const OUT = ((): string => {
  const flag = process.argv.indexOf('--out');
  const named = flag >= 0 ? process.argv[flag + 1] : undefined;
  return named === undefined
    ? resolve(REPO, 'docs/assets/kinu-bugfix-demo.webp')
    : resolve(named);
})();

const BUDGET_BYTES = 2_000_000;
/** Fixed page epoch so duration chips render identically on every run. */
const VIRTUAL_EPOCH = 1_755_993_600_000;
/** Lossy quality ladder: first pass that fits the budget ships. */
const QUALITIES = [56, 46, 38] as const;

const fourcc = (bytes: Uint8Array, offset: number): string =>
  String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);

const u32le = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};

const u24le = (value: number): Uint8Array => new Uint8Array([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);

/** The image-data chunks of one still WebP (VP8/VP8L/ALPH), padded as stored. */
function imageChunks(still: Uint8Array): Uint8Array {
  if (fourcc(still, 0) !== 'RIFF' || fourcc(still, 8) !== 'WEBP') {
    throw new Error('screenshot is not a WebP');
  }
  const parts: Uint8Array[] = [];
  let offset = 12;
  while (offset + 8 <= still.length) {
    const kind = fourcc(still, offset);
    const size = new DataView(still.buffer, still.byteOffset + offset + 4, 4).getUint32(0, true);
    const padded = size + (size % 2);
    if (kind === 'VP8 ' || kind === 'VP8L' || kind === 'ALPH') {
      parts.push(still.subarray(offset, offset + 8 + padded));
    }
    offset += 8 + padded;
  }
  if (parts.length === 0) throw new Error('screenshot WebP carries no image chunk');
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunk(kind: string, body: Uint8Array): Uint8Array {
  const padded = body.length + (body.length % 2);
  const out = new Uint8Array(8 + padded);
  out.set(new TextEncoder().encode(kind), 0);
  out.set(u32le(body.length), 4);
  out.set(body, 8);
  return out;
}

interface MuxFrame {
  readonly image: Uint8Array;
  readonly durationMs: number;
  /** Frame placement on the canvas. x/y MUST be even (stored halved). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Mux still WebP frames into one animated WebP. Every frame REPLACES its
 *  region (blend off) and disposes to nothing, so pixels persist until a
 *  later frame repaints them — beat frames are full-canvas, cursor frames a
 *  small dirty rect. That composition cannot superimpose. */
function muxAnimation(frames: readonly MuxFrame[], width: number, height: number): Uint8Array {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02; // animation flag
  vp8x.set(u24le(width - 1), 4);
  vp8x.set(u24le(height - 1), 7);
  const anim = new Uint8Array(6); // background rgba 0, loop count 0 = forever
  const body: Uint8Array[] = [chunk('VP8X', vp8x), chunk('ANIM', anim)];
  for (const frame of frames) {
    if (frame.x % 2 !== 0 || frame.y % 2 !== 0) {
      throw new Error(`frame offset ${String(frame.x)},${String(frame.y)} is odd — ANMF stores halved offsets`);
    }
    const image = imageChunks(frame.image);
    const header = new Uint8Array(16);
    header.set(u24le(frame.x / 2), 0);
    header.set(u24le(frame.y / 2), 3);
    header.set(u24le(frame.width - 1), 6);
    header.set(u24le(frame.height - 1), 9);
    header.set(u24le(Math.max(1, Math.round(frame.durationMs))), 12);
    header[15] = 0b0000_0010; // bit1 blend=DO NOT BLEND (replace), bit0 dispose=none
    const anmf = new Uint8Array(header.length + image.length);
    anmf.set(header, 0);
    anmf.set(image, header.length);
    body.push(chunk('ANMF', anmf));
  }
  const payload = body.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(12 + payload);
  out.set(new TextEncoder().encode('RIFF'), 0);
  out.set(u32le(4 + payload), 4);
  out.set(new TextEncoder().encode('WEBP'), 8);
  let at = 12;
  for (const part of body) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

interface AnimationFacts {
  readonly frames: number;
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  /** Every frame replaces (no blend, dispose none) inside the canvas, and the
   *  first frame covers the whole canvas — the composition that cannot leak. */
  readonly cleanCompose: boolean;
}

/** Re-parse the produced bytes and verify the composition contract. */
function decodeFacts(bytes: Uint8Array): AnimationFacts {
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') throw new Error('not a WebP');
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  let offset = 12;
  let width = 0;
  let height = 0;
  let frames = 0;
  let durationMs = 0;
  let cleanCompose = true;
  while (offset + 8 <= bytes.length) {
    const kind = fourcc(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    if (kind === 'VP8X') {
      width = 1 + (view.getUint8(offset + 12) | (view.getUint8(offset + 13) << 8) | (view.getUint8(offset + 14) << 16));
      height = 1 + (view.getUint8(offset + 15) | (view.getUint8(offset + 16) << 8) | (view.getUint8(offset + 17) << 16));
    }
    if (kind === 'ANMF') {
      const at = offset + 8;
      const x = 2 * (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16));
      const y = 2 * (view.getUint8(at + 3) | (view.getUint8(at + 4) << 8) | (view.getUint8(at + 5) << 16));
      const frameWidth = 1 + (view.getUint8(at + 6) | (view.getUint8(at + 7) << 8) | (view.getUint8(at + 8) << 16));
      const frameHeight = 1 + (view.getUint8(at + 9) | (view.getUint8(at + 10) << 8) | (view.getUint8(at + 11) << 16));
      durationMs += view.getUint8(at + 12) | (view.getUint8(at + 13) << 8) | (view.getUint8(at + 14) << 16);
      const flags = view.getUint8(at + 15);
      const noBlend = (flags & 0b10) !== 0;
      const disposeNone = (flags & 0b1) === 0;
      const inBounds = x + frameWidth <= width && y + frameHeight <= height;
      const firstIsFull = frames > 0 || (x === 0 && y === 0 && frameWidth === width && frameHeight === height);
      if (!noBlend || !disposeNone || !inBounds || !firstIsFull) cleanCompose = false;
      frames += 1;
    }
    offset += 8 + size + (size % 2);
  }
  return { frames, durationMs, width, height, cleanCompose };
}

await withGallery(async ({ browser, origin }) => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1000 });
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ]);
  await page.evaluateOnNewDocument(`(() => {
    const real = Date.now.bind(Date);
    let virtual = null;
    Object.defineProperty(window, '__setDemoNow', { value: (v) => { virtual = v; } });
    Date.now = () => virtual ?? real();
  })();`);
  await page.goto(`${origin}/landing.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__kinuBugfixDemo !== undefined, { timeout: 20_000 });
  // Vite's dep optimizer may force one full reload after first paint; a
  // settle pause plus a re-check keeps every later wait on the final page.
  const settle = Promise.withResolvers<void>();
  setTimeout(settle.resolve, 1_500);
  await settle.promise;
  await page.waitForFunction(
    () => window.__kinuBugfixDemo !== undefined && document.fonts.status === 'loaded',
    { timeout: 20_000 },
  );

  const stageBox = await page.evaluate(() => {
    document.querySelector('[data-bugfix-demo]')?.scrollIntoView({ block: 'center' });
    window.__kinuBugfixDemo?.pause();
    const rect = document.querySelector('[data-bugfix-demo]')?.getBoundingClientRect();
    return rect === undefined ? null : {
      x: Math.round(rect.x + window.scrollX),
      y: Math.round(rect.y + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
  if (stageBox === null) throw new Error('bug-fix demo stage not found on the landing');

  const plan: readonly DemoCaptureFrame[]
    = await page.evaluate(() => window.__kinuBugfixDemo?.captureFrames() ?? []);
  if (plan.length === 0) throw new Error('timeline published no capture frames');
  const cueValues: readonly number[] = await page.evaluate(
    () => Object.values(window.__kinuBugfixDemo?.cues ?? {}),
  );

  interface CursorSpot { readonly x: number; readonly y: number; readonly visible: boolean }

  /** Seek the live timeline, then report where the cursor landed. */
  const seekTo = async (at: number): Promise<CursorSpot> => await page.evaluate(async (now: number, target: number) => {
    window.__setDemoNow?.(now);
    await window.__kinuBugfixDemo?.seek(target);
    const cursor = document.querySelector<HTMLElement>('[data-demo-cursor]');
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(cursor?.style.transform ?? '');
    return {
      x: match === null ? 0 : Number(match[1]),
      y: match === null ? 0 : Number(match[2]),
      visible: cursor !== null && Number(cursor.style.opacity || '0') > 0,
    };
  }, VIRTUAL_EPOCH + at, at);

  /** A rectangle in stage coordinates, even-aligned for ANMF placement. */
  interface StageRegion { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

  /** The stage region a cursor-only frame must repaint: both cursor spots
   *  plus the ripple ring, snapped to even offsets for ANMF. */
  const dirtyRect = (previous: CursorSpot, current: CursorSpot): StageRegion => {
    const spots = [previous, current].filter((spot) => spot.visible);
    const minX = Math.min(...spots.map((spot) => spot.x)) - 48;
    const maxX = Math.max(...spots.map((spot) => spot.x)) + 52;
    const minY = Math.min(...spots.map((spot) => spot.y)) - 48;
    const maxY = Math.max(...spots.map((spot) => spot.y)) + 56;
    const x = Math.max(0, 2 * Math.floor(minX / 2));
    const y = Math.max(0, 2 * Math.floor(minY / 2));
    return {
      x,
      y,
      width: Math.min(stageBox.width - x, Math.ceil(maxX) - x),
      height: Math.min(stageBox.height - y, Math.ceil(maxY) - y),
    };
  };

  let shipped: Uint8Array | null = null;
  let shippedQuality = 0;
  for (const quality of QUALITIES) {
    const frames: MuxFrame[] = [];
    let previousAt = -1;
    let previousSpot: CursorSpot = { x: 0, y: 0, visible: false };
    for (const step of plan) {
      const spot = await seekTo(step.at);
      // A beat frame repaints the whole stage. Between beats only the cursor
      // and its ripple move; 200ms after a click the pressed control also
      // relaxes, so the window after any cue stays full-canvas.
      const beat = previousAt < 0 || cueValues.some((cue) => (
        (previousAt < cue + 40 && cue + 40 <= step.at) || (previousAt < cue + 200 && cue + 200 <= step.at)
      ));
      if (!beat && !spot.visible && !previousSpot.visible) {
        // Nothing on the stage changed; the previous frame just holds longer.
        const last = frames.at(-1);
        if (last !== undefined) {
          frames[frames.length - 1] = { ...last, durationMs: last.durationMs + step.holdMs };
          previousAt = step.at;
          continue;
        }
      }
      const region = beat || (!spot.visible && !previousSpot.visible)
        ? { x: 0, y: 0, width: stageBox.width, height: stageBox.height }
        : dirtyRect(previousSpot, spot);
      const shot = await page.screenshot({
        type: 'webp',
        quality,
        clip: { x: stageBox.x + region.x, y: stageBox.y + region.y, width: region.width, height: region.height },
      });
      frames.push({ image: shot, durationMs: step.holdMs, ...region });
      previousAt = step.at;
      previousSpot = spot;
    }
    const animation = muxAnimation(frames, stageBox.width, stageBox.height);
    console.log(`quality ${String(quality)}: ${String(frames.length)} frames, ${String(animation.length)} bytes`);
    if (animation.length <= BUDGET_BYTES) {
      shipped = animation;
      shippedQuality = quality;
      break;
    }
  }
  if (shipped === null) {
    throw new Error(`animation exceeds ${String(BUDGET_BYTES)} bytes at every quality in [${QUALITIES.join(', ')}]`);
  }

  const facts = decodeFacts(shipped);
  if (!facts.cleanCompose) {
    throw new Error('composition contract broken: a frame blends, disposes, escapes the canvas, or the first frame is partial');
  }
  if (facts.width !== stageBox.width || facts.height !== stageBox.height) {
    throw new Error(`canvas ${String(facts.width)}x${String(facts.height)} does not match the stage clip`);
  }
  const planned = plan.reduce((sum, step) => sum + step.holdMs, 0);
  if (facts.durationMs !== planned) {
    throw new Error(`animation runs ${String(facts.durationMs)}ms, timeline planned ${String(planned)}ms`);
  }
  writeFileSync(OUT, shipped);
  console.log(JSON.stringify({
    out: OUT,
    width: facts.width,
    height: facts.height,
    bytes: shipped.length,
    frames: facts.frames,
    durationMs: facts.durationMs,
    quality: shippedQuality,
  }, null, 2));
  await page.close();
});
process.exit(0);
