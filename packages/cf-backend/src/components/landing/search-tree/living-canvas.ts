/**
 * A canvas that keeps a living picture on screen: the landing hero's search
 * tree and the signed-in shell's connectome both mount through here, so the
 * renderer choice, the fallback and the reduced-motion rule are written once.
 *
 * WebGPU when the browser has an adapter, Canvas2D otherwise; a GPU fault
 * after the start swaps to Canvas2D on a fresh element with the same picture,
 * so the clock and everything the picture has grown survive the swap. A
 * visitor who asked for less motion, or a host that asks to hold still, gets
 * one evolved frame and no clock. The theme's palette is read off the
 * document and followed live; the box is followed through a ResizeObserver.
 */

import { diagnostics, type LogEventName, renderThrownChain } from '@kinu.run/core/obs';
import type { ArtFrame, ArtPalette, ArtRenderer } from '@kinu.run/core/web/art';
import { createCanvasRenderer } from '@kinu.run/core/web/hero-canvas';
import { boxOf, createPlayback, readPalette, type Box, type FrameTimes } from './stage';

/** What a picture is to its canvas: a clock it steps and a frame it reads. */
export interface LivingArt<Frame extends ArtFrame = ArtFrame> {
  readonly time: number;
  setAspect(aspect: number): void;
  step(dt: number): void;
  frame(): Frame;
}

/** Which renderer a picture is being made for: the GPU half draws any
 *  amount of instanced geometry; Canvas2D strokes every curve one by one,
 *  and a still is one Canvas2D frame. */
export type RendererKind = 'webgpu' | 'canvas';

export interface LivingCanvasSpec<Frame extends ArtFrame, Art extends LivingArt<Frame>> {
  /** A fresh picture for a box of this aspect (height over width), for the renderer named. */
  readonly create: (aspect: number, renderer: RendererKind) => Art;
  /** The GPU half died under a live picture and Canvas2D took over: the
   *  picture to go on with. Absent, the same picture goes on, clock and all;
   *  a picture too dense for Canvas2D hands back a sparser one. */
  readonly rebind?: (art: Art, aspect: number) => Art;
  /** The still a visitor without motion sees: a fresh picture run this far, in steps this long. */
  readonly still: { readonly seconds: number; readonly step: number };
  /** Hold still whatever the motion preference says — a phone, say. Read on every start. */
  readonly holdStill?: () => boolean;
  /** Physical pixels per CSS pixel as a share of the device's own; under 1 the picture draws soft. */
  readonly resolution: number;
  /** The box changed, or the picture is new: what it must know about the host. */
  readonly fit?: (art: Art, host: HTMLElement) => void;
  /** After every frame the canvas showed, live or still: the picture's own frame type. */
  readonly shown?: (frame: Frame, canvas: HTMLCanvasElement, still: boolean) => void;
  /** The diagnostics event names for the GPU half giving out: a start that
   *  failed, a device lost mid-run, and a swap to Canvas2D that failed too. */
  readonly events: { readonly failed: LogEventName; readonly faulted: LogEventName; readonly fallbackFailed: LogEventName };
  readonly canvasClassName: string;
}

/** What a gate can read off a living canvas: which renderer took it, the
 *  last frames' cost, the picture's clock. `work` is the milliseconds one
 *  tick spent in the simulation and the renderer's encode; `interval` is
 *  the wall time between consecutive ticks. */
export interface LivingCanvas<Frame extends ArtFrame, Art extends LivingArt<Frame>> {
  /** The picture on screen now; a fresh one after every restart. */
  art(): Art;
  renderer(): 'webgpu' | 'canvas' | 'static' | 'pending';
  frameTimes(): FrameTimes;
  time(): number;
  /** Step the picture by `dt` on its own clock, off the rAF loop, and show it. */
  advance(dt: number): void;
  /** Stop the rAF loop from stepping the picture: measured reads only. */
  freeze(): void;
  /** Let the rAF loop step the picture again after a freeze. */
  thaw(): void;
  /** The host's contents moved: hand the picture `fit` again and, when still, repaint. The box is unchanged. */
  align(): void;
  dispose(): void;
}

/** Two frames after the call: the page's first paint has happened by then,
 *  which is when the WebGPU chunk may start downloading. */
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

/**
 * WebGPU when the browser has an adapter, Canvas2D otherwise. The probe runs
 * before any download: a browser with `navigator.gpu` and no adapter (Linux
 * Chrome without flags, most headless runs) never fetches the chunk. vgpu's
 * own unsupported verdict is the second gate, after the chunk is here.
 */
async function pickRenderer(canvas: HTMLCanvasElement, palette: ArtPalette, box: Box, resolution: number, failed: LogEventName): Promise<ArtRenderer> {
  if (!('gpu' in navigator)) return canvasRenderer(canvas, palette);
  const adapter = await navigator.gpu.requestAdapter();

  if (adapter === null) return canvasRenderer(canvas, palette);
  await afterFirstPaint();
  // A dynamic import on purpose: the module carries vgpu, a lazy chunk that
  // only a browser with an adapter should ever download.
  const { createWebGpuRenderer } = await import('./renderer-webgpu');
  const outcome = await createWebGpuRenderer(canvas, palette, box.width, box.height, box.ratio * resolution);

  if (outcome.kind === 'renderer') return outcome.renderer;

  // The landing has no client-error route — `POST /api/client-errors` asks for
  // a session the public page by definition lacks — so a failed start is said
  // here, through the obs sink, with the reason the outcome carried.
  // 'unsupported' is a browser fact, not a failure, and stays quiet.
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

  /** A fresh canvas under the host; the element itself goes because a canvas
   *  that gave its context to WebGPU never hands a 2d one out again. */
  const installCanvas = (): HTMLCanvasElement => {
    canvas?.remove();
    const next = document.createElement('canvas');
    next.className = spec.canvasClassName;
    // Under any veil the host carries as its own child.
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

  /** One evolved frame, no clock: the still a reduced-motion visitor gets. */
  const paintStill = (): void => {
    if (renderer === null) return;
    const box = boxOf(host);
    const frozen = spec.create(box.height / box.width, 'canvas');
    spec.fit?.(frozen, host);
    const steps = Math.round(spec.still.seconds / spec.still.step);

    for (let index = 0; index < steps; index += 1) frozen.step(spec.still.step);
    show(frozen, true);
  };

  /**
   * A live GPU fault: the WebGPU renderer has already disposed itself, so the
   * mount's half is the swap — a fresh element, Canvas2D, the same picture.
   * The simulation keeps its clock and its state; only the drawing rebinds.
   */
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

  const startFailed = <Thrown,>(cause: Thrown): never => {
    throw new Error('the art renderer did not start', { cause });
  };

  /** The picture is made once the renderer is known, since a picture may
   *  be sized to it; until then the placeholder from the mount stands. */
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

    pickRenderer(next, palette, box, spec.resolution, spec.events.failed).then((picked) => {
      if (disposed || canvas !== next) {
        picked.dispose();

        return;
      }

      art = spec.create(box.height / box.width, picked.kind);
      renderer = picked;
      next.dataset.renderer = picked.kind;
      picked.onFault?.(onGpuFault);
      fit();
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
    renderer: () => (renderer === null ? 'pending' : still ? 'static' : renderer.kind),
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
