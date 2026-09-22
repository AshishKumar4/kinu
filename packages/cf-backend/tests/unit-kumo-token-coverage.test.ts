/**
 * Every Kumo colour token must be re-pointed at the Kinu palette. Kumo ships compiled classes, so its custom
 * properties are the only lever, and an unmapped token silently keeps Kumo's blue; read the vendor's declarations.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Kumo's default theme, whose selectors match our DOM; `theme-fedramp` is scoped to a theme we never set. */
const KUMO_ENTRY = Bun.resolveSync('@cloudflare/kumo/styles/tailwind', import.meta.dir);

const KUMO_THEME = Bun.resolveSync('@cloudflare/kumo/styles/theme-kumo', import.meta.dir);

const INDEX_CSS = resolve(import.meta.dir, '../src/index.css');

function importChain(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);

  for (const [, rel] of readFileSync(entry, 'utf8').matchAll(/@import\s+"(\.[^"]+)"/g)) {
    importChain(resolve(dirname(entry), rel), seen);
  }

  return seen;
}

function declaredProperties(path: string, prefix: RegExp): Set<string> {
  const text = readFileSync(path, 'utf8');

  return new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).filter((p) => prefix.test(p)));
}

/** Colour-bearing families only; the size scale and raw neutral ramp are inputs, not surfaces we theme. */
const COLOUR_TOKEN = /^--(color-kumo-(?!neutral-)|text-color-kumo-)/;

describe('Kumo token coverage', () => {
  const vendor = declaredProperties(KUMO_THEME, COLOUR_TOKEN);
  const ours = declaredProperties(INDEX_CSS, COLOUR_TOKEN);

  test('the vendor stylesheet is the one our CSS actually loads', () => {
    // An empty token set or an unimported theme file would make every assertion below pass vacuously.
    expect(vendor.size).toBeGreaterThan(30);
    expect(vendor.has('--color-kumo-brand')).toBe(true);
    expect(importChain(KUMO_ENTRY).has(KUMO_THEME)).toBe(true);
  });

  test('every Kumo colour token is re-pointed at the Kinu palette', () => {
    const unmapped = [...vendor].filter((t) => !ours.has(t)).sort();

    expect(unmapped).toEqual([]);
  });

  test('we do not map tokens Kumo no longer declares', () => {
    // A removed vendor token leaves a line in index.css that styles nothing.
    const orphaned = [...ours].filter((t) => !vendor.has(t)).sort();

    expect(orphaned).toEqual([]);
  });

  test('no Kumo token is mapped to a literal colour', () => {
    // Must indirect through `--c-*`, or light mode keeps the dark value; a bare hex or raw oklch() is not indirection.
    const text = readFileSync(INDEX_CSS, 'utf8');

    const literal = [...text.matchAll(/(--(?:color|text-color)-kumo-[a-z0-9-]+)\s*:\s*([^;]+);/g)]
      .filter(([, , value]) => !value.includes('var(--c-') && !/^\s*(transparent|inherit|currentColor)\s*$/.test(value))
      .map(([, prop, value]) => `${prop}: ${value.trim()}`);

    expect(literal).toEqual([]);
  });
});
