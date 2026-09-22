// The signed-in shell's connectome and the landing hero's search tree speak
// one frame contract: both renderers must draw either picture's frame
// unchanged — the canvas renderer stroking what the frame marks visible,
// the WebGPU renderer uploading the frame's own arrays at their strides.
import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as v from 'valibot';
import {
  TONE_BRIGHT,
  type ArtFrame, type ArtPalette, type ArtRenderer, NODE_STRIDE, PULSE_STRIDE, STROKE_STRIDE,
} from '@kinu.run/core/web/art';
import { CANVAS_SEGMENTS, Connectome } from '@kinu.run/core/web/connectome';
import { createCanvasRenderer, type StrokeSurface } from '@kinu.run/core/web/hero-canvas';
import { SearchTree } from '@kinu.run/core/web/hero-art';
import { createWebGpuRenderer } from '../src/components/landing/search-tree/renderer-webgpu';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/** The gradient this surface's `createLinearGradient` hands back: it renders
 *  itself as the text the assertions match, which `CanvasGradient` does not. */
interface RecordedGradient extends CanvasGradient {
  readonly stops: readonly { offset: number; color: string }[];
  toString(): string;
}

function isRecordedGradient(style: CanvasGradient | CanvasPattern): style is RecordedGradient {
  return 'stops' in style;
}

/** The style a canvas call left in `strokeStyle`/`fillStyle`, as the text the
 *  recording keeps. */
function styleText(style: string | CanvasGradient | CanvasPattern): string {
  if (v.is(v.string(), style)) return style;

  if (isRecordedGradient(style)) return style.toString();

  throw new Error('the recording surface was handed a style it never made');
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
      const style = styleText(surface.strokeStyle);
      styles.add(style);

      if (style.startsWith('gradient(')) gradientStyles.push(style);
    },
    fill: () => {
      surface.fills += 1;
      styles.add(styleText(surface.fillStyle));
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

/** The canvas-budget mat twelve seconds into work: the picture the fallback
 *  renderer actually strokes on screen. */
function connectomeFrame(): ArtFrame {
  const connectome = new Connectome({ seed: 1729, aspect: 900 / 1440, segments: CANVAS_SEGMENTS });
  connectome.setActivity({ working: true, decisions: 0 });

  for (let index = 0; index < 12 * 60; index += 1) connectome.step(1 / 60);

  return connectome.frame();
}

function treeFrame(seconds: number): ArtFrame {
  const tree = new SearchTree({ seed: 417, aspect: 0.5 });

  for (let index = 0; index < seconds * 60; index += 1) tree.step(1 / 60);

  return tree.frame();
}

describe('the connectome frame is what both renderers read', () => {
  test('the canvas renderer strokes every visible stroke and pulse and fills every visible node', () => {
    const frame = connectomeFrame();
    const surface = recordingSurface();
    const renderer: ArtRenderer = createCanvasRenderer(surface, PALETTE);
    renderer.resize(1440, 900, 2);
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
  });
});

/* ── the GPU half: vgpu mocked at its module seam, `geometry.write` recording
 *  the lengths the renderer hands it. ── */

/** The one shape vgpu's `init` rejects with that is not a failure. */
class MockVGPUError extends Error {
  readonly code: string;

  constructor(data: { readonly code: string; readonly message: string }) {
    super(data.message);
    this.name = 'VGPUError';
    this.code = data.code;
  }
}

class FakeGpu {
  readonly errorListeners = new Set<(error: Error) => void>();

  onError(cb: (error: Error) => void): () => void {
    this.errorListeners.add(cb);

    return () => { this.errorListeners.delete(cb); };
  }

  dispose(): void {
    this.errorListeners.clear();
  }
}

/** Every `geometry.write` payload length, in floats, by the geometry's label. */
const writes = new Map<string, number[]>();

interface FakePassSpec {
  readonly target?: { dispose(): void };
}

/** The fake's stand-in for a vgpu draw or effect handle. */
interface FakeHandle {
  compile(): Promise<void>;
  set(): void;
}

interface FakeEncoder {
  draw(_drawable: FakeHandle, _options: { readonly instances: number }): void;
}

type FakePassPayload = FakeHandle | ((encoder: FakeEncoder) => void);

await mock.module('vgpu', () => ({
  VGPUError: MockVGPUError,
  init: (): Promise<FakeGpu> => Promise.resolve(new FakeGpu()),
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
  geometry: (_gpu: FakeGpu, options: { readonly label?: string }) => ({
    write(data: ArrayBuffer | ArrayBufferView): void {
      const label = options.label ?? 'unlabeled';
      const length = data instanceof ArrayBuffer ? data.byteLength : data.byteLength / 4;
      const list = writes.get(label) ?? [];
      list.push(length);
      writes.set(label, list);
    },
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
  frame: (_gpu: FakeGpu, callback: (pass: { pass(_spec: FakePassSpec, payload: FakePassPayload): void }) => void): void => {
    callback({
      pass(_spec: FakePassSpec, payload: FakePassPayload): void {
        if (payload instanceof Function) payload({ draw: () => undefined });
      },
    });
  },
}));

afterAll(() => {
  mock.restore();
});

describe('the WebGPU renderer uploads the connectome\'s arrays at their strides', () => {
  test('one render writes count*stride floats per stream', async () => {
    const canvas: HTMLCanvasElement = Object.create(null);
    const outcome = await createWebGpuRenderer(canvas, PALETTE, 1440, 900, 1);

    if (outcome.kind !== 'renderer') throw new Error(`expected a renderer outcome, got ${outcome.kind}`);

    const frame = connectomeFrame();
    writes.clear();
    outcome.renderer.render(frame);

    // The renderer's capacities sit above what either picture emits: the
    // write is the frame's own counts at the frame's strides.
    const strokeCount = Math.min(frame.count, 16384);
    const nodeCount = Math.min(frame.nodeCount, 1024);
    const pulseCount = Math.min(frame.pulseCount, 1024);

    expect(writes.get('hero-strokes') ?? []).toEqual(strokeCount > 0 ? [strokeCount * STROKE_STRIDE] : []);
    expect(writes.get('hero-nodes') ?? []).toEqual(nodeCount > 0 ? [nodeCount * NODE_STRIDE] : []);
    expect(writes.get('hero-pulses') ?? []).toEqual(pulseCount > 0 ? [pulseCount * PULSE_STRIDE] : []);
    expect(pulseCount).toBeGreaterThan(0);
  });
});

describe('one contract, two pictures', () => {
  test('a connectome frame and a search-tree frame are both ArtFrame and both draw', () => {
    const frames: ArtFrame[] = [connectomeFrame(), treeFrame(12)];
    const surface = recordingSurface();
    const renderer: ArtRenderer = createCanvasRenderer(surface, PALETTE);
    renderer.resize(1440, 900, 2);

    for (const frame of frames) renderer.render(frame);

    expect(surface.strokes).toBeGreaterThan(0);
    expect(surface.fills).toBeGreaterThan(0);
  });

  test('a scripted pointer frame reads the same node brightness through both renderers', () => {
    // The pointer is a simulation input, so both renderers see the same
    // frame: strokes the pointer holds ride TONE_BRIGHT, and the canvas
    // half strokes a bright one for every bright frame entry.
    const connectome = new Connectome({ seed: 1729, aspect: 900 / 1440, segments: CANVAS_SEGMENTS });

    for (let index = 0; index < 120; index += 1) connectome.step(1 / 60);
    connectome.setPointer(0.9, 0.15);

    for (let index = 0; index < 120; index += 1) connectome.step(1 / 60);
    const frame = connectome.frame();

    let bright = 0;

    for (let index = 0; index < frame.count; index += 1) {
      if (frame.strokes[index * STROKE_STRIDE + 9] === TONE_BRIGHT) bright += 1;
    }

    expect(bright).toBeGreaterThan(0);

    const light: ArtPalette = {
      mode: 'light', accent: [216, 154, 68], bright: [122, 85, 20], ash: [94, 83, 68], ground: [233, 226, 211],
    };

    const surface = recordingSurface();
    const renderer: ArtRenderer = createCanvasRenderer(surface, light);
    renderer.resize(1440, 900, 1);
    renderer.render(frame);

    // The WGSL half reads the same tone field: the shader lifts light
    // strokes by the same factor the canvas applies, and resolves tone 0
    // through the same bright mix on paper.
    const wgsl = readFileSync(resolve(TREE_DIR, 'palette.wgsl'), 'utf8');
    const strokes = readFileSync(resolve(TREE_DIR, 'strokes.wgsl'), 'utf8');
    const canvas = readFileSync(resolve(CORE_WEB, 'hero-canvas.ts'), 'utf8');
    expect(wgsl).toContain('mix(palette.ash.rgb, palette.bright.rgb, 0.35 + 0.65 * glow)');
    expect(canvas).toContain('mix(palette.ash, palette.bright, 0.35 + 0.65 * glow)');
    expect(strokes).toContain('mix(1.0, 2.4, palette.mode)');
    expect(canvas).toContain('LIGHT_LIFT');
    expect(surface.strokes).toBeGreaterThan(bright);
  });
});
