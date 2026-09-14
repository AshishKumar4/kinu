import type { SearchTreeFrame } from './simulation';

export type Rgb = readonly [red: number, green: number, blue: number];

/** The theme's own tokens, read from the document: accent is the gold,
 *  bright is `--c-accent-fg` (silk on dark, deep gold on paper), ash is the
 *  dim text role a pruned branch fades into. No colour is invented here. */
export interface HeroPalette {
  readonly mode: 'dark' | 'light';
  readonly accent: Rgb;
  readonly bright: Rgb;
  readonly ash: Rgb;
}

/** The CSS colour string a Canvas2D fill or stroke takes. */
export function cssRgba(rgb: Rgb, alpha: number): string {
  const [red, green, blue] = rgb;

  return `rgba(${String(Math.round(red))},${String(Math.round(green))},${String(Math.round(blue))},${String(alpha)})`;
}

/** What the hero asks of whichever renderer it picked: both draw the same
 *  `SearchTreeFrame`, and neither knows how the frame came to be. */
export interface SearchTreeRenderer {
  readonly kind: 'canvas' | 'webgpu';
  /** CSS pixel size of the box and the device pixel ratio to draw at. */
  resize(width: number, height: number, ratio: number): void;
  setPalette(palette: HeroPalette): void;
  render(frame: SearchTreeFrame): void;
  dispose(): void;
}
