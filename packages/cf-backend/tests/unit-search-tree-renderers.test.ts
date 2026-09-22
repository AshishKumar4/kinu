// Both renderers read the simulation's frame and need nothing the other lacks; the GPU mount returns an outcome,
// never a throw. The mount itself is covered in the real browser (scripts/public-pages.test.ts).
import { VGPUError as CoreVGPUError } from '@vgpu/core';
import * as v from 'valibot';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type ArtFrame, type ArtPalette, type ArtRenderer, NODE_STRIDE, PULSE_STRIDE, RECESS, STROKE_STRIDE, TONE_ASH, TONE_BRIGHT, TONE_EMBER,
} from '@kinu.run/core/web/art';
import { SearchTree } from '@kinu.run/core/web/hero-art';
import { createCanvasRenderer, type StrokeSurface } from '@kinu.run/core/web/hero-canvas';
import { installFakeVgpu, lastFakeGpu, MockVGPUError, resetFakeVgpu, setVgpuInit } from './helpers/fake-vgpu';

import { keepOutOf } from '../src/components/landing/search-tree/stage';

await installFakeVgpu();

// Dynamic: the renderer imports vgpu at load, so it loads only after the fake is installed.
const { createWebGpuRenderer } = await import('../src/components/landing/search-tree/renderer-webgpu');

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

/** Renders as the text the assertions match, which `CanvasGradient` does not. */
interface RecordedGradient extends CanvasGradient {
  readonly stops: readonly { offset: number; color: string }[];
  toString(): string;
}

function isRecordedGradient(style: CanvasGradient | CanvasPattern): style is RecordedGradient {
  return 'stops' in style;
}

function styleText(style: string | CanvasGradient | CanvasPattern): string {
  if (v.is(v.string(), style)) return style;

  if (isRecordedGradient(style)) return style.toString();

  throw new Error('the recording surface was handed a style it never made');
}

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

    // The frame's own buffers, sliced by its counts at the simulation's strides: no repacking.
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

    expect([TONE_BRIGHT, TONE_ASH, TONE_EMBER]).toEqual([1, 2, 3]);
    expect(wgsl).toContain('if (tone > 2.5)');
    expect(wgsl).toContain('if (tone > 1.5)');
    expect(wgsl).toContain('if (tone > 0.5)');
    expect(wgsl).toContain('mix(palette.accent.rgb, palette.ash.rgb, 0.35)');
    expect(canvas).toContain('mix(palette.accent, palette.ash, 0.35)');
    expect(wgsl).toContain('mix(palette.ash.rgb, palette.accent.rgb, 0.35 + 0.65 * glow)');
    expect(canvas).toContain('mix(palette.ash, palette.accent, 0.35 + 0.65 * glow)');
  });

  test('a pulse wears the hot-core mix a node does, in both renderers', () => {
    const pulses = readFileSync(resolve(TREE_DIR, 'pulses.wgsl'), 'utf8');
    const canvas = readFileSync(resolve(CORE_WEB, 'hero-canvas.ts'), 'utf8');

    expect(pulses).toContain('import { Palette, View, glow_scale, recede, to_clip, tone_color } from "./palette.wgsl"');
    expect(pulses).toContain('recede(palette, mix(tone_color(palette, look.z, glow), palette.bright.rgb, glow * 0.6)) * glow_scale(palette, glow)');
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

    for (const shader of ['strokes.wgsl', 'pulses.wgsl', 'nodes.wgsl']) {
      expect(readFileSync(resolve(TREE_DIR, shader), 'utf8')).toContain('recede(palette, ');
    }

    expect(canvas.split('recede(palette, ').length - 1).toBe(3);

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

/* Fallback half: vgpu mocked at its module seam; mount assertions need a real DOM and live in the Chrome suite. */

beforeEach(() => {
  resetFakeVgpu();
});


afterAll(() => {
  mock.restore();
});

describe('the GPU half hands the mount an outcome, never a throw', () => {
  test('a missing adapter answers unsupported', async () => {
    setVgpuInit(() => Promise.reject(new MockVGPUError({ code: 'VGPU-RING1-UNSUPPORTED', message: 'no adapter' })));
    const canvas: HTMLCanvasElement = Object.create(null);
    const outcome = await createWebGpuRenderer({ canvas, initialPalette: PALETTE, width: 1200, height: 600, ratio: 1 });

    expect(outcome.kind).toBe('unsupported');
  });

  test('any other init failure is a fallback outcome that carries the reason', async () => {
    setVgpuInit(() => Promise.reject(new TypeError('device request was denied')));
    const canvas: HTMLCanvasElement = Object.create(null);
    const outcome = await createWebGpuRenderer({ canvas, initialPalette: PALETTE, width: 1200, height: 600, ratio: 1 });

    expect(outcome.kind).toBe('failed');

    if (outcome.kind === 'failed') expect(outcome.reason).toContain('device request was denied');
  });

  test('a live fault disposes the renderer and reaches the fault handler', async () => {
    const canvas: HTMLCanvasElement = Object.create(null);
    const outcome = await createWebGpuRenderer({ canvas, initialPalette: PALETTE, width: 1200, height: 600, ratio: 1 });

    if (outcome.kind !== 'renderer') throw new Error('expected a renderer outcome');

    const gpu = lastFakeGpu();

    if (gpu === null) throw new Error('init did not produce the fake gpu');

    const seen: Error[] = [];
    outcome.renderer.onFault?.((error) => {
      seen.push(error);
    });

    const fault = new Error('the device was lost');
    gpu.emitError(fault);

    expect(seen).toEqual([fault]);
    expect(gpu.disposed).toBe(true);

    outcome.renderer.render(frameAfter(4));
    expect(gpu.frames).toBe(0);
  });
});

describe('a device loss mid-run is the same fault the listener reports', () => {
  test('a frame() that throws VGPU-DEVICE-LOST swaps the mount out', async () => {
    const outcome = await createWebGpuRenderer({ canvas: Object.create(null), initialPalette: PALETTE, width: 1200, height: 600, ratio: 1 });

    if (outcome.kind !== 'renderer') throw new Error(`expected a renderer, got ${outcome.kind}`);

    const gpu = lastFakeGpu();

    if (gpu === null) throw new Error('init was never called');

    const seen: Error[] = [];
    outcome.renderer.onFault?.((error) => { seen.push(error); });

    // `frame()` is the only channel a real device loss has.
    outcome.renderer.render(frameAfter(4));
    expect(gpu.frames).toBe(1);

    // The frame guard throws @vgpu/core's base class, not vgpu's subclass.
    const loss = new CoreVGPUError({ code: 'VGPU-DEVICE-LOST', message: 'the device was lost' });
    gpu.frameThrows = loss;

    outcome.renderer.render(frameAfter(4));

    expect(seen).toEqual([loss]);
    expect(gpu.disposed).toBe(true);

    outcome.renderer.render(frameAfter(4));
  });
});
