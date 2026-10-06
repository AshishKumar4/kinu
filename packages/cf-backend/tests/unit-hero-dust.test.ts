// The backdrop is deterministic, in bounds, and faint enough to read text over.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { THEME_TOKENS, type Mode } from '@kinu.run/core';

import {
  createDustRenderer, DustField, type DustFrame, type DustSurface,
} from '@kinu.run/core/web/hero-canvas';
import type { ArtPalette } from '@kinu.run/core/web/art';

const DARK: ArtPalette = { mode: 'dark', accent: [224, 164, 88], bright: [227, 210, 174], ash: [156, 145, 132], ground: [15, 13, 11] };

const LIGHT: ArtPalette = { mode: 'light', accent: [216, 154, 68], bright: [122, 85, 20], ash: [94, 83, 68], ground: [233, 226, 211] };

function fieldAfter(seconds: number, seed = 91, count = 56, aspect = 1): DustField {
  const field = new DustField({ seed, count });
  field.setAspect(aspect);
  const steps = Math.round(seconds * 60);

  for (let index = 0; index < steps; index += 1) field.step(1 / 60);

  return field;
}

function strideOf(frame: DustFrame): number {
  return frame.motes.length / frame.count;
}

interface Recording {
  fills: number;
  clears: number;
  readonly styles: string[];
  readonly ops: string[];
}

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
      styles.push(v.parse(v.string(), surface.fillStyle));
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
});

type Rgb = readonly [number, number, number];

const hexPair = (value: string, at: number): number => Number.parseInt(value.slice(at, at + 2), 16);

const hex = (value: string): Rgb => [hexPair(value, 1), hexPair(value, 3), hexPair(value, 5)];

const RGBA = v.pipe(v.string(), v.regex(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/u), v.transform((style) => style.slice(5, -1).split(',').map(Number)));

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => (channel / 255 <= 0.03928 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4);

  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

const contrast = (one: Rgb, two: Rgb): number => {
  const [light, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a);

  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
};

function composited(ground: Rgb, fills: readonly string[]): Rgb {
  return fills.reduce<Rgb>((under, style) => {
    const [r = 0, g = 0, b = 0, alpha = 1] = v.parse(RGBA, style);

    return [r * alpha + under[0] * (1 - alpha), g * alpha + under[1] * (1 - alpha), b * alpha + under[2] * (1 - alpha)];
  }, ground);
}

/** Text's worst contrast over one mote, its two fills stacked. */
function worstTextContrast(mode: Mode, styles: readonly string[]): number {
  const ground = hex(THEME_TOKENS[mode]['--c-bg']);
  const text = hex(THEME_TOKENS[mode]['--c-text']);
  let worst = Infinity;

  for (let at = 0; at < styles.length; at += 2) worst = Math.min(worst, contrast(text, composited(ground, styles.slice(at, at + 2))));

  return worst;
}

describe('the dust renderer paints each mote twice, faint enough to read through', () => {
  const paint = (palette: ArtPalette, frame: DustFrame): Recording => {
    const surface = recordingSurface();
    const renderer = createDustRenderer(surface, palette);
    renderer.resize(390, 700, 2);
    renderer.render(frame);

    return surface;
  };

  test('dark theme: one clear, two fills per visible mote, and text stays readable over them', () => {
    const frame = fieldAfter(4).frame();
    const surface = paint(DARK, frame);
    const stride = strideOf(frame);

    const visible = [...Array(frame.count).keys()]
      .filter((index) => (frame.motes[index * stride + 3] ?? 0) > 0.004)
      .length;

    expect(visible).toBeGreaterThan(0);
    expect(surface.fills).toBe(visible * 2);
    expect(surface.clears).toBe(1);
    expect(surface.ops[0]).toBe('clear');

    expect(worstTextContrast('dark', surface.styles)).toBeGreaterThanOrEqual(4.5);
    expect(worstTextContrast('dark', surface.styles.map((style) => style.replace(/,[\d.]+\)$/u, ',1)')))).toBeLessThan(4.5);
  });

  test('light theme: one clear, two fills per visible mote, and text stays readable over them', () => {
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

    expect(worstTextContrast('light', surface.styles)).toBeGreaterThanOrEqual(4.5);
    expect(worstTextContrast('light', surface.styles.map((style) => style.replace(/,[\d.]+\)$/u, ',1)')))).toBeLessThan(4.5);
  });
});
