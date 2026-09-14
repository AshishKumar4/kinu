import { useEffect, useRef, type ReactElement } from 'react';

import {
  cssRgba, NODE_STRIDE, SearchTree, STROKE_STRIDE, TONE_ASH, TONE_BRIGHT, TONE_EMBER,
  type HeroPalette, type Rgb, type SearchTreeRenderer,
} from '@kinu.run/core/web/hero-art';
import { boxOf, createPlayback, readPalette, type Box, type FrameTimes } from './stage';

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

const SEED = 417;

/** The search a reduced-motion visitor sees: this far in, evolved once, still. */
const STATIC_SECONDS = 14;

const STATIC_STEP = 1 / 30;

/** After this much simulated time the first wave has grown, scored, and pruned. */
const SETTLED_AT = 5;

/** What a gate can read off the live hero: which renderer took the canvas,
 *  and the last frames' cost. `work` is the milliseconds one tick spent in
 *  the simulation and the renderer's encode; `interval` is the wall time
 *  between consecutive ticks. */
export interface SearchTreeHandle {
  renderer(): 'webgpu' | 'canvas' | 'static' | 'pending';
  frameTimes(): FrameTimes;
  time(): number;
}

declare global {
  interface Window {
    __kinuSearchTree?: SearchTreeHandle;
  }
}

/** Two frames after the call: the page's first paint has happened by then,
 *  which is when the WebGPU chunk may start downloading. */
function afterFirstPaint(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));

  return promise;
}

function canvasRenderer(canvas: HTMLCanvasElement, palette: HeroPalette): SearchTreeRenderer {
  const context = canvas.getContext('2d');

  if (context === null) throw new Error('the hero canvas has no 2d context');

  return createCanvasRenderer(context, palette);
}

/**
 * WebGPU when the browser has an adapter, Canvas2D otherwise. The probe runs
 * before any download: a browser with `navigator.gpu` and no adapter (Linux
 * Chrome without flags, most headless runs) never fetches the chunk. vgpu's
 * own unsupported verdict is the second gate, after the chunk is here.
 */
async function pickRenderer(canvas: HTMLCanvasElement, palette: HeroPalette, box: Box): Promise<SearchTreeRenderer> {
  if (!('gpu' in navigator)) return canvasRenderer(canvas, palette);
  const adapter = await navigator.gpu.requestAdapter();

  if (adapter === null) return canvasRenderer(canvas, palette);
  await afterFirstPaint();
  // A dynamic import on purpose: the module carries vgpu, a lazy chunk that
  // only a browser with an adapter should ever download.
  const { createWebGpuRenderer } = await import('./renderer-webgpu');
  const outcome = await createWebGpuRenderer(canvas, palette, box.width, box.height, box.ratio);

  return outcome.kind === 'renderer' ? outcome.renderer : canvasRenderer(canvas, palette);
}

function mountSearchTree(host: HTMLElement, stage: HTMLElement): () => void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false;
  let palette = readPalette();
  let tree = new SearchTree({ seed: SEED, aspect: 1 });
  let renderer: SearchTreeRenderer | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let still = reduced.matches;
  let pressX = 0;
  let pressY = 0;
  let pressed = false;

  const playback = createPlayback(host, () => !still && renderer !== null, (step) => {
    if (renderer === null) return;
    tree.step(step);
    const frame = tree.frame();
    renderer.render(frame);
    facts(frame);
  });

  const teardownRenderer = (): void => {
    playback.stop();
    renderer?.dispose();
    renderer = null;
    canvas?.remove();
    canvas = null;
  };

  const facts = (frame: { readonly pruned: number; readonly hidden: number; readonly generation: number; readonly time: number }): void => {
    if (canvas === null) return;
    const pruned = String(frame.pruned);
    const hidden = String(frame.hidden);
    const generation = String(frame.generation);

    if (canvas.dataset.pruned !== pruned) canvas.dataset.pruned = pruned;

    if (canvas.dataset.hidden !== hidden) canvas.dataset.hidden = hidden;

    if (canvas.dataset.generation !== generation) canvas.dataset.generation = generation;

    if (frame.time >= SETTLED_AT && canvas.dataset.settled !== 'true') canvas.dataset.settled = 'true';
  };

  const fit = (): void => {
    if (renderer === null || canvas === null) return;
    const box = boxOf(host);

    if (renderer.kind === 'canvas') {
      canvas.width = Math.round(box.width * box.ratio);
      canvas.height = Math.round(box.height * box.ratio);
    }

    renderer.resize(box.width, box.height, box.ratio);
    tree.setAspect(box.height / box.width);
  };

  /** One evolved frame, no clock: the still a reduced-motion visitor gets. */
  const paintStill = (): void => {
    if (renderer === null) return;
    const box = boxOf(host);
    const frozen = new SearchTree({ seed: SEED, aspect: box.height / box.width });
    const steps = Math.round(STATIC_SECONDS / STATIC_STEP);

    for (let index = 0; index < steps; index += 1) frozen.step(STATIC_STEP);
    const frame = frozen.frame();
    renderer.render(frame);
    facts({ ...frame, time: SETTLED_AT });
  };

  const startFailed = <Thrown,>(cause: Thrown): never => {
    throw new Error('the hero renderer did not start', { cause });
  };

  const start = (): void => {
    teardownRenderer();
    const next = document.createElement('canvas');
    next.className = 'absolute inset-0 size-full';
    host.appendChild(next);
    canvas = next;
    const box = boxOf(host);
    tree = new SearchTree({ seed: SEED, aspect: box.height / box.width });

    if (still) {
      renderer = canvasRenderer(next, palette);
      next.dataset.renderer = 'static';
      fit();
      paintStill();

      return;
    }

    pickRenderer(next, palette, box).then((picked) => {
      if (disposed || canvas !== next) {
        picked.dispose();

        return;
      }

      renderer = picked;
      next.dataset.renderer = picked.kind;
      fit();
      playback.sync();
    }).catch(startFailed);
  };

  const onPointerMove = (event: PointerEvent): void => {
    const rect = host.getBoundingClientRect();
    tree.setPointer((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  };

  const onPointerLeave = (): void => tree.clearPointer();

  const onPointerDown = (event: PointerEvent): void => {
    pressed = true;
    pressX = event.clientX;
    pressY = event.clientY;
  };

  const onPointerUp = (event: PointerEvent): void => {
    const wasPressed = pressed;
    pressed = false;

    if (event.pointerType === 'touch') tree.clearPointer();

    if (!wasPressed || Math.hypot(event.clientX - pressX, event.clientY - pressY) > 6) return;

    if (event.target instanceof Element && event.target.closest('a, button, input, textarea, select, [role="button"]') !== null) return;
    const rect = host.getBoundingClientRect();
    tree.plant((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
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

  const handle: SearchTreeHandle = {
    renderer: () => (renderer === null ? 'pending' : still ? 'static' : renderer.kind),
    frameTimes: () => playback.frameTimes(),
    time: () => tree.time,
  };

  resize.observe(host);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  reduced.addEventListener('change', onMotionPreference);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerleave', onPointerLeave);
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerLeave);
  window.__kinuSearchTree = handle;
  start();

  return () => {
    disposed = true;
    resize.disconnect();
    theme.disconnect();
    reduced.removeEventListener('change', onMotionPreference);
    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerleave', onPointerLeave);
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointerup', onPointerUp);
    stage.removeEventListener('pointercancel', onPointerLeave);
    playback.dispose();
    teardownRenderer();

    if (window.__kinuSearchTree === handle) delete window.__kinuSearchTree;
  };
}

/**
 * The hero's centrepiece: the living search tree, full-bleed behind the copy.
 * The host is a positioned box the mounted canvas fills; a mask keeps the
 * type readable over it. Pointer input is read from the parent stage, so the
 * copy and its links stay clickable while the tree bends to the cursor.
 */
export function SearchTreeHero(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const stage = host?.parentElement ?? null;

    if (host === null || stage === null) return;

    return mountSearchTree(host, stage);
  }, []);

  return (
    <div
      ref={hostRef}
      data-hero-graph
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 -bottom-16 [mask-composite:intersect] [mask-image:linear-gradient(to_right,rgba(0,0,0,.25),rgba(0,0,0,.35)_40%,black_62%),linear-gradient(to_bottom,transparent,black_16%,black_76%,transparent)]"
    />
  );
}
