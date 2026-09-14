/**
 * The Canvas2D half of the hero art: the search tree's 2D renderer and the
 * phone's dust, both drawing the frames web/hero-art simulates. Nothing in
 * here mounts, observes, or runs a clock — a component supplies the canvas,
 * the palette, and the cadence; a recording stub supplies the same surface
 * in tests, which is how the renderers are proved against the frame.
 */

import {
  cssRgba, NODE_STRIDE, seededRandom, STROKE_STRIDE, TONE_ASH, TONE_BRIGHT, TONE_EMBER,
  type HeroPalette, type Rgb, type SearchTreeRenderer,
} from './hero-art';

/**
 * The slice of CanvasRenderingContext2D this renderer draws with. A real
 * context satisfies it; so does a recording stub in a test, which is how the
 * two renderers are proved to read one frame the same way.
 */
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
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

/** The same tone rule the WGSL palette module applies: an ordinary attempt
 *  is cooler the weaker it scores, the kept path is the gold (deepened to
 *  the text-grade gold on paper), ash is ash, an ember is a cooling gold. */
function toneColor(palette: HeroPalette, tone: number, glow: number): Rgb {
  if (tone === TONE_BRIGHT) return palette.mode === 'light' ? palette.bright : palette.accent;

  if (tone === TONE_ASH) return palette.ash;

  if (tone === TONE_EMBER) return mix(palette.accent, palette.ash, 0.35);

  // Tone 0, an ordinary attempt.
  return mix(palette.ash, palette.accent, 0.35 + 0.65 * glow);
}

/**
 * Canvas2D drawing of the search tree: the same frame the WebGPU renderer
 * draws, without a bloom pass. Bright strokes get one wide faint underlay so
 * the best path still reads as lit, which costs a second stroke only for the
 * few strokes that earn it.
 */
export function createCanvasRenderer(context: StrokeSurface, initialPalette: HeroPalette): SearchTreeRenderer {
  let palette = initialPalette;
  let width = 1;
  let height = 1;
  let ratio = 1;

  const curve = (strokes: Float32Array, at: number): void => {
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
    context.beginPath();
    context.moveTo(x0, y0);
    context.quadraticCurveTo(qx, qy, qx + (rx - qx) * t, qy + (ry - qy) * t);
  };

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
      context.lineCap = 'round';
      context.globalAlpha = 1;
      const { strokes, nodes } = frame;

      for (let index = 0; index < frame.count; index += 1) {
        const at = index * STROKE_STRIDE;
        const glow = strokes[at + 8] ?? 0;
        const tone = strokes[at + 9] ?? 0;
        const alpha = strokes[at + 10] ?? 0;
        const lineWidth = strokes[at + 7] ?? 1;

        if (alpha <= 0.004) continue;
        const color = toneColor(palette, tone, glow);

        if (glow > 0.55) {
          curve(strokes, at);
          context.lineWidth = lineWidth * 3.2;
          context.strokeStyle = cssRgba(color, alpha * 0.14 * glow);
          context.stroke();
        }

        curve(strokes, at);
        context.lineWidth = lineWidth;
        context.strokeStyle = cssRgba(color, alpha * (0.6 + 0.4 * glow));
        context.stroke();
      }

      for (let index = 0; index < frame.nodeCount; index += 1) {
        const at = index * NODE_STRIDE;
        const x = (nodes[at] ?? 0) * width;
        const y = (nodes[at + 1] ?? 0) * height;
        const radius = nodes[at + 2] ?? 1;
        const glow = nodes[at + 3] ?? 0;
        const tone = nodes[at + 4] ?? 0;
        const alpha = nodes[at + 5] ?? 0;

        if (alpha <= 0.004) continue;
        const color = mix(toneColor(palette, tone, glow), palette.bright, glow * 0.6);

        if (glow > 0.5) {
          context.beginPath();
          context.arc(x, y, radius * 2.6, 0, Math.PI * 2);
          context.fillStyle = cssRgba(color, alpha * 0.16 * glow);
          context.fill();
        }

        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = cssRgba(color, alpha);
        context.fill();
      }
    },
    dispose() {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width * ratio, height * ratio);
    },
  };
}

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
