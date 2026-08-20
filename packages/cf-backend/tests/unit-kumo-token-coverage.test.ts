/**
 * Every Kumo colour token must be re-pointed at the Kinu palette.
 *
 * Kumo's components ship compiled: `bg-kumo-brand`, `border-kumo-hairline`
 * and friends are baked into its dist bundle, so a call site cannot restyle
 * them. The only lever is Kumo's own custom properties, which `index.css`
 * re-points at the `--c-*` layer.
 *
 * That lever is all-or-nothing per token, and the failure is silent: an
 * unmapped token keeps Kumo's default, which is a cool neutral or the brand
 * blue `oklch(0.5772 0.2324 260)`. Nothing errors — a blue button simply
 * appears on the umber ground, which is exactly the defect this locks. It is
 * also a drift defect: Kumo adds tokens on minor upgrades, and a new one
 * arrives already unmapped.
 *
 * So the assertion reads the vendor's declarations as the source of truth
 * and requires ours to cover them, rather than checking a hardcoded list
 * that would itself go stale.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** `theme-kumo` is Kumo's default theme — the one whose selectors (`:root`,
 *  `[data-mode="dark"]`) match our DOM. Its sibling `theme-fedramp` is scoped
 *  to `[data-theme="fedramp"]`, which we never set. */
const KUMO_ENTRY = Bun.resolveSync('@cloudflare/kumo/styles/tailwind', import.meta.dir);
const KUMO_THEME = Bun.resolveSync('@cloudflare/kumo/styles/theme-kumo', import.meta.dir);
const INDEX_CSS = resolve(import.meta.dir, '../src/index.css');

/** Stylesheets reachable from `entry` by `@import`, entry included. */
function importChain(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const [, rel] of readFileSync(entry, 'utf8').matchAll(/@import\s+"(\.[^"]+)"/g)) {
    importChain(resolve(dirname(entry), rel!), seen);
  }
  return seen;
}

/** Custom properties a stylesheet *declares* (`--x: …`), not ones it reads. */
function declaredProperties(path: string, prefix: RegExp): Set<string> {
  const text = readFileSync(path, 'utf8');
  return new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!).filter((p) => prefix.test(p)));
}

/** Colour-bearing families only. Kumo's `--text-*` size scale and its raw
 *  `--color-kumo-neutral-*` ramp are inputs to the semantic tokens below,
 *  not surfaces we theme, so re-pointing them would be noise. */
const COLOUR_TOKEN = /^--(color-kumo-(?!neutral-)|text-color-kumo-)/;

describe('Kumo token coverage', () => {
  const vendor = declaredProperties(KUMO_THEME, COLOUR_TOKEN);
  const ours = declaredProperties(INDEX_CSS, COLOUR_TOKEN);

  test('the vendor stylesheet is the one our CSS actually loads', () => {
    // Guards the guard twice over: an empty token set would make every
    // assertion below pass vacuously, and a theme file the entry no longer
    // imports would make them assert against a stylesheet nobody ships.
    expect(vendor.size).toBeGreaterThan(30);
    expect(vendor.has('--color-kumo-brand')).toBe(true);
    expect(importChain(KUMO_ENTRY).has(KUMO_THEME)).toBe(true);
  });

  test('every Kumo colour token is re-pointed at the Kinu palette', () => {
    const unmapped = [...vendor].filter((t) => !ours.has(t)).sort();

    // Named in the failure so the fix is "add these lines", not "go diff two
    // stylesheets by hand".
    expect(unmapped).toEqual([]);
  });

  test('we do not map tokens Kumo no longer declares', () => {
    // The other drift direction: a removed vendor token leaves a line in
    // index.css that looks meaningful and styles nothing.
    const orphaned = [...ours].filter((t) => !vendor.has(t)).sort();

    expect(orphaned).toEqual([]);
  });

  test('no Kumo token is mapped to a literal colour', () => {
    // The mapping has to indirect through `--c-*`, or light mode silently
    // keeps the dark value: `[data-mode="light"]` re-points the palette, not
    // the Kumo block. Alpha/mix expressions over a `--c-*` are still
    // indirection; a bare hex or a raw oklch() is not.
    const text = readFileSync(INDEX_CSS, 'utf8');
    const literal = [...text.matchAll(/(--(?:color|text-color)-kumo-[a-z0-9-]+)\s*:\s*([^;]+);/g)]
      .filter(([, , value]) => !value!.includes('var(--c-') && !/^\s*(transparent|inherit|currentColor)\s*$/.test(value!))
      .map(([, prop, value]) => `${prop}: ${value!.trim()}`);

    // Three escapes are intentional and asserted rather than silently allowed:
    // the shadow drop is a black/ink alpha with no palette equivalent, and it
    // is re-declared by hand once per light face — warm ink for umber's paper,
    // cool ink for silk's. A dark face keeps the `:root` black.
    expect(literal.sort()).toEqual([
      '--color-kumo-shadow-drop: rgba(0, 0, 0, 0.3)',
      '--color-kumo-shadow-drop: rgba(18, 26, 38, 0.14)',
      '--color-kumo-shadow-drop: rgba(43, 26, 4, 0.14)',
    ]);
  });
});
