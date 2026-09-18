/**
 * vgpu, mocked at its module seam: a `Gpu` the test can drop, so the GPU
 * half's fault path is driven from here — a listener error, a `frame()` that
 * throws a device loss — without a device. One helper, so the renderer-level
 * suite and the mount-level suite fake the same vgpu.
 *
 * `installFakeVgpu()` must run before the module under test is imported;
 * `mock.module` hoists nothing.
 */
import { mock } from 'bun:test';

export class MockVGPUError extends Error {
  readonly code: string;

  constructor(data: { readonly code: string; readonly message: string }) {
    super(data.message);
    this.name = 'VGPUError';
    this.code = data.code;
  }
}

/** A `Gpu` that records its listeners and its end, so a test can drop the device. */
export class FakeGpu {
  readonly errorListeners = new Set<(error: Error) => void>();
  frames = 0;
  disposed = false;
  /** When set, the next `frame()` throws it — the way a dead device throws
   *  VGPU-DEVICE-LOST out of `frame()` rather than through `onError`. */
  frameThrows: Error | undefined;

  onError(cb: (error: Error) => void): () => void {
    this.errorListeners.add(cb);

    return () => { this.errorListeners.delete(cb); };
  }

  /** A device loss reaching the registered listener, the way reportError delivers one. */
  emitError(error: Error): void {
    for (const cb of this.errorListeners) cb(error);
  }

  dispose(): void {
    this.disposed = true;
    this.errorListeners.clear();
  }
}

let vgpuInit: () => Promise<FakeGpu> = () => Promise.resolve(new FakeGpu());

let lastGpu: FakeGpu | null = null;

/** The fake's stand-in for a vgpu draw or effect handle. */
interface FakeHandle {
  compile(): Promise<void>;
  set(): void;
}

/** The fake's stand-in for a vgpu surface, target or sampler. */
interface FakeResource {
  dispose(): void;
}

/** What the renderer hands a pass: a target spec and an encoder or effect. */
interface FakePassSpec {
  readonly target?: FakeResource;
  readonly clear?: readonly number[];
  readonly colors?: readonly string[];
}

interface FakeEncoder {
  draw(_drawable: FakeHandle, _options: { readonly instances: number }): void;
}

type FakePassPayload = FakeHandle | ((encoder: FakeEncoder) => void);

interface FakePass {
  pass(_spec: FakePassSpec, payload: FakePassPayload): void;
}

export async function installFakeVgpu(): Promise<void> {
  await mock.module('vgpu', () => ({
  VGPUError: MockVGPUError,
  init: (): Promise<FakeGpu> => {
    const started = vgpuInit().then((gpu) => {
      lastGpu = gpu;

      return gpu;
    });

    return started;
  },
  surface: () => ({
    format: 'bgra8unorm',
    resize: () => undefined,
    dispose: () => undefined,
  }),
  target: (_gpu: FakeGpu, options: { readonly size: readonly [number, number] }) => ({
    texelSize: [1 / options.size[0], 1 / options.size[1]],
    resize: () => undefined,
    dispose: () => undefined,
  }),
  sampler: () => ({}),
  geometry: () => ({
    write: () => undefined,
    destroy: () => undefined,
  }),
  draw: () => ({
    compile: () => Promise.resolve(),
    set: () => undefined,
  }),
  effect: () => ({
    compile: () => Promise.resolve(),
    set: () => undefined,
  }),
  frame: (gpu: FakeGpu, callback: (pass: FakePass) => void): void => {
    if (gpu.frameThrows !== undefined) throw gpu.frameThrows;
    gpu.frames += 1;
    callback({
      pass(_spec: FakePassSpec, payload: FakePassPayload): void {
        // Strokes and nodes arrive as encoders; effects arrive as objects.
        if (payload instanceof Function) payload({ draw: () => undefined });
      },
    });
  },
}));
}

/** The next `init` answers this; the default is a fresh fake. */
export function setVgpuInit(init: () => Promise<FakeGpu>): void {
  vgpuInit = init;
}

/** The fake the last `init` produced, or null. */
export function lastFakeGpu(): FakeGpu | null {
  return lastGpu;
}

/** Back to a fresh fake per init, and no last gpu. */
export function resetFakeVgpu(): void {
  vgpuInit = () => Promise.resolve(new FakeGpu());
  lastGpu = null;
}
