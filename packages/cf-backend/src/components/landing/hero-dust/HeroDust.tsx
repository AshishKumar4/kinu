import { useEffect, useRef, type ReactElement } from 'react';

import { createDustRenderer, DustField, type DustRenderer } from '@kinu.run/core/web/hero-canvas';
import { boxOf, createPlayback, readPalette, type FrameTimes } from '../search-tree/stage';

/** Its own seed, not the tree's: the two fields never share a picture. */
const DUST_SEED = 91;

/** Motes per CSS px² of the host; a 390×700 phone gets about 55. */
const DENSITY = 1 / 5_000;

const MIN_MOTES = 24;

const MAX_MOTES = 90;

/** The still a reduced-motion visitor sees: the field this far in, so the
 *  twinkle is mid-phase rather than uniform. Shorter than the tree's still,
 *  which has to have grown, scored, and pruned first; dust only has to shimmer. */
const DUST_STILL_SECONDS = 6;

const STATIC_STEP = 1 / 30;

/** What a gate can read off the live dust: which renderer took the canvas,
 *  the last frames' cost, the field's clock, and how many motes it drew. */
export interface HeroDustHandle {
  renderer(): 'canvas' | 'static' | 'pending';
  frameTimes(): FrameTimes;
  time(): number;
  count(): number;
}

declare global {
  interface Window {
    __kinuHeroDust?: HeroDustHandle;
  }
}

function mountHeroDust(host: HTMLElement): () => void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let palette = readPalette();
  const box = boxOf(host);
  const count = Math.min(MAX_MOTES, Math.max(MIN_MOTES, Math.round(box.width * box.height * DENSITY)));
  const field = new DustField({ seed: DUST_SEED, count });
  field.setAspect(box.height / box.width);
  let renderer: DustRenderer | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let still = reduced.matches;

  const playback = createPlayback(host, () => !still && renderer !== null, (step) => {
    if (renderer === null) return;
    field.step(step);
    renderer.render(field.frame());
  });

  const fit = (): void => {
    if (renderer === null || canvas === null) return;
    const next = boxOf(host);
    canvas.width = Math.round(next.width * next.ratio);
    canvas.height = Math.round(next.height * next.ratio);
    renderer.resize(next.width, next.height, next.ratio);
    field.setAspect(next.height / next.width);
  };

  /** One evolved frame, no clock: the still a reduced-motion visitor gets. */
  const paintStill = (): void => {
    if (renderer === null) return;
    const frozen = new DustField({ seed: DUST_SEED, count });
    const next = boxOf(host);
    frozen.setAspect(next.height / next.width);
    const steps = Math.round(DUST_STILL_SECONDS / STATIC_STEP);

    for (let index = 0; index < steps; index += 1) frozen.step(STATIC_STEP);
    renderer.render(frozen.frame());
  };

  const start = (): void => {
    playback.stop();
    renderer?.dispose();
    renderer = null;
    canvas?.remove();
    canvas = null;
    const next = document.createElement('canvas');
    next.className = 'absolute inset-0 size-full';
    host.appendChild(next);
    canvas = next;
    const context = next.getContext('2d');

    if (context === null) throw new Error('the dust canvas has no 2d context');
    renderer = createDustRenderer(context, palette);
    next.dataset.renderer = still ? 'static' : 'canvas';
    next.dataset.motes = String(count);
    fit();

    if (still) {
      paintStill();

      return;
    }

    playback.sync();
  };

  const onMotionPreference = (): void => {
    still = reduced.matches;
    start();
  };

  const onTheme = (): void => {
    palette = readPalette();
    renderer?.setPalette(palette);

    if (still) paintStill();
  };

  const onResize = (): void => {
    fit();

    if (still) paintStill();
  };

  const resize = new ResizeObserver(onResize);
  const theme = new MutationObserver(onTheme);

  const handle: HeroDustHandle = {
    renderer: () => (renderer === null ? 'pending' : still ? 'static' : 'canvas'),
    frameTimes: () => playback.frameTimes(),
    time: () => field.time,
    count: () => count,
  };

  resize.observe(host);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  reduced.addEventListener('change', onMotionPreference);
  window.__kinuHeroDust = handle;
  start();

  return () => {
    resize.disconnect();
    theme.disconnect();
    reduced.removeEventListener('change', onMotionPreference);
    playback.dispose();
    renderer?.dispose();
    canvas?.remove();

    if (window.__kinuHeroDust === handle) delete window.__kinuHeroDust;
  };
}

/**
 * The hero's backdrop where the copy stacks: below `lg` the paragraph spans
 * the full width, and the tree's seed, which sits in the copy's empty second
 * column on a wide screen, would run straight through the words — so the
 * living search tree stays a `lg`-and-up affair and the phone gets this dust
 * instead: a handful of gold motes adrift in the same warm light, faint
 * enough to sit under type. Canvas2D only, deliberately: the WebGPU chunk is
 * a download a phone should never pay for a decoration.
 */
export function HeroDust(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;

    if (host === null) return;

    return mountHeroDust(host);
  }, []);

  return (
    <div
      ref={hostRef}
      data-hero-dust
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
    />
  );
}
