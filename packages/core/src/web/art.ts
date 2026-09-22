/**
 * The contract between a living picture and the renderers that draw it.
 *
 * Two simulations draw through it: the landing hero's search tree
 * (`hero-art.ts`) and the signed-in shell's connectome (`connectome.ts`).
 * Each emits an `ArtFrame` — strokes, points and pulses as flat float
 * arrays at the strides below — and the same two renderers (Canvas2D in
 * `hero-canvas.ts`, WebGPU in the cf-backend's `renderer-webgpu.ts`) draw
 * whichever frame they are handed. Neither knows which picture it came from.
 *
 * Coordinates are view-normalised: x and y run 0..1 across the drawn box,
 * x left to right, y top to bottom. Radii and widths are CSS pixels.
 */

export const STROKE_STRIDE = 12;

/** Seven fields and one pad, so a node is two vec4 attributes on the GPU. */
export const NODE_STRIDE = 8;

/** A pulse is four vec4 attributes: the curve it rides, its span on it, its look, and its identity. */
export const PULSE_STRIDE = 16;

/** The tones a renderer resolves through the palette: an ordinary stroke,
 *  cooler the weaker its glow; the kept path's gold; ash; a cooling ember. */
export const TONE_ACCENT = 0;

export const TONE_BRIGHT = 1;

export const TONE_ASH = 2;

export const TONE_EMBER = 3;

/** Every colour recedes this far toward the page's ground before it is
 *  drawn, on the GPU and on the CPU alike: the art sits behind the copy.
 *  Measured 2026-09-14 on the dark ground: the kept path's gold reads 8.9:1
 *  against the ground unmixed and 4.6:1 at this mix. */
export const RECESS = 0.32;

/** mulberry32: small, fast, and identical on every engine. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;

  if (value > high) return high;

  return value;
}

/** Two view points and the aspect (height over width) that scales y. */
export interface ViewSpan {
  readonly aspect: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The distance between two view points in view widths: `aspect` scales y so a
 *  length reads the same in both directions. */
export function viewDistance(span: ViewSpan): number {
  const dx = span.x1 - span.x0;
  const dy = (span.y1 - span.y0) * span.aspect;

  return Math.sqrt(dx * dx + dy * dy);
}

export interface ArtFrame {
  /** `count` strokes of STROKE_STRIDE floats: x0 y0 cx cy x1 y1 t width glow tone alpha layer. */
  readonly strokes: Float32Array<ArrayBuffer>;
  readonly count: number;
  /** `nodeCount` points of NODE_STRIDE floats: x y radius glow tone alpha layer pad. */
  readonly nodes: Float32Array<ArrayBuffer>;
  readonly nodeCount: number;
  /** `pulseCount` pulses of PULSE_STRIDE floats: x0 y0 cx cy | x1 y1 tail head | width glow tone alpha | id layer direction pad.
   *  The curve is the edge's whole quadratic in view units; the pulse occupies
   *  it from `tail` to `head` (either may be the larger), bright at the head. */
  readonly pulses: Float32Array<ArrayBuffer>;
  readonly pulseCount: number;
  readonly time: number;
}

/** A float buffer that doubles when a write would pass its end. */
export function grown(buffer: Float32Array<ArrayBuffer>, needed: number): Float32Array<ArrayBuffer> {
  if (needed <= buffer.length) return buffer;
  const wider = new Float32Array(new ArrayBuffer(buffer.byteLength * 2));
  wider.set(buffer);

  return grown(wider, needed);
}

/** A box in view units a picture keeps out of: the copy's, so no stroke
 *  sits behind text. The tree turns its growth away from one; the
 *  connectome fades whatever of its tissue lies under any of many. */
export interface KeepOut {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type Rgb = readonly [red: number, green: number, blue: number];

/** The theme's own tokens, read from the document: accent is the gold,
 *  bright is `--c-accent-fg` (silk on dark, deep gold on paper), ash is the
 *  dim text role a pruned branch fades into, ground is the page behind the
 *  art, which every tone recedes toward by RECESS. No colour is invented here. */
export interface ArtPalette {
  readonly mode: 'dark' | 'light';
  readonly accent: Rgb;
  readonly bright: Rgb;
  readonly ash: Rgb;
  readonly ground: Rgb;
}

/** The CSS colour string a Canvas2D fill or stroke takes. */
export function cssRgba(rgb: Rgb, alpha: number): string {
  const [red, green, blue] = rgb;

  return `rgba(${String(Math.round(red))},${String(Math.round(green))},${String(Math.round(blue))},${String(alpha)})`;
}

/** What a mount asks of whichever renderer it picked: both draw the same
 *  `ArtFrame`, and neither knows how the frame came to be. */
export interface ArtRenderer {
  readonly kind: 'canvas' | 'webgpu';
  /** CSS pixel size of the box and the device pixel ratio to draw at. */
  resize(width: number, height: number, ratio: number): void;
  setPalette(palette: ArtPalette): void;
  render(frame: ArtFrame): void;
  /** A renderer that can die after it has started — the GPU half — takes one
   *  fault handler; a fault that landed before the call replays at subscribe.
   *  The renderer has already disposed itself by then. A renderer that cannot
   *  fault leaves this absent. */
  onFault?(handler: (error: Error) => void): void;
  dispose(): void;
}
