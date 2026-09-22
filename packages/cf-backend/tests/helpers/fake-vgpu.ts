/**
 * vgpu mocked at its module seam so device-loss fault paths run without a device; shared by renderer and mount suites.
 * `installFakeVgpu()` must run before the module under test is imported: `mock.module` hoists nothing.
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

export class FakeGpu {
  readonly errorListeners = new Set<(error: Error) => void>();
  frames = 0;
  disposed = false;
  /** Thrown by the next `frame()`, as a dead device throws VGPU-DEVICE-LOST rather than via `onError`. */
  frameThrows: Error | undefined;

  onError(cb: (error: Error) => void): () => void {
    this.errorListeners.add(cb);

    return () => { this.errorListeners.delete(cb); };
  }

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

interface FakeHandle {
  compile(): Promise<void>;
  set(): void;
}

interface FakeResource {
  dispose(): void;
}

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
        if (payload instanceof Function) payload({ draw: () => undefined });
      },
    });
  },
}));
}

export function setVgpuInit(init: () => Promise<FakeGpu>): void {
  vgpuInit = init;
}

export function lastFakeGpu(): FakeGpu | null {
  return lastGpu;
}

export function resetFakeVgpu(): void {
  vgpuInit = () => Promise.resolve(new FakeGpu());
  lastGpu = null;
}
