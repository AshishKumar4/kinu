/**
 * The silk behind the hero.
 *
 * Kinu is 絹, and the theme's own story is shot silk: an indigo warp under a
 * lighter weft, a sheen that moves when the cloth does. The hero's ground is
 * that warp — a field of long threads, each one a pair of slow sine terms,
 * with one bright chord where the light sits. Dark ground, one light idea,
 * slow.
 *
 * One field, two renderings. `weaveStill` is the field at t=0, as SVG, and it
 * is what ships in the document: a reader with no script, or one who asked for
 * less motion, gets a designed still rather than a blank. `WEAVE_SCRIPT` draws
 * the SAME field on a canvas and moves it, reading the thread parameters from
 * a data attribute so the two renderings cannot drift. The script fades the
 * canvas in over the still, so motion is added by script, never required by
 * the page — the same way round as the hero tree's growth.
 *
 * Restraint is enforced by construction: thread alpha never exceeds
 * `SHEEN_ALPHA`, colour is only ever a mix of two tokens the page already
 * owns, and the drift period is ~40 s. Nothing glows, nothing blurs.
 *
 * The budget is measured, not promised: the script keeps its worst frame cost
 * on `window.__kinuWeave`, the draw is one clear plus `THREADS` strokes with
 * no DOM reads or writes inside the loop, and the browser gate asserts the
 * worst frame under 8 ms with zero layouts while it runs. Hidden tabs get no
 * animation frames, and the loop also parks itself when the hero scrolls
 * away.
 */

import { rng } from './hero-search';

/** One warp thread: a resting line, two sine terms, and a tone. Amplitudes and
 *  offsets are fractions of the weave's height; wavelengths are cycles across
 *  its width; speeds are radians per second, kept low enough that a thread
 *  needs most of a minute to repeat. */
export interface WeaveThread {
  /** Resting height, 0..1 of the field. */
  readonly y: number;
  readonly amp1: number;
  readonly k1: number;
  readonly p1: number;
  readonly w1: number;
  readonly amp2: number;
  readonly k2: number;
  readonly p2: number;
  readonly w2: number;
  /** 0..1 toward the accent; the rest is the page's faint ink. */
  readonly tone: number;
  /** Stroke width in px. */
  readonly weight: number;
  /** Base opacity before the sheen lifts it. */
  readonly alpha: number;
}

export interface WeaveField {
  readonly threads: readonly WeaveThread[];
  /** Where the sheen sits at t=0, 0..1 down the field. */
  readonly sheen: number;
}

/** Thread count. Enough that the field reads as cloth rather than as lines,
 *  few enough that a frame is ~30 strokes and never near the budget. */
const THREADS = 30;

/** The lift the sheen adds at its centre. The ceiling for any thread's alpha
 *  is base + this, which is what keeps the ground a ground. */
const SHEEN_ALPHA = 0.1;

/** How wide the bright chord is, as a fraction of the field's height. */
const SHEEN_WIDTH = 0.16;

export function weaveField(seed = 0x514B): WeaveField {
  const random = rng(seed);
  const threads: WeaveThread[] = [];
  for (let i = 0; i < THREADS; i++) {
    // Even coverage with jitter: the field is cloth, not a graph.
    const y = (i + 0.5) / THREADS + (random() - 0.5) * 0.02;
    threads.push({
      y,
      amp1: 0.016 + random() * 0.03,
      k1: 0.8 + random() * 1.1,
      p1: random() * Math.PI * 2,
      w1: 0.04 + random() * 0.05,
      amp2: 0.004 + random() * 0.012,
      k2: 2.2 + random() * 1.8,
      p2: random() * Math.PI * 2,
      w2: 0.07 + random() * 0.08,
      tone: 0.35 + random() * 0.65,
      weight: 0.7 + random() * 0.7,
      alpha: 0.025 + random() * 0.035,
    });
  }
  // The light sits low-centre at rest, under the tree rather than the words.
  return { threads, sheen: 0.62 };
}

const FIELD = weaveField();

/** Thread height at `x` (0..1 across), at time `t` seconds. Shared shape of
 *  both renderings; the still is this at t=0. */
function threadY(thread: WeaveThread, x: number, t: number): number {
  return thread.y
    + thread.amp1 * Math.sin(2 * Math.PI * thread.k1 * x - thread.w1 * t + thread.p1)
    + thread.amp2 * Math.sin(2 * Math.PI * thread.k2 * x + thread.w2 * t + thread.p2);
}

/** The sheen's lift on a thread at height `y`, with the chord centred on
 *  `centre`. A raised cosine rather than a gaussian: it reaches true zero, so
 *  most of the field stays at its base alpha. */
function sheenLift(y: number, centre: number): number {
  const d = Math.abs(y - centre) / SHEEN_WIDTH;
  return d >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * d));
}

const STILL_STEPS = 36;

/**
 * The field at t=0, as SVG. `preserveAspectRatio="none"` on purpose: warp
 * threads stretch with their loom, and a sine stays a sine under it.
 */
export function weaveStill(field: WeaveField = FIELD): string {
  const paths = field.threads.map((thread) => {
    const points: string[] = [];
    for (let s = 0; s <= STILL_STEPS; s++) {
      const x = s / STILL_STEPS;
      const y = threadY(thread, x, 0);
      points.push(`${s === 0 ? 'M' : 'L'}${(x * 100).toFixed(2)} ${(y * 100).toFixed(2)}`);
    }
    const alpha = thread.alpha + SHEEN_ALPHA * sheenLift(thread.y, field.sheen);
    // Ink is a mix the cascade owns, so the weave re-tunes itself when a
    // palette does — the same device `heroFigure` uses for node fills.
    const ink = `color-mix(in oklab, var(--c-accent) ${Math.round(thread.tone * 100)}%, var(--c-text-3))`;
    return `<path d="${points.join(' ')}" fill="none" stroke-width="${thread.weight.toFixed(2)}"`
      + ` style="stroke:${ink};stroke-opacity:${alpha.toFixed(3)}"`
      + ` vector-effect="non-scaling-stroke"/>`;
  }).join('');
  return `<svg class="weave-still" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`;
}

/** The layer the hero opens with: the still, and the canvas the script may
 *  wake. The thread parameters ride along as data, so the canvas draws the
 *  same field the still shows. */
export function weaveLayer(field: WeaveField = FIELD): string {
  const data = JSON.stringify({ threads: field.threads, sheen: field.sheen });
  return `<div class="weave" id="hero-weave" aria-hidden="true" data-field='${data}'>`
    + `${weaveStill(field)}<canvas class="weave-live"></canvas></div>`;
}

/**
 * Wake the warp.
 *
 * Reads the field from the layer's data attribute, resolves the two tokens it
 * mixes ink from ONCE, and then the frame loop touches nothing but its own
 * canvas: no reads, no writes, no allocation beyond the first frame. Paced to
 * 30 fps — silk does not need 120 — and parked whenever the tab is hidden or
 * the hero is out of view, so a reader below the fold pays nothing.
 *
 * Three refusals, each leaving the designed still on screen: reduced motion,
 * no canvas, an unparsable field. `data-live` appears only once the first
 * frame has drawn, which is what the browser gate and the screenshot pass key
 * on; worst frame cost is kept on `window.__kinuWeave` for the gate to read.
 */
export const WEAVE_SCRIPT = `
const weave = document.getElementById('hero-weave');
if (weave && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const canvas = weave.querySelector('canvas');
  const context = canvas.getContext('2d');
  const field = JSON.parse(weave.dataset.field || 'null');
  if (context && field) {
    const meter = { frames: 0, maxFrameMs: 0 };
    window.__kinuWeave = meter;
    const styles = getComputedStyle(document.documentElement);
    const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16);
    const ink = (name) => {
      const raw = styles.getPropertyValue(name).trim();
      return /^#[0-9a-f]{6}$/i.test(raw) ? [channel(raw, 1), channel(raw, 3), channel(raw, 5)] : null;
    };
    const accent = ink('--c-accent');
    const faint = ink('--c-text-3');
    if (accent && faint) {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      let width = 0;
      let height = 0;
      const size = () => {
        const box = weave.getBoundingClientRect();
        width = Math.max(1, Math.round(box.width));
        height = Math.max(1, Math.round(box.height));
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      size();
      new ResizeObserver(size).observe(weave);
      const strokes = field.threads.map((thread) => {
        const t = thread.tone;
        const mix = (i) => Math.round(accent[i] * t + faint[i] * (1 - t));
        return 'rgba(' + mix(0) + ',' + mix(1) + ',' + mix(2) + ',';
      });
      const lift = (y, centre) => {
        const d = Math.abs(y - centre) / ${SHEEN_WIDTH};
        return d >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * d));
      };
      const SEGMENTS = 44;
      const draw = (t) => {
        const began = performance.now();
        context.clearRect(0, 0, width, height);
        // The sheen wanders around its resting point, never off the cloth.
        const centre = field.sheen + 0.16 * Math.sin(t * 0.05) + 0.05 * Math.sin(t * 0.013);
        for (let i = 0; i < field.threads.length; i++) {
          const thread = field.threads[i];
          const alpha = thread.alpha + ${SHEEN_ALPHA} * lift(thread.y, centre);
          context.strokeStyle = strokes[i] + alpha.toFixed(3) + ')';
          context.lineWidth = thread.weight;
          context.beginPath();
          for (let s = 0; s <= SEGMENTS; s++) {
            const x = s / SEGMENTS;
            const y = thread.y
              + thread.amp1 * Math.sin(6.2832 * thread.k1 * x - thread.w1 * t + thread.p1)
              + thread.amp2 * Math.sin(6.2832 * thread.k2 * x + thread.w2 * t + thread.p2);
            if (s === 0) context.moveTo(0, y * height);
            else context.lineTo(x * width, y * height);
          }
          context.stroke();
        }
        meter.frames += 1;
        const cost = performance.now() - began;
        if (cost > meter.maxFrameMs) meter.maxFrameMs = cost;
      };
      let running = false;
      let last = 0;
      const step = (now) => {
        if (!running) return;
        if (now - last >= 33) { last = now; draw(now / 1000); }
        requestAnimationFrame(step);
      };
      let visible = true;
      const settle = () => {
        const should = visible && document.visibilityState === 'visible';
        if (should === running) return;
        running = should;
        if (running) requestAnimationFrame(step);
      };
      document.addEventListener('visibilitychange', settle);
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
        settle();
      }).observe(weave);
      draw(performance.now() / 1000);
      weave.setAttribute('data-live', '');
      settle();
    }
  }
}`;
