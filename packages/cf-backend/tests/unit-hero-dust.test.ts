// The dust the hero settles for where the copy stacks: what the backdrop
// claims — deterministic, slow, faint — must hold before any canvas draws it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createDustRenderer, DustField, type DustFrame, type DustSurface,
} from '../src/components/landing/hero-dust/dust';
import type { HeroPalette } from '../src/components/landing/search-tree/renderer';

const LANDING_DIR = resolve(import.meta.dir, '../src/components/landing');

const DUST_SOURCE = readFileSync(resolve(LANDING_DIR, 'hero-dust/dust.ts'), 'utf8');

const STAGE_SOURCE = readFileSync(resolve(LANDING_DIR, 'search-tree/stage.ts'), 'utf8');

const DARK: HeroPalette = { mode: 'dark', accent: [224, 164, 88], bright: [227, 210, 174], ash: [156, 145, 132] };

const LIGHT: HeroPalette = { mode: 'light', accent: [216, 154, 68], bright: [122, 85, 20], ash: [94, 83, 68] };

function fieldAfter(seconds: number, seed = 91, count = 56, aspect = 1): DustField {
  const field = new DustField({ seed, count });
  field.setAspect(aspect);
  const steps = Math.round(seconds * 60);

  for (let index = 0; index < steps; index += 1) field.step(1 / 60);

  return field;
}

/** A mote is x, y, radius, alpha — the stride the buffer declares for itself. */
function strideOf(frame: DustFrame): number {
  return frame.motes.length / frame.count;
}

interface Recording {
  fills: number;
  clears: number;
  readonly styles: string[];
  readonly ops: string[];
}

/** A CanvasRenderingContext2D that remembers what was asked of it, in order. */
function recordingSurface(): DustSurface & Recording {
  const styles: string[] = [];
  const ops: string[] = [];

  const surface: DustSurface & Recording = {
    fills: 0,
    clears: 0,
    styles,
    ops,
    fillStyle: '',
    globalAlpha: 1,
    setTransform: () => undefined,
    clearRect: () => {
      surface.clears += 1;
      ops.push('clear');
    },
    beginPath: () => undefined,
    arc: () => undefined,
    fill: () => {
      surface.fills += 1;
      styles.push(String(surface.fillStyle));
      ops.push('fill');
    },
  };

  return surface;
}

describe('the dust drifts deterministically', () => {
  test('one seed and one step sequence give byte-identical frames', () => {
    const first = fieldAfter(10).frame();
    const second = fieldAfter(10).frame();

    expect(first.count).toBe(second.count);
    expect([...first.motes]).toEqual([...second.motes]);

    const other = fieldAfter(10, 92).frame();
    expect([...other.motes]).not.toEqual([...first.motes]);
  });

  test('motes stay in the box and inside their bounds', () => {
    const frame = fieldAfter(90, 91, 56, 844 / 390).frame();
    const stride = strideOf(frame);

    // Four floats a mote, no more: the declaration is what the loop reads.
    expect(DUST_SOURCE).toContain('DUST_STRIDE = 4');
    expect(stride).toBe(4);

    for (let index = 0; index < frame.count; index += 1) {
      const at = index * stride;
      expect(frame.motes[at]).toBeGreaterThanOrEqual(-0.03);
      expect(frame.motes[at]).toBeLessThanOrEqual(1.03);
      expect(frame.motes[at + 1]).toBeGreaterThanOrEqual(-0.03);
      expect(frame.motes[at + 1]).toBeLessThanOrEqual(1.03);
      expect(frame.motes[at + 2]).toBeGreaterThanOrEqual(0.6);
      expect(frame.motes[at + 2]).toBeLessThanOrEqual(1.8);
      expect(frame.motes[at + 3]).toBeGreaterThanOrEqual(0);
      expect(frame.motes[at + 3]).toBeLessThanOrEqual(1);
    }
  });

  test('drift is slow', () => {
    const field = fieldAfter(0);
    const before = field.frame().motes.slice();

    for (let index = 0; index < 60; index += 1) field.step(1 / 60);
    const after = field.frame();
    const stride = strideOf(after);

    // One second of drift may not move a mote further than the top speed.
    expect(DUST_SOURCE).toContain('MAX_DRIFT = 0.015');

    for (let index = 0; index < after.count; index += 1) {
      const at = index * stride;
      const dx = Math.abs((after.motes[at] ?? 0) - (before[at] ?? 0));
      const dy = Math.abs((after.motes[at + 1] ?? 0) - (before[at + 1] ?? 0));

      if (dx > 0.5 || dy > 0.5) continue;
      expect(dx).toBeLessThanOrEqual(0.015 + 1e-6);
      expect(dy).toBeLessThanOrEqual(0.015 + 1e-6);
    }
  });

  test('the twinkle moves', () => {
    const field = fieldAfter(0);
    const before = field.frame().motes.slice();

    for (let index = 0; index < 120; index += 1) field.step(1 / 60);
    const after = field.frame();
    const stride = strideOf(after);
    let moved = 0;

    for (let index = 0; index < after.count; index += 1) {
      if (after.motes[index * stride + 3] !== before[index * stride + 3]) moved += 1;
    }

    expect(moved).toBeGreaterThanOrEqual(after.count / 2);
  });
});

describe('the dust renderer paints gold, twice per mote', () => {
  const paint = (palette: HeroPalette, frame: DustFrame): Recording => {
    const surface = recordingSurface();
    const renderer = createDustRenderer(surface, palette);
    renderer.resize(390, 700, 2);
    renderer.render(frame);

    return surface;
  };

  test('dark theme fills with the accent gold and nothing else', () => {
    const frame = fieldAfter(4).frame();
    const surface = paint(DARK, frame);
    const stride = strideOf(frame);

    const visible = [...Array(frame.count).keys()]
      .filter((index) => (frame.motes[index * stride + 3] ?? 0) > 0.004)
      .length;

    expect(DUST_SOURCE).toContain('dark: 0.19, light: 0.18');
    expect(visible).toBeGreaterThan(0);
    expect(surface.fills).toBe(visible * 2);
    expect(surface.clears).toBe(1);
    expect(surface.ops[0]).toBe('clear');

    for (const style of surface.styles) {
      expect(style.startsWith('rgba(224,164,88,')).toBe(true);
      const alpha = Number(style.slice(style.lastIndexOf(',') + 1, -1));
      expect(alpha).toBeLessThanOrEqual(0.19);
    }
  });

  test('light theme fills with the deep gold and nothing else', () => {
    const frame = fieldAfter(4).frame();
    const surface = paint(LIGHT, frame);
    const stride = strideOf(frame);

    const visible = [...Array(frame.count).keys()]
      .filter((index) => (frame.motes[index * stride + 3] ?? 0) > 0.004)
      .length;

    expect(visible).toBeGreaterThan(0);
    expect(surface.fills).toBe(visible * 2);
    expect(surface.clears).toBe(1);
    expect(surface.ops[0]).toBe('clear');

    for (const style of surface.styles) {
      expect(style.startsWith('rgba(122,85,20,')).toBe(true);
      const alpha = Number(style.slice(style.lastIndexOf(',') + 1, -1));
      expect(alpha).toBeLessThanOrEqual(0.18);
    }
  });
});

describe('the backdrop swaps where the copy stacks', () => {
  test('the hero renders the tree at lg and the dust below it', () => {
    const source = readFileSync(resolve(LANDING_DIR, 'LandingHero.tsx'), 'utf8');

    // The grid's second column and the backdrop change hands at one width.
    expect(source).toContain('lg:grid-cols-[');
    expect(source).toContain('wide ? <SearchTreeHero /> : <HeroDust />');
  });

  test('the query is Tailwind lg, which this theme does not redefine', () => {
    expect(STAGE_SOURCE).toContain("WIDE_HERO_QUERY = '(min-width: 64rem)'");

    const css = readFileSync(resolve(LANDING_DIR, '../../index.css'), 'utf8');
    expect(css).not.toContain('--breakpoint-lg');
  });
});
