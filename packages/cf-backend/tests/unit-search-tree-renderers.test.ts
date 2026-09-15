// One simulation, two renderers: both read the frame the simulation emits,
// neither may need anything the other does not get — and the mount's GPU
// half hands the caller an outcome, never a throw. The mount itself mounts
// the real component, so it is covered where it can only be true: against
// the real browser (scripts/public-pages.test.ts reads `__kinuSearchTree`).
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type ArtFrame, type ArtPalette, type ArtRenderer, NODE_STRIDE, PULSE_STRIDE, RECESS, STROKE_STRIDE, TONE_ASH, TONE_BRIGHT, TONE_EMBER,
} from '@kinu.run/core/web/art';
import { SearchTree } from '@kinu.run/core/web/hero-art';
import { createCanvasRenderer, type StrokeSurface } from '@kinu.run/core/web/hero-canvas';
import { createWebGpuRenderer } from '../src/components/landing/search-tree/renderer-webgpu';
import { keepOutOf } from '../src/components/landing/search-tree/stage';

const TREE_DIR = resolve(import.meta.dir, '../src/components/landing/search-tree');

const CORE_WEB = resolve(import.meta.dir, '../../core/src/web');

const PALETTE: ArtPalette = { mode: 'dark', accent: [224, 164, 88], bright: [227, 210, 174], ash: [156, 145, 132], ground: [15, 13, 11] };

interface Recording {
  strokes: number;
  fills: number;
  gradients: number;
  readonly styles: Set<string>;
  readonly gradientStyles: string[];
}

/** A CanvasRenderingContext2D that remembers what was asked of it. */
function recordingSurface(): StrokeSurface & Recording {
  const styles = new Set<string>();
  const gradientStyles: string[] = [];

  const surface: StrokeSurface & Recording = {
    strokes: 0,
    fills: 0,
    gradients: 0,
    styles,
    gradientStyles,
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
    stroke: () => {
      surface.strokes += 1;
      const style = String(surface.strokeStyle);
      styles.add(style);

      if (style.startsWith('gradient(')) gradientStyles.push(style);
    },
    fill: () => {
      surface.fills += 1;
      styles.add(String(surface.fillStyle));
    },
    createLinearGradient: () => {
      surface.gradients += 1;
      const stops: { offset: number; color: string }[] = [];

      const gradient = {
        stops,
        addColorStop(offset: number, color: string): void {
          stops.push({ offset, color });
        },
        toString(): string {
          return `gradient(${stops.map((stop) => `${stop.color}@${String(stop.offset)}`).join(',')})`;
        },
      };

      return gradient;
    },
  };

  return surface;
}

function frameAfter(seconds: number): ArtFrame {
  const tree = new SearchTree({ seed: 417, aspect: 0.5 });

  for (let index = 0; index < seconds * 60; index += 1) tree.step(1 / 60);

  return tree.frame();
}

describe('the frame is what both renderers read', () => {
  test('the canvas renderer draws every visible stroke and node of a frame, nothing else', () => {
    const frame = frameAfter(12);
    const surface = recordingSurface();
    const renderer: ArtRenderer = createCanvasRenderer(surface, PALETTE);
    renderer.resize(1280, 640, 2);
    renderer.render(frame);
    let visibleStrokes = 0;
    let haloStrokes = 0;
    let visiblePulses = 0;
    let haloPulses = 0;
    let visibleNodes = 0;
    let haloNodes = 0;

    for (let index = 0; index < frame.count; index += 1) {
      const alpha = frame.strokes[index * STROKE_STRIDE + 10] ?? 0;
      const glow = frame.strokes[index * STROKE_STRIDE + 8] ?? 0;

      if (alpha <= 0.004) continue;
      visibleStrokes += 1;

      if (glow > 0.55) haloStrokes += 1;
    }

    for (let index = 0; index < frame.pulseCount; index += 1) {
      const alpha = frame.pulses[index * PULSE_STRIDE + 11] ?? 0;
      const glow = frame.pulses[index * PULSE_STRIDE + 9] ?? 0;

      if (alpha <= 0.004 || (frame.pulses[index * PULSE_STRIDE + 6] ?? 0) === (frame.pulses[index * PULSE_STRIDE + 7] ?? 0)) continue;
      visiblePulses += 1;

      if (glow > 0.55) haloPulses += 1;
    }

    for (let index = 0; index < frame.nodeCount; index += 1) {
      const alpha = frame.nodes[index * NODE_STRIDE + 5] ?? 0;
      const glow = frame.nodes[index * NODE_STRIDE + 3] ?? 0;

      if (alpha <= 0.004) continue;
      visibleNodes += 1;

      if (glow > 0.5) haloNodes += 1;
    }

    expect(visibleStrokes).toBeGreaterThan(30);
    expect(frame.pulseCount).toBeGreaterThan(0);
    expect(surface.strokes).toBe(visibleStrokes + haloStrokes + visiblePulses + haloPulses);
    expect(surface.fills).toBe(visibleNodes + haloNodes);

    // Every colour it painted is one of the three tokens or a mix of them: a
    // flat rgba, or a pulse's gradient from a transparent tail to its head.
    for (const style of surface.styles) {
      expect(style).toMatch(/^(?:rgba\(\d+,\d+,\d+,[\d.e-]+\)|gradient\(rgba\(\d+,\d+,\d+,[\d.e-]+\)@0,rgba\(\d+,\d+,\d+,[\d.e-]+\)@1\))$/u);
    }
  });

  test('the canvas renderer strokes every pulse with a gradient from a transparent tail to its head', () => {
    const frame = frameAfter(12);
    const surface = recordingSurface();
    const renderer: ArtRenderer = createCanvasRenderer(surface, PALETTE);
    renderer.resize(1280, 640, 2);
    renderer.render(frame);
    let visiblePulses = 0;
    let haloPulses = 0;

    for (let index = 0; index < frame.pulseCount; index += 1) {
      const alpha = frame.pulses[index * PULSE_STRIDE + 11] ?? 0;
      const glow = frame.pulses[index * PULSE_STRIDE + 9] ?? 0;

      if (alpha <= 0.004 || (frame.pulses[index * PULSE_STRIDE + 6] ?? 0) === (frame.pulses[index * PULSE_STRIDE + 7] ?? 0)) continue;
      visiblePulses += 1;

      if (glow > 0.55) haloPulses += 1;
    }

    expect(frame.pulseCount).toBeGreaterThan(0);
    expect(surface.gradients).toBe(visiblePulses + haloPulses);

    for (const style of surface.gradientStyles) {
      const stops = style.slice('gradient('.length, -1).split(',rgba(');
      const first = stops[0];
      const second = stops[1];

      if (first === undefined || second === undefined) throw new Error(`not a two-stop gradient: ${style}`);
      expect(first).toMatch(/,0\)@0$/u);
      const headAlpha = Number(second.slice(second.lastIndexOf(',') + 1, second.indexOf(')@')));

      expect(headAlpha).toBeGreaterThan(0);
    }

    expect(surface.gradientStyles).toHaveLength(visiblePulses + haloPulses);
  });

  test('the WebGPU renderer uploads the same arrays at the same strides', () => {
    const source = readFileSync(resolve(TREE_DIR, 'renderer-webgpu.ts'), 'utf8');

    // The instance streams are the frame's own buffers, sliced by the frame's
    // counts, at the simulation's strides: no repacking in between.
    expect(source).toContain('strokeGeometry.write(current.strokes.subarray(0, strokeCount * STROKE_STRIDE))');
    expect(source).toContain('nodeGeometry.write(current.nodes.subarray(0, nodeCount * NODE_STRIDE))');
    expect(source).toContain('pulseGeometry.write(current.pulses.subarray(0, pulseCount * PULSE_STRIDE))');
    expect(source).toContain("attributes: { curve: 'float32x4', tip: 'float32x4', look: 'float32x4' }");
    expect(source).toContain("attributes: { point: 'float32x4', look: 'float32x4' }");
    expect(source).toContain("attributes: { curve: 'float32x4', span: 'float32x4', look: 'float32x4', identity: 'float32x4' }");
    expect(STROKE_STRIDE).toBe(12);
    expect(NODE_STRIDE).toBe(8);
    expect(PULSE_STRIDE).toBe(16);
  });

  test('the WGSL palette resolves the same four tones the canvas renderer does', () => {
    const wgsl = readFileSync(resolve(TREE_DIR, 'palette.wgsl'), 'utf8');
    const canvas = readFileSync(resolve(CORE_WEB, 'hero-canvas.ts'), 'utf8');

    // Tone 0 is the ordinary attempt, the fall-through of both rules.
    expect([TONE_BRIGHT, TONE_ASH, TONE_EMBER]).toEqual([1, 2, 3]);
    // Thresholds between integer tones, highest first, in the shader.
    expect(wgsl).toContain('if (tone > 2.5)');
    expect(wgsl).toContain('if (tone > 1.5)');
    expect(wgsl).toContain('if (tone > 0.5)');
    // The same mixes on the CPU.
    expect(wgsl).toContain('mix(palette.accent.rgb, palette.ash.rgb, 0.35)');
    expect(canvas).toContain('mix(palette.accent, palette.ash, 0.35)');
    expect(wgsl).toContain('mix(palette.ash.rgb, palette.accent.rgb, 0.35 + 0.65 * glow)');
    expect(canvas).toContain('mix(palette.ash, palette.accent, 0.35 + 0.65 * glow)');
  });

  test('a pulse wears the hot-core mix a node does, in both renderers', () => {
    const pulses = readFileSync(resolve(TREE_DIR, 'pulses.wgsl'), 'utf8');
    const canvas = readFileSync(resolve(CORE_WEB, 'hero-canvas.ts'), 'utf8');

    expect(pulses).toContain('import { Palette, View, glow_scale, recede, to_clip, tone_color } from "./palette.wgsl"');
    // The tone colour pulled toward bright by its glow, then receded, on the GPU.
    expect(pulses).toContain('recede(palette, mix(tone_color(palette, look.z, glow), palette.bright.rgb, glow * 0.6)) * glow_scale(palette, glow)');
    // The same mix on the CPU, shared by nodes and pulses.
    expect(canvas.split('mix(toneColor(palette, tone, glow), palette.bright, glow * 0.6)').length - 1).toBe(2);
  });

  test('every tree colour recedes toward the ground by the same RECESS in both renderers', () => {
    const wgsl = readFileSync(resolve(TREE_DIR, 'palette.wgsl'), 'utf8');
    const canvas = readFileSync(resolve(CORE_WEB, 'hero-canvas.ts'), 'utf8');
    const webgpu = readFileSync(resolve(TREE_DIR, 'renderer-webgpu.ts'), 'utf8');

    expect(RECESS).toBeGreaterThan(0.2);
    expect(RECESS).toBeLessThan(0.5);
    expect(wgsl).toContain('mix(color, palette.ground.rgb, palette.recess)');
    expect(canvas).toContain('mix(color, palette.ground, RECESS)');
    expect(webgpu).toContain('recess: RECESS');

    // Stroke, pulse, and node shaders all draw through it, as all canvas paths do.
    for (const shader of ['strokes.wgsl', 'pulses.wgsl', 'nodes.wgsl']) {
      expect(readFileSync(resolve(TREE_DIR, shader), 'utf8')).toContain('recede(palette, ');
    }

    expect(canvas.split('recede(palette, ').length - 1).toBe(3);

    // The ground the palette carries is what the canvas renderer draws with: a
    // stroke drawn in the kept path's gold lands between the gold and the ground.
    const frame = frameAfter(8);
    const surface = recordingSurface();
    createCanvasRenderer(surface, PALETTE).render(frame);
    const goldFull = `rgba(${String(PALETTE.accent[0])},${String(PALETTE.accent[1])},${String(PALETTE.accent[2])},`;
    const receded = PALETTE.accent.map((channel, index) => Math.round(channel + ((PALETTE.ground[index] ?? 0) - channel) * RECESS));
    const goldReceded = `rgba(${String(receded[0])},${String(receded[1])},${String(receded[2])},`;

    expect([...surface.styles].some((style) => style.startsWith(goldFull))).toBeFalse();
    expect([...surface.styles].some((style) => style.startsWith(goldReceded))).toBeTrue();
  });

  test('the headline box reaches the tree in the host\'s view units', () => {
    const host = { left: 0, top: 60, right: 1440, bottom: 750, width: 1440, height: 690 };
    const headline = { left: 88, top: 200, right: 988, bottom: 391, width: 900, height: 191 };
    const box = keepOutOf(host, headline);

    expect(box).not.toBeNull();
    expect(box?.left).toBeCloseTo(88 / 1440, 6);
    expect(box?.top).toBeCloseTo(140 / 690, 6);
    expect(box?.right).toBeCloseTo(988 / 1440, 6);
    expect(box?.bottom).toBeCloseTo(331 / 690, 6);
    expect(keepOutOf(host, null)).toBeNull();
    expect(keepOutOf({ ...host, width: 0 }, headline)).toBeNull();
  });

  test('the frame stays inside the unit box after a long run, so neither renderer clips', () => {
    const frame = frameAfter(40);

    for (let index = 0; index < frame.count; index += 1) {
      const at = index * STROKE_STRIDE;

      for (const field of [1, 3, 5]) {
        expect(frame.strokes[at + field]).toBeGreaterThanOrEqual(-0.05);
        expect(frame.strokes[at + field]).toBeLessThanOrEqual(1.05);
      }
    }
  });
});

/* ── the fallback half: vgpu mocked at its module seam. The mount itself
 *  needs a real DOM, so the mount assertions live in the Chrome suite; what
 *  this half pins is the outcome contract `createWebGpuRenderer` hands the
 *  mount, and the live-fault path the renderer takes on `gpu.onError`. ── */

class MockVGPUError extends Error {
  readonly code: string;

  constructor(data: { readonly code: string; readonly message: string }) {
    super(data.message);
    this.name = 'VGPUError';
    this.code = data.code;
  }
}

/** A `Gpu` that records its listeners and its end, so a test can drop the device. */
class FakeGpu {
  readonly errorListeners = new Set<(error: Error) => void>();
  frames = 0;
  disposed = false;

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

let vgpuInit: () => Promise<FakeGpu>;

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
    gpu.frames += 1;
    callback({
      pass(_spec: FakePassSpec, payload: FakePassPayload): void {
        // Strokes and nodes arrive as encoders; effects arrive as objects.
        if (payload instanceof Function) payload({ draw: () => undefined });
      },
    });
  },
}));

beforeEach(() => {
  vgpuInit = () => Promise.resolve(new FakeGpu());
  lastGpu = null;
});


afterAll(() => {
  mock.restore();
});

describe('the GPU half hands the mount an outcome, never a throw', () => {
  test('a missing adapter answers unsupported', async () => {
    vgpuInit = () => Promise.reject(new MockVGPUError({ code: 'VGPU-RING1-UNSUPPORTED', message: 'no adapter' }));
    // The canvas only reaches vgpu's `surface`, which a rejecting init never gets to.
    const canvas: HTMLCanvasElement = Object.create(null);
    const outcome = await createWebGpuRenderer(canvas, PALETTE, 1200, 600, 1);

    expect(outcome.kind).toBe('unsupported');
  });

  test('any other init failure is a fallback outcome that carries the reason', async () => {
    vgpuInit = () => Promise.reject(new TypeError('device request was denied'));
    const canvas: HTMLCanvasElement = Object.create(null);
    const outcome = await createWebGpuRenderer(canvas, PALETTE, 1200, 600, 1);

    expect(outcome.kind).toBe('failed');

    if (outcome.kind === 'failed') expect(outcome.reason).toContain('device request was denied');
  });

  test('a live fault disposes the renderer and reaches the fault handler', async () => {
    // The fake `surface` records the canvas without reading it.
    const canvas: HTMLCanvasElement = Object.create(null);
    const outcome = await createWebGpuRenderer(canvas, PALETTE, 1200, 600, 1);

    if (outcome.kind !== 'renderer') throw new Error('expected a renderer outcome');

    const gpu = lastGpu;

    if (gpu === null) throw new Error('init did not produce the fake gpu');

    const seen: Error[] = [];
    outcome.renderer.onFault?.((error) => {
      seen.push(error);
    });

    const fault = new Error('the device was lost');
    gpu.emitError(fault);

    expect(seen).toEqual([fault]);
    expect(gpu.disposed).toBe(true);

    // The dead renderer stays quiet instead of drawing or throwing.
    outcome.renderer.render(frameAfter(4));
    expect(gpu.frames).toBe(0);
  });
});

/* ── deleted: "a device loss mid-run swaps to canvas". A real WebGPU device
 *  loss does not reach `gpu.onError` — vgpu 0.4.1 throws from the next
 *  `frame()` call — so the old fake-DOM test asserted a seam real vgpu does
 *  not take. The product question it raises (a dead device must still drop
 *  the mount to Canvas2D) is recorded, not solved here. ── */
