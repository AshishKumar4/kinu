import { useEffect, useRef, type ReactElement } from 'react';

import { cssRgba, seededRandom, type HeroPalette } from '@kinu.run/core/web/hero-art';
import { boxOf, createPlayback, readPalette, type FrameTimes } from '../search-tree/stage';

/**
 * The dust the hero settles for on a phone: small gold motes adrift in warm
 * light, too slow to read as motion and faint enough to sit under type. Pure
 * and deterministic — the same seed and the same `step(dt)` sequence produce
 * the same frame on any runtime. There is no DOM here and no drawing; the
 * renderer at the bottom reads `frame()` and draws what it says.
 */

/** One mote in the frame buffer: x, y in the unit box, radius in CSS px, alpha in 0..1. */
const DUST_STRIDE = 4;

/** Top speed of a mote in box widths per second: over a minute to cross a phone. */
const MAX_DRIFT = 0.015;

/** Alpha of a mote's core at full twinkle; the halo is a tenth of it. Set
 *  where the paragraph keeps WCAG AA under the worst pixel a mote puts behind
 *  it: measured 2026-09-13 at 390×844 and 430×932, the mean and 1% tail did
 *  not move and the worst pixel read 4.62 on dark and 4.50 on paper. */
const CORE_ALPHA: Record<HeroPalette['mode'], number> = { dark: 0.18, light: 0.18 };

/** How far past an edge a mote drifts before it re-enters on the far side. */
const WRAP_MARGIN = 0.02;

const WRAP_SPAN = 1 + 2 * WRAP_MARGIN;

/** The wander's vertical swing, in box heights per second. Sideways a mote
 *  draws a fifth to four-fifths of MAX_DRIFT; vertically the range below plus
 *  this never reaches it either, so nothing is clamped at runtime. */
const WANDER = 0.004;

export interface DustOptions {
  readonly seed: number;
  readonly count: number;
}

export interface DustFrame {
  readonly count: number;
  /** `count` motes of DUST_STRIDE floats: x, y, radius, alpha. */
  readonly motes: Float32Array<ArrayBuffer>;
}

interface Mote {
  x: number;
  y: number;
  readonly radius: number;
  readonly base: number;
  readonly vx: number;
  readonly vy: number;
  readonly wanderPhase: number;
  readonly wanderRate: number;
  readonly twinklePhase: number;
  readonly twinkleRate: number;
}

export class DustField {
  readonly count: number;

  private readonly motes: Mote[] = [];

  private aspect = 1;

  private elapsed = 0;

  private readonly buffer: Float32Array<ArrayBuffer>;

  constructor(options: DustOptions) {
    this.count = options.count;
    const random = seededRandom(options.seed);

    for (let index = 0; index < this.count; index += 1) {
      this.motes.push({
        x: random(),
        y: random(),
        radius: 0.6 + random() * 1.2,
        base: 0.45 + random() * 0.55,
        vx: (random() < 0.5 ? -1 : 1) * MAX_DRIFT * (0.2 + random() * 0.6),
        vy: -0.006 + random() * 0.008,
        wanderPhase: random() * Math.PI * 2,
        wanderRate: 0.15 + random() * 0.25,
        twinklePhase: random() * Math.PI * 2,
        twinkleRate: 0.3 + random() * 0.6,
      });
    }

    this.buffer = new Float32Array(this.count * DUST_STRIDE);
  }

  get time(): number {
    return this.elapsed;
  }

  /** height / width of the box, so vertical drift is scaled by 1/aspect and motion is isotropic in pixels. */
  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  step(dt: number): void {
    this.elapsed += dt;

    for (const mote of this.motes) {
      mote.x += mote.vx * dt;
      mote.y += (mote.vy + WANDER * Math.sin(mote.wanderPhase + mote.wanderRate * this.elapsed)) * dt / this.aspect;

      if (mote.x < -WRAP_MARGIN) mote.x += WRAP_SPAN;
      else if (mote.x > 1 + WRAP_MARGIN) mote.x -= WRAP_SPAN;

      if (mote.y < -WRAP_MARGIN) mote.y += WRAP_SPAN;
      else if (mote.y > 1 + WRAP_MARGIN) mote.y -= WRAP_SPAN;
    }
  }

  frame(): DustFrame {
    let at = 0;

    for (const mote of this.motes) {
      this.buffer[at] = mote.x;
      this.buffer[at + 1] = mote.y;
      this.buffer[at + 2] = mote.radius;
      this.buffer[at + 3] = mote.base * (0.55 + 0.45 * Math.sin(mote.twinklePhase + mote.twinkleRate * this.elapsed));
      at += DUST_STRIDE;
    }

    return { count: this.count, motes: this.buffer };
  }
}

/** The slice of CanvasRenderingContext2D the dust draws with; a recording stub satisfies it in tests. */
export interface DustSurface {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
}

export interface DustRenderer {
  readonly kind: 'canvas';
  resize(width: number, height: number, ratio: number): void;
  setPalette(palette: HeroPalette): void;
  render(frame: DustFrame): void;
  dispose(): void;
}

/**
 * Canvas2D drawing of the dust field: every mote is a wide faint halo under a
 * denser core, in the same gold the tree's kept path wears — deepened to the
 * text-grade gold on paper, the same rule toneColor applies to TONE_BRIGHT.
 */
export function createDustRenderer(context: DustSurface, initialPalette: HeroPalette): DustRenderer {
  let palette = initialPalette;
  let width = 1;
  let height = 1;
  let ratio = 1;

  return {
    kind: 'canvas',
    resize(nextWidth, nextHeight, nextRatio) {
      width = nextWidth;
      height = nextHeight;
      ratio = nextRatio;
    },
    setPalette(next) {
      palette = next;
    },
    render(frame) {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.globalAlpha = 1;
      const color = palette.mode === 'light' ? palette.bright : palette.accent;
      const core = CORE_ALPHA[palette.mode];

      for (let index = 0; index < frame.count; index += 1) {
        const at = index * DUST_STRIDE;
        const alpha = frame.motes[at + 3] ?? 0;

        if (alpha <= 0.004) continue;
        const x = (frame.motes[at] ?? 0) * width;
        const y = (frame.motes[at + 1] ?? 0) * height;
        const radius = frame.motes[at + 2] ?? 1;

        context.beginPath();
        context.arc(x, y, radius * 3.2, 0, Math.PI * 2);
        context.fillStyle = cssRgba(color, alpha * core * 0.1);
        context.fill();

        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = cssRgba(color, alpha * core);
        context.fill();
      }
    },
    dispose() {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width * ratio, height * ratio);
    },
  };
}

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
