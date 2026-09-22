/**
 * Frame contract between the art simulations and the Canvas2D/WebGPU renderers.
 * Coordinates are view-normalised (0..1, y down); radii and widths are CSS pixels.
 */

export const STROKE_STRIDE = 12;

/** Seven fields and one pad, so a node is two vec4 attributes on the GPU. */
export const NODE_STRIDE = 8;

/** A pulse is four vec4 attributes: the curve it rides, its span on it, its look, and its identity. */
export const PULSE_STRIDE = 16;

/** Tones resolved through the palette: accent, kept-path gold, ash, cooling ember. */
export const TONE_ACCENT = 0;

export const TONE_BRIGHT = 1;

export const TONE_ASH = 2;

export const TONE_EMBER = 3;

/** Fraction every colour recedes toward the page ground before drawing (CPU and GPU alike). */
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

/** Distance in view widths; `aspect` scales y so lengths match in both directions. */
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
   *  The pulse spans the edge's quadratic from `tail` to `head` (either may be larger), bright at the head. */
  readonly pulses: Float32Array<ArrayBuffer>;
  readonly pulseCount: number;
  readonly time: number;
}

export function grown(buffer: Float32Array<ArrayBuffer>, needed: number): Float32Array<ArrayBuffer> {
  if (needed <= buffer.length) return buffer;
  const wider = new Float32Array(new ArrayBuffer(buffer.byteLength * 2));
  wider.set(buffer);

  return grown(wider, needed);
}

/** A box in view units the art keeps out of, so no stroke sits behind copy. */
export interface KeepOut {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type Rgb = readonly [red: number, green: number, blue: number];

/** Theme tokens read from the document; no colour is invented here. */
export interface ArtPalette {
  readonly mode: 'dark' | 'light';
  readonly accent: Rgb;
  readonly bright: Rgb;
  readonly ash: Rgb;
  readonly ground: Rgb;
}

export function cssRgba(rgb: Rgb, alpha: number): string {
  const [red, green, blue] = rgb;

  return `rgba(${String(Math.round(red))},${String(Math.round(green))},${String(Math.round(blue))},${String(alpha)})`;
}

export interface ArtRenderer {
  readonly kind: 'canvas' | 'webgpu';
  resize(width: number, height: number, ratio: number): void;
  setPalette(palette: ArtPalette): void;
  render(frame: ArtFrame): void;
  /** Only renderers that can fail after start (GPU) implement this; an earlier fault replays at subscribe,
   *  after the renderer has already disposed itself. */
  onFault?(handler: (error: Error) => void): void;
  dispose(): void;
}
