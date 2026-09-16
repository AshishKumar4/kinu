// The hero MOUNT lands on Canvas2D whenever the GPU half gives out — proved
// deterministically through the real mount (`mountLivingCanvas`, the code
// `SearchTreeHero` runs) over the real picture, with vgpu faked at its module
// seam and the DOM faked as globals. No React is mocked: the mount is a plain
// function of a host element, which is the seam the component itself uses.
//
// The browser case in scripts/public-pages.test.ts reaches the same swap
// through a real GPUDevice.destroy(), but only on a lane where WebGPU is live;
// on a headless lane it lands on canvas before the destroy and proves the
// resting renderer, not the swap. This suite is the proof that holds
// everywhere: the mount STARTS on WebGPU, the device dies mid-run, and the
// picture goes on under Canvas2D with the clock it had.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { VGPUError as CoreVGPUError } from '@vgpu/core';
import { SearchTree } from '@kinu.run/core/web/hero-art';
import type { StrokeSurface } from '@kinu.run/core/web/hero-canvas';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { installFakeVgpu, lastFakeGpu, resetFakeVgpu, setVgpuInit } from './helpers/fake-vgpu';

await installFakeVgpu();

// Dynamic on purpose: the mount's GPU chunk imports vgpu at module load, so
// it may only load AFTER the fake is installed.
const { mountLivingCanvas } = await import('../src/components/landing/search-tree/living-canvas');

interface FakeCanvasDataset { renderer?: string; settled?: string }

interface FakeCanvas {
  className: string;
  width: number;
  height: number;
  readonly dataset: FakeCanvasDataset;
  strokes: number;
  getContext(kind: string): StrokeSurface | null;
  remove(): void;
}

let hostChildren: FakeCanvas[];

let rafQueue: { readonly id: number; readonly cb: (now: number) => void }[];

let rafNext: number;

let clock: number;

const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installGlobal<Value>(name: string, value: Value): void {
  if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

/** A Canvas2D surface that counts strokes and answers every other call with nothing. */
function countingSurface(canvas: FakeCanvas): StrokeSurface {
  const gradient = { addColorStop: () => undefined, toString: () => 'gradient()' };

  return {
    lineWidth: 1,
    lineCap: 'butt',
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    setTransform: () => undefined,
    clearRect: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    quadraticCurveTo: () => undefined,
    arc: () => undefined,
    stroke: () => { canvas.strokes += 1; },
    fill: () => undefined,
    createLinearGradient: () => gradient,
  };
}

function fakeCanvas(): FakeCanvas {
  const element: FakeCanvas = {
    className: '',
    width: 0,
    height: 0,
    dataset: {},
    strokes: 0,
    getContext(kind: string): StrokeSurface | null {
      return kind === '2d' ? countingSurface(element) : null;
    },
    remove(): void {
      hostChildren = hostChildren.filter((child) => child !== element);
    },
  };

  return element;
}

class FakePassiveObserver {
  constructor(_cb: () => void) {}

  observe(): void {}

  disconnect(): void {}
}

class FakeIntersectionObserver {
  constructor(cb: (entries: readonly { isIntersecting: boolean }[]) => void) {
    // The host is on screen from the start: the loop runs.
    cb([{ isIntersecting: true }]);
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

const fakeDocument = {
  hidden: false,
  documentElement: { dataset: {} },
  createElement(): FakeCanvas {
    return fakeCanvas();
  },
  addEventListener(): void {},
  removeEventListener(): void {},
};

const fakeWindow = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
};

/** The host, as the mount reads it: a child list and a box, nothing more.
 *  A null-prototype object, so the element type is a declaration rather
 *  than an assertion — the same way the renderer suite fakes its canvas. */
const host: HTMLElement = Object.assign(Object.create(null), {
  firstChild: null,
  insertBefore(child: FakeCanvas): void {
    hostChildren.unshift(child);
  },
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 600, width: 1200, height: 600 }),
});

const disposers: (() => void)[] = [];

beforeEach(() => {
  resetFakeVgpu();
  hostChildren = [];
  rafQueue = [];
  rafNext = 0;
  clock = 0;
  installGlobal('window', fakeWindow);
  installGlobal('document', fakeDocument);
  installGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  installGlobal('requestAnimationFrame', (cb: (now: number) => void): number => {
    rafNext += 1;
    rafQueue.push({ id: rafNext, cb });

    return rafNext;
  });
  installGlobal('cancelAnimationFrame', (id: number): void => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
  });
  installGlobal('IntersectionObserver', FakeIntersectionObserver);
  installGlobal('ResizeObserver', FakePassiveObserver);
  installGlobal('MutationObserver', FakePassiveObserver);
  installGlobal('navigator', { gpu: { requestAdapter: (): Promise<object> => Promise.resolve({}) } });
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();

  for (const [name, previous] of savedGlobals) {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, name);
    } else {
      Object.defineProperty(globalThis, name, previous);
    }
  }

  savedGlobals.clear();
});

afterAll(() => {
  mock.restore();
});

/** Every queued animation frame, in order, sixteen wall-milliseconds apart. */
function drainFrames(): void {
  const queue = rafQueue;
  rafQueue = [];

  for (const entry of queue) {
    clock += 16;
    entry.cb(clock);
  }
}

/**
 * Frames and turns of the event loop until the mount has LANDED — its
 * renderer is no longer pending. The start
 * crosses a real module load (the GPU chunk is a dynamic import), so this is
 * an end condition over turns of the loop, never a count of microtasks and
 * never a clock: a mount that never lands hangs here, which the ladder's
 * deadline ends.
 */
async function landed(living: { renderer(): string }): Promise<void> {
  while (living.renderer() === 'pending') {
    drainFrames();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

/** The hero's own mount spec, minus the pointer wiring the stage adds. */
function mountHero() {
  const living = mountLivingCanvas(host, {
    create: (aspect) => new SearchTree({ seed: 417, aspect }),
    still: { seconds: 4, step: 1 / 30 },
    resolution: 1,
    events: { failed: 'landing.hero_webgpu_failed', faulted: 'landing.hero_webgpu_faulted', fallbackFailed: 'landing.hero_fallback_failed' },
    canvasClassName: 'absolute inset-0 size-full',
  });

  disposers.push(() => living.dispose());

  return living;
}

describe('the hero mount lands on Canvas2D whenever the GPU half gives out', () => {
  test('a device loss mid-run swaps to canvas and keeps the search it had', async () => {
    const logs = createRecordingLogger();
    const restoreSink = setDiagnosticsSink(logs);

    try {
      const living = mountHero();
      await landed(living);

      // The precondition the browser case cannot guarantee on a headless
      // lane: the mount really started on WebGPU.
      expect(living.renderer()).toBe('webgpu');
      const gpu = lastFakeGpu();

      if (gpu === null) throw new Error('init did not produce the fake gpu');

      for (let frame = 0; frame < 8; frame += 1) drainFrames();
      const before = living.time();
      expect(before).toBeGreaterThan(0.1);
      expect(gpu.frames).toBeGreaterThan(0);

      // The device dies through `frame()`, the only channel a real loss has.
      // The swap is synchronous inside the fault handler, so the very next
      // read is the verdict: a mount that never wired the handler still says
      // webgpu here and fails, rather than hanging on a wait.
      gpu.frameThrows = new CoreVGPUError({ code: 'VGPU-DEVICE-LOST', message: 'the device was lost' });
      drainFrames();

      expect(living.renderer()).toBe('canvas');
      expect(gpu.disposed).toBe(true);
      expect(hostChildren).toHaveLength(1);
      expect(hostChildren[0]?.dataset.renderer).toBe('canvas');
      // The same picture, clock and all — never a restart.
      expect(living.time()).toBeGreaterThanOrEqual(before);

      // And it draws: the fallen canvas strokes the tree the GPU was drawing.
      for (let frame = 0; frame < 4; frame += 1) drainFrames();
      expect(hostChildren[0]?.strokes).toBeGreaterThan(0);
      expect(living.time()).toBeGreaterThan(before);

      const faulted = logs.emitted.find((entry) => entry.event === 'landing.hero_webgpu_faulted');
      expect(faulted?.fields['reason']).toContain('the device was lost');
    } finally {
      restoreSink();
    }
  });

  test('a failed WebGPU start paints the tree through the canvas renderer and says why', async () => {
    const logs = createRecordingLogger();
    const restoreSink = setDiagnosticsSink(logs);
    setVgpuInit(() => Promise.reject(new TypeError('device request was denied')));

    try {
      const living = mountHero();
      await landed(living);

      expect(living.renderer()).toBe('canvas');
      expect(hostChildren).toHaveLength(1);
      expect(hostChildren[0]?.dataset.renderer).toBe('canvas');

      for (let frame = 0; frame < 12; frame += 1) drainFrames();
      expect(hostChildren[0]?.strokes).toBeGreaterThan(0);

      const reported = logs.emitted.find((entry) => entry.event === 'landing.hero_webgpu_failed');
      expect(reported?.fields['reason']).toContain('device request was denied');
    } finally {
      restoreSink();
    }
  });
});
