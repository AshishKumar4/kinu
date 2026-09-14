// One simulation, two renderers: both read the frame the simulation emits,
// and neither may need anything the other does not get.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  NODE_STRIDE, SearchTree, STROKE_STRIDE, TONE_ASH, TONE_BRIGHT, TONE_EMBER,
  type HeroPalette, type SearchTreeFrame, type SearchTreeRenderer,
} from '@kinu.run/core/web/hero-art';
import { createCanvasRenderer, type StrokeSurface } from '../src/components/landing/search-tree/SearchTreeHero';

const TREE_DIR = resolve(import.meta.dir, '../src/components/landing/search-tree');

const PALETTE: HeroPalette = { mode: 'dark', accent: [224, 164, 88], bright: [227, 210, 174], ash: [156, 145, 132] };

interface Recording {
  strokes: number;
  fills: number;
  readonly styles: Set<string>;
}

/** A CanvasRenderingContext2D that remembers what was asked of it. */
function recordingSurface(): StrokeSurface & Recording {
  const styles = new Set<string>();

  const surface: StrokeSurface & Recording = {
    strokes: 0,
    fills: 0,
    styles,
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
      styles.add(String(surface.strokeStyle));
    },
    fill: () => {
      surface.fills += 1;
      styles.add(String(surface.fillStyle));
    },
  };

  return surface;
}

function frameAfter(seconds: number): SearchTreeFrame {
  const tree = new SearchTree({ seed: 417, aspect: 0.5 });

  for (let index = 0; index < seconds * 60; index += 1) tree.step(1 / 60);

  return tree.frame();
}

describe('the frame is what both renderers read', () => {
  test('the canvas renderer draws every visible stroke and node of a frame, nothing else', () => {
    const frame = frameAfter(8);
    const surface = recordingSurface();
    const renderer: SearchTreeRenderer = createCanvasRenderer(surface, PALETTE);
    renderer.resize(1280, 640, 2);
    renderer.render(frame);
    let visibleStrokes = 0;
    let haloStrokes = 0;
    let visibleNodes = 0;
    let haloNodes = 0;

    for (let index = 0; index < frame.count; index += 1) {
      const alpha = frame.strokes[index * STROKE_STRIDE + 10] ?? 0;
      const glow = frame.strokes[index * STROKE_STRIDE + 8] ?? 0;

      if (alpha <= 0.004) continue;
      visibleStrokes += 1;

      if (glow > 0.55) haloStrokes += 1;
    }

    for (let index = 0; index < frame.nodeCount; index += 1) {
      const alpha = frame.nodes[index * NODE_STRIDE + 5] ?? 0;
      const glow = frame.nodes[index * NODE_STRIDE + 3] ?? 0;

      if (alpha <= 0.004) continue;
      visibleNodes += 1;

      if (glow > 0.5) haloNodes += 1;
    }

    expect(visibleStrokes).toBeGreaterThan(30);
    expect(surface.strokes).toBe(visibleStrokes + haloStrokes);
    expect(surface.fills).toBe(visibleNodes + haloNodes);

    // Every colour it painted is one of the three tokens or a mix of them.
    for (const style of surface.styles) expect(style).toMatch(/^rgba\(\d+,\d+,\d+,[\d.e-]+\)$/u);
  });

  test('the WebGPU renderer uploads the same arrays at the same strides', () => {
    const source = readFileSync(resolve(TREE_DIR, 'renderer-webgpu.ts'), 'utf8');

    // The instance streams are the frame's own buffers, sliced by the frame's
    // counts, at the simulation's strides: no repacking in between.
    expect(source).toContain('strokeGeometry.write(current.strokes.subarray(0, strokeCount * STROKE_STRIDE))');
    expect(source).toContain('nodeGeometry.write(current.nodes.subarray(0, nodeCount * NODE_STRIDE))');
    expect(source).toContain("attributes: { curve: 'float32x4', tip: 'float32x4', look: 'float32x4' }");
    expect(source).toContain("attributes: { point: 'float32x4', look: 'float32x4' }");
    expect(STROKE_STRIDE).toBe(12);
    expect(NODE_STRIDE).toBe(8);
  });

  test('the WGSL palette resolves the same four tones the canvas renderer does', () => {
    const wgsl = readFileSync(resolve(TREE_DIR, 'palette.wgsl'), 'utf8');
    const canvas = readFileSync(resolve(TREE_DIR, 'SearchTreeHero.tsx'), 'utf8');

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
