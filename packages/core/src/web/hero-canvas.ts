/** Canvas2D renderers for the living art (non-GPU `ArtFrame` pictures and the phone's dust); no mounting, observing, or clocks. */

import {
  type ArtFrame, type ArtPalette, type ArtRenderer, cssRgba, DEFAULT_LIFT, NODE_STRIDE, PULSE_STRIDE, RECESS, type Rgb, STROKE_STRIDE,
  TONE_ASH, TONE_BRIGHT, TONE_EMBER,
} from './art';
import { seededRandom } from '../utils/stats';

/** The CanvasRenderingContext2D slice this renderer uses; tests satisfy it with a recording stub. */
export interface StrokeSurface {
  lineWidth: number;
  lineCap: CanvasLineCap;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  stroke(): void;
  fill(): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

/** Same tone rule as the WGSL palette module. */
function toneColor(palette: ArtPalette, tone: number, glow: number): Rgb {
  if (tone === TONE_BRIGHT) return palette.mode === 'light' ? palette.bright : palette.accent;

  if (tone === TONE_ASH) return palette.ash;

  if (tone === TONE_EMBER) return mix(palette.accent, palette.ash, 0.35);

  if (palette.mode === 'light') return mix(palette.ash, palette.bright, 0.35 + 0.65 * glow);

  return mix(palette.ash, palette.accent, 0.35 + 0.65 * glow);
}

/** Every tree colour recedes toward the ground by RECESS. */
function recede(palette: ArtPalette, color: Rgb): Rgb {
  return mix(color, palette.ground, RECESS);
}

/** Canvas2D drawing of the same `ArtFrame` as the WebGPU renderer, without bloom; bright strokes get one faint underlay. */
/** Teardown: reset the transform and wipe the whole device-pixel canvas. */
function clearSurface(
  surface: Pick<DustSurface, 'setTransform' | 'clearRect'>,
  size: { width: number; height: number; ratio: number },
): void {
  surface.setTransform(1, 0, 0, 1, 0, 0);
  surface.clearRect(0, 0, size.width * size.ratio, size.height * size.ratio);
}

/** A second surface of the canvas's size, where a frame's resting strokes are kept between the frames that change them. */
export interface KeptLayer {
  readonly surface: StrokeSurface;
  /** Device pixels; 0 by 0 lets the bitmap go. */
  resize(width: number, height: number): void;
  /** Draws the kept surface onto the canvas at the identity transform. */
  stamp(): void;
}

export function createCanvasRenderer(context: StrokeSurface, initialPalette: ArtPalette, kept?: KeptLayer): ArtRenderer {
  let palette = initialPalette;
  let width = 1;
  let height = 1;
  let ratio = 1;
  /** The rest epoch on the kept layer; null when it holds nothing current. */
  let keptEpoch: number | null = null;
  /** The lift the kept layer was drawn with; a frame that asks for another redraws it. */
  let lift = DEFAULT_LIFT;

  /** Strokes sharing an ink, an alpha and a width, and discs sharing an ink and an alpha; emptied each frame and dropped
   *  once a frame leaves one empty. */
  const batches = new Map<number, { readonly style: string; readonly width: number; readonly at: number[] }>();
  const spots = new Map<number, { readonly style: string; readonly width: number; readonly at: number[] }>();

  const trace = (target: StrokeSurface, strokes: Float32Array, at: number): void => {
    const x0 = (strokes[at] ?? 0) * width;
    const y0 = (strokes[at + 1] ?? 0) * height;
    const cx = (strokes[at + 2] ?? 0) * width;
    const cy = (strokes[at + 3] ?? 0) * height;
    const x1 = (strokes[at + 4] ?? 0) * width;
    const y1 = (strokes[at + 5] ?? 0) * height;
    const t = strokes[at + 6] ?? 1;
    // De Casteljau: the grown part of the curve is itself a quadratic.
    const qx = x0 + (cx - x0) * t;
    const qy = y0 + (cy - y0) * t;
    const rx = cx + (x1 - cx) * t;
    const ry = cy + (y1 - cy) * t;
    target.moveTo(x0, y0);
    target.quadraticCurveTo(qx, qy, qx + (rx - qx) * t, qy + (ry - qy) * t);
  };

  /** Adds the stroke at `at` to the path of its ink, alpha and width. */
  const join = (color: Rgb, alpha: number, lineWidth: number, at: number): void => {
    const ink = Math.round(Math.min(1, alpha) * 255);
    const quarters = Math.round(lineWidth * 4);
    const key = (((Math.round(color[0]) * 256 + Math.round(color[1])) * 256 + Math.round(color[2])) * 256 + ink) * 4096 + quarters;
    const batch = batches.get(key);

    if (batch === undefined) batches.set(key, { style: cssRgba(color, ink / 255), width: quarters / 4, at: [at] });
    else batch.at.push(at);
  };

  // Each stroke, and a lit one's underlay, joins the path of its ink, alpha and width, at the canvas's own 8-bit alpha and a
  // quarter pixel: a frame strokes, and parses a colour, once per path rather than once per stroke.
  const paintStrokes = (target: StrokeSurface, strokes: Float32Array, from: number, to: number): void => {
    for (const [key, batch] of batches) {
      if (batch.at.length === 0) batches.delete(key);
      else batch.at.length = 0;
    }

    for (let index = from; index < to; index += 1) {
      const at = index * STROKE_STRIDE;
      const glow = strokes[at + 8] ?? 0;
      const tone = strokes[at + 9] ?? 0;
      const alpha = (strokes[at + 10] ?? 0) * lift[palette.mode];
      const lineWidth = strokes[at + 7] ?? 1;

      if (alpha <= 0.004) continue;
      const color = recede(palette, toneColor(palette, tone, glow));

      if (glow > 0.55) join(color, alpha * 0.14 * glow, lineWidth * 3.2, at);
      join(color, alpha * (0.6 + 0.4 * glow), lineWidth, at);
    }

    for (const batch of batches.values()) {
      if (batch.at.length === 0) continue;
      target.beginPath();

      for (const at of batch.at) trace(target, strokes, at);
      target.lineWidth = batch.width;
      target.strokeStyle = batch.style;
      target.stroke();
    }
  };

  // Sub-curve a pulse lights, via the quadratic's blossom; a returning pulse has tail past head.
  const span = (pulses: Float32Array, at: number): readonly [number, number, number, number, number, number] => {
    const x0 = (pulses[at] ?? 0) * width;
    const y0 = (pulses[at + 1] ?? 0) * height;
    const cx = (pulses[at + 2] ?? 0) * width;
    const cy = (pulses[at + 3] ?? 0) * height;
    const x1 = (pulses[at + 4] ?? 0) * width;
    const y1 = (pulses[at + 5] ?? 0) * height;
    const tail = pulses[at + 6] ?? 0;
    const head = pulses[at + 7] ?? 1;

    const point = (t: number): readonly [number, number] => {
      const u = 1 - t;

      return [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1];
    };

    const [qx, qy] = point(tail);
    const [rx, ry] = point(head);
    const ux = (1 - tail) * (1 - head);
    const vx = (1 - tail) * head + tail * (1 - head);
    const wx = tail * head;

    return [qx, qy, ux * x0 + vx * cx + wx * x1, ux * y0 + vx * cy + wx * y1, rx, ry];
  };

  /**
   * Brings the kept layer up to the frame's rest, redrawing it only for a new rest epoch, lift, size or palette, and
   * stamps it; returns the first stroke still to draw. Without a kept layer every stroke is drawn each frame.
   */
  const paintRest = (frame: ArtFrame): number => {
    if ((frame.lift ?? DEFAULT_LIFT) !== lift) {
      lift = frame.lift ?? DEFAULT_LIFT;
      keptEpoch = null;
    }

    const rest = frame.rest;

    if (kept === undefined || rest === undefined) return 0;

    if (rest.epoch !== keptEpoch) {
      kept.resize(Math.round(width * ratio), Math.round(height * ratio));
      kept.surface.setTransform(ratio, 0, 0, ratio, 0, 0);
      kept.surface.clearRect(0, 0, width, height);
      kept.surface.lineCap = 'round';
      paintStrokes(kept.surface, frame.strokes, 0, rest.count);
      keptEpoch = rest.epoch;
    }

    kept.stamp();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    return rest.count;
  };

  /** The frame's discs, one fill per ink and alpha, a lit one over its soft underlay. */
  const paintNodes = (nodes: Float32Array, count: number): void => {
    for (const [key, batch] of spots) {
      if (batch.at.length === 0) spots.delete(key);
      else batch.at.length = 0;
    }

    for (let index = 0; index < count; index += 1) {
      const at = index * NODE_STRIDE;
      const x = (nodes[at] ?? 0) * width;
      const y = (nodes[at + 1] ?? 0) * height;
      const radius = nodes[at + 2] ?? 1;
      const glow = nodes[at + 3] ?? 0;
      const tone = nodes[at + 4] ?? 0;
      const alpha = nodes[at + 5] ?? 0;

      if (alpha <= 0.004) continue;
      const color = recede(palette, mix(toneColor(palette, tone, glow), palette.bright, glow * 0.6));

      if (glow > 0.5) {
        context.beginPath();
        context.arc(x, y, radius * 2.6, 0, Math.PI * 2);
        context.fillStyle = cssRgba(color, alpha * 0.16 * glow);
        context.fill();
      }

      const ink = Math.round(Math.min(1, alpha) * 255);
      const key = ((Math.round(color[0]) * 256 + Math.round(color[1])) * 256 + Math.round(color[2])) * 256 + ink;
      const batch = spots.get(key);

      if (batch === undefined) spots.set(key, { style: cssRgba(color, ink / 255), width: 0, at: [at] });
      else batch.at.push(at);
    }

    // One fill per ink; each disc starts its own subpath, so no edge joins one disc to the next.
    for (const batch of spots.values()) {
      if (batch.at.length === 0) continue;
      context.beginPath();

      for (const at of batch.at) {
        const x = (nodes[at] ?? 0) * width;
        const y = (nodes[at + 1] ?? 0) * height;
        const radius = nodes[at + 2] ?? 1;
        context.moveTo(x + radius, y);
        context.arc(x, y, radius, 0, Math.PI * 2);
      }

      context.fillStyle = batch.style;
      context.fill();
    }
  };

  return {
    kind: 'canvas',
    resize(nextWidth, nextHeight, nextRatio) {
      width = nextWidth;
      height = nextHeight;
      ratio = nextRatio;
      keptEpoch = null;
    },
    setPalette(next) {
      palette = next;
      keptEpoch = null;
    },
    render(frame) {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.lineCap = 'round';
      context.globalAlpha = 1;
      const { strokes, nodes, pulses } = frame;

      const live = paintRest(frame);

      paintStrokes(context, strokes, live, frame.count);

      for (let index = 0; index < frame.pulseCount; index += 1) {
        const at = index * PULSE_STRIDE;
        const lineWidth = pulses[at + 8] ?? 1;
        const glow = pulses[at + 9] ?? 0;
        const tone = pulses[at + 10] ?? 0;
        const alpha = (pulses[at + 11] ?? 0) * lift[palette.mode];

        if (alpha <= 0.004 || (pulses[at + 6] ?? 0) === (pulses[at + 7] ?? 0)) continue;
        const color = recede(palette, mix(toneColor(palette, tone, glow), palette.bright, glow * 0.6));
        const [x0, y0, cx, cy, x1, y1] = span(pulses, at);

        if (glow > 0.55) {
          const halo = context.createLinearGradient(x0, y0, x1, y1);
          halo.addColorStop(0, cssRgba(color, 0));
          halo.addColorStop(1, cssRgba(color, alpha * 0.14 * glow));
          context.beginPath();
          context.moveTo(x0, y0);
          context.quadraticCurveTo(cx, cy, x1, y1);
          context.lineWidth = lineWidth * 3.2;
          context.strokeStyle = halo;
          context.stroke();
        }

        const beam = context.createLinearGradient(x0, y0, x1, y1);
        beam.addColorStop(0, cssRgba(color, 0));
        beam.addColorStop(1, cssRgba(color, alpha));
        context.beginPath();
        context.moveTo(x0, y0);
        context.quadraticCurveTo(cx, cy, x1, y1);
        context.lineWidth = lineWidth;
        context.strokeStyle = beam;
        context.stroke();
      }

      paintNodes(nodes, frame.nodeCount);
    },
    dispose() {
      clearSurface(context, { width, height, ratio });
      kept?.resize(0, 0);
    },
  };
}

/** Phone dust: faint gold motes, deterministic for a given seed and `step(dt)` sequence. No DOM, no drawing. */

/** One mote: x, y in the unit box, radius in CSS px, alpha in 0..1. */
const DUST_STRIDE = 4;

/** Top speed in box widths per second. */
const MAX_DRIFT = 0.015;

/** Core alpha at full twinkle (halo is a tenth); set to keep paragraph text at WCAG AA over the worst mote pixel. */
const CORE_ALPHA: Record<ArtPalette['mode'], number> = { dark: 0.18, light: 0.18 };

const WRAP_MARGIN = 0.02;

const WRAP_SPAN = 1 + 2 * WRAP_MARGIN;

/** Vertical wander in box heights per second; chosen so drift never exceeds MAX_DRIFT and needs no clamp. */
const WANDER = 0.004;

export interface DustOptions {
  readonly seed: number;
  readonly count: number;
}

export interface DustFrame {
  readonly count: number;
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

  /** height / width of the box, so drift is isotropic in pixels. */
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
  setPalette(palette: ArtPalette): void;
  render(frame: DustFrame): void;
  dispose(): void;
}

/** Canvas2D drawing of the dust field: a faint halo under a denser core, in the tree's kept-path gold. */
export function createDustRenderer(context: DustSurface, initialPalette: ArtPalette): DustRenderer {
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
      clearSurface(context, { width, height, ratio });
    },
  };
}
