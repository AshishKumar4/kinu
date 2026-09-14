// Browser-only landing art with no backend consumer: it compiles anywhere, so `gate:capability-parity` lists it as movable by name.
import { NODE_STRIDE, STROKE_STRIDE, TONE_ASH, TONE_BRIGHT, TONE_EMBER } from './simulation';
import { cssRgba, type HeroPalette, type Rgb, type SearchTreeRenderer } from './renderer';

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
