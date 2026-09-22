/**
 * WebGPU when an adapter exists, Canvas2D otherwise; a GPU fault swaps to Canvas2D on a fresh element,
 * keeping the picture's clock and state. Reduced motion gets one evolved frame and no clock.
 */

import { diagnostics, type LogEventName, renderThrownChain } from '@kinu.run/core/obs';
import type { ArtFrame, ArtPalette, ArtRenderer } from '@kinu.run/core/web/art';
import { createCanvasRenderer } from '@kinu.run/core/web/hero-canvas';
import { boxOf, createPlayback, readPalette, type Box, type FrameTimes } from './stage';

export interface LivingArt<Frame extends ArtFrame = ArtFrame> {
  readonly time: number;
  setAspect(aspect: number): void;
  step(dt: number): void;
  frame(): Frame;
}

/** Canvas2D strokes every curve one by one; the GPU path draws instanced geometry. */
export type RendererKind = 'webgpu' | 'canvas';

export interface LivingCanvasSpec<Frame extends ArtFrame, Art extends LivingArt<Frame>> {
  readonly create: (aspect: number, renderer: RendererKind) => Art;
  /** Absent, the same picture goes on; a picture too dense for Canvas2D hands back a sparser one. */
  readonly rebind?: (art: Art, aspect: number) => Art;
  readonly still: { readonly seconds: number; readonly step: number };
  /** Read on every start. */
  readonly holdStill?: () => boolean;
  /** Only `advance` steps the picture; for measured readbacks that must be a pure function of their steps. */
  readonly startFrozen?: () => boolean;
  /** Under 1 the picture draws soft. */
  readonly resolution: number;
  readonly fit?: (art: Art, host: HTMLElement) => void;
  readonly shown?: (frame: Frame, canvas: HTMLCanvasElement, still: boolean) => void;
  readonly events: { readonly failed: LogEventName; readonly faulted: LogEventName; readonly fallbackFailed: LogEventName };
  readonly canvasClassName: string;
}

/** `work` is ms one tick spent in simulation and encode; `interval` is wall time between ticks. */
export interface LivingCanvas<Frame extends ArtFrame, Art extends LivingArt<Frame>> {
  art(): Art;
  renderer(): 'webgpu' | 'canvas' | 'static' | 'pending';
  frameTimes(): FrameTimes;
  time(): number;
  advance(dt: number): void;
  freeze(): void;
  thaw(): void;
  align(): void;
  dispose(): void;
}

/** Two frames on, the first paint has happened, so the WebGPU chunk may start downloading. */
function afterFirstPaint(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));

  return promise;
}

function canvasRenderer(canvas: HTMLCanvasElement, palette: ArtPalette): ArtRenderer {
  const context = canvas.getContext('2d');

  if (context === null) throw new Error('the art canvas has no 2d context');

  return createCanvasRenderer(context, palette);
}

/** The adapter probe runs before any download, so a browser with `navigator.gpu` but no adapter never fetches the chunk. */
interface RendererChoice {
  readonly canvas: HTMLCanvasElement;
  readonly palette: ArtPalette;
  readonly box: Box;
  readonly resolution: number;
  readonly failed: LogEventName;
}

async function pickRenderer({ canvas, palette, box, resolution, failed }: RendererChoice): Promise<ArtRenderer> {
  if (!('gpu' in navigator)) return canvasRenderer(canvas, palette);
  const adapter = await navigator.gpu.requestAdapter();

  if (adapter === null) return canvasRenderer(canvas, palette);
  await afterFirstPaint();
  // Dynamic import: vgpu is a lazy chunk only a browser with an adapter should download.
  const { createWebGpuRenderer } = await import('./renderer-webgpu');

  const outcome = await createWebGpuRenderer({
    canvas, initialPalette: palette, width: box.width, height: box.height, ratio: box.ratio * resolution,
  });

  if (outcome.kind === 'renderer') return outcome.renderer;

  // The landing has no session for `POST /api/client-errors`, so a failed start goes to the obs sink.
  // 'unsupported' is a browser fact, not a failure.
  if (outcome.kind === 'failed') diagnostics.event(failed, { reason: outcome.reason });

  return canvasRenderer(canvas, palette);
}

export function mountLivingCanvas<Frame extends ArtFrame, Art extends LivingArt<Frame>>(host: HTMLElement, spec: LivingCanvasSpec<Frame, Art>): LivingCanvas<Frame, Art> {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false;
  let palette = readPalette();
  let art = spec.create(1, 'canvas');
  let renderer: ArtRenderer | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let still = false;

  const show = (picture: Art, isStill: boolean): void => {
    if (renderer === null || canvas === null) return;
    const frame = picture.frame();
    renderer.render(frame);
    spec.shown?.(frame, canvas, isStill);
  };

  const playback = createPlayback(host, () => !still && renderer !== null, (step) => {
    art.step(step);
    show(art, false);
  });

  const teardownRenderer = (): void => {
    playback.stop();
    renderer?.dispose();
    renderer = null;
    canvas?.remove();
    canvas = null;
  };

  /** A canvas that gave its context to WebGPU never hands out a 2d one, so the element is replaced. */
  const installCanvas = (): HTMLCanvasElement => {
    canvas?.remove();
    const next = document.createElement('canvas');
    next.className = spec.canvasClassName;
    host.insertBefore(next, host.firstChild);
    canvas = next;

    return next;
  };

  const fit = (): void => {
    if (renderer === null || canvas === null) return;
    const box = boxOf(host);
    const ratio = box.ratio * spec.resolution;

    if (renderer.kind === 'canvas') {
      canvas.width = Math.round(box.width * ratio);
      canvas.height = Math.round(box.height * ratio);
    }

    renderer.resize(box.width, box.height, ratio);
    art.setAspect(box.height / box.width);
    spec.fit?.(art, host);
  };

  const paintStill = (): void => {
    if (renderer === null) return;
    const box = boxOf(host);
    const frozen = spec.create(box.height / box.width, 'canvas');
    spec.fit?.(frozen, host);
    const steps = Math.round(spec.still.seconds / spec.still.step);

    for (let index = 0; index < steps; index += 1) frozen.step(spec.still.step);
    show(frozen, true);
  };

  /** The WebGPU renderer has already disposed itself; only the drawing rebinds, the simulation keeps its state. */
  const onGpuFault = (error: Error): void => {
    if (renderer?.kind !== 'webgpu') return;

    try {
      const next = installCanvas();
      const fallback = canvasRenderer(next, palette);
      renderer = fallback;
      next.dataset.renderer = fallback.kind;
      const box = boxOf(host);

      if (spec.rebind !== undefined) art = spec.rebind(art, box.height / box.width);
      fit();
      playback.sync();
      diagnostics.event(spec.events.faulted, { reason: renderThrownChain({ cause: error }) });
    } catch (swap) {
      diagnostics.event(spec.events.fallbackFailed, {
        fault: renderThrownChain({ cause: error }),
        reason: renderThrownChain({ cause: swap }),
      });
    }
  };

  const startFailed = (...rejection: [unknown]): never => {
    throw new Error('the art renderer did not start', { cause: rejection[0] });
  };

  /** The picture may be sized to the renderer, so it is made once the renderer is known. */
  const start = (): void => {
    teardownRenderer();
    still = reduced.matches || spec.holdStill?.() === true;
    const next = installCanvas();
    const box = boxOf(host);

    if (still) {
      art = spec.create(box.height / box.width, 'canvas');
      spec.fit?.(art, host);
      renderer = canvasRenderer(next, palette);
      next.dataset.renderer = 'static';
      fit();
      paintStill();

      return;
    }

    pickRenderer({ canvas: next, palette, box, resolution: spec.resolution, failed: spec.events.failed }).then((picked) => {
      if (disposed || canvas !== next) {
        picked.dispose();

        return;
      }

      art = spec.create(box.height / box.width, picked.kind);
      renderer = picked;
      next.dataset.renderer = picked.kind;
      picked.onFault?.(onGpuFault);
      fit();

      if (spec.startFrozen?.() === true) {
        show(art, false);

        return;
      }

      playback.sync();
    }).catch(startFailed);
  };

  const onTheme = (): void => {
    palette = readPalette();
    renderer?.setPalette(palette);

    if (still) paintStill();
  };

  const refit = (): void => {
    fit();

    if (still) paintStill();
  };

  const align = (): void => {
    spec.fit?.(art, host);

    if (still) paintStill();
  };

  const resize = new ResizeObserver(refit);
  const theme = new MutationObserver(onTheme);
  resize.observe(host);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  reduced.addEventListener('change', start);
  start();

  return {
    art: () => art,
    renderer: () => {
      if (renderer === null) return 'pending';

      return still ? 'static' : renderer.kind;
    },
    frameTimes: () => playback.frameTimes(),
    time: () => art.time,
    freeze: () => {
      playback.stop();
    },
    thaw: () => {
      playback.sync();
    },
    advance: (dt: number) => {
      art.step(dt);
      show(art, still);
    },
    align,
    dispose() {
      disposed = true;
      resize.disconnect();
      theme.disconnect();
      reduced.removeEventListener('change', start);
      playback.dispose();
      teardownRenderer();
    },
  };
}
