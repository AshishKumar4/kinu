import { useEffect, useRef, type ReactElement } from 'react';

import { diagnostics, renderThrownChain } from '@kinu.run/core/obs';
import { createCanvasRenderer } from '@kinu.run/core/web/hero-canvas';
import { SearchTree, type HeroPalette, type SearchTreeRenderer } from '@kinu.run/core/web/hero-art';
import { boxOf, createPlayback, readPalette, type Box, type FrameTimes } from './stage';

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

  if (outcome.kind === 'renderer') return outcome.renderer;

  // The landing has no client-error route — `POST /api/client-errors` asks for
  // a session the public page by definition lacks — so a failed start is said
  // here, through the obs sink, with the reason the outcome carried.
  // 'unsupported' is a browser fact, not a failure, and stays quiet.
  if (outcome.kind === 'failed') {
    diagnostics.event('landing.hero_webgpu_failed', { reason: outcome.reason });
  }

  return canvasRenderer(canvas, palette);
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

  /** A fresh canvas under the host; the element itself goes because a canvas
   *  that gave its context to WebGPU never hands a 2d one out again. */
  const installCanvas = (): HTMLCanvasElement => {
    canvas?.remove();
    const next = document.createElement('canvas');
    next.className = 'absolute inset-0 size-full';
    host.appendChild(next);
    canvas = next;

    return next;
  };

  /**
   * A live GPU fault: the WebGPU renderer has already disposed itself, so the
   * mount's half is the swap — a fresh element, Canvas2D, the same tree. The
   * simulation keeps its clock and its frontier; only the drawing rebinds.
   */
  const onGpuFault = (error: Error): void => {
    if (renderer?.kind !== 'webgpu') return;

    try {
      const next = installCanvas();
      const fallback = canvasRenderer(next, palette);
      renderer = fallback;
      next.dataset.renderer = fallback.kind;
      fit();
      playback.sync();
      diagnostics.event('landing.hero_webgpu_faulted', { reason: renderThrownChain({ cause: error }) });
    } catch (swap) {
      diagnostics.event('landing.hero_fallback_failed', {
        fault: renderThrownChain({ cause: error }),
        reason: renderThrownChain({ cause: swap }),
      });
    }
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
    const next = installCanvas();
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
      picked.onFault?.(onGpuFault);
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
