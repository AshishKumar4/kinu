/**
 * A `p-*` class used with a variant prefix must be declared as an `@utility`: Tailwind silently emits nothing
 * for `hover:p-text` when `.p-text` is a plain `@layer components` rule. A drift test over call sites vs stylesheet.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

const CSS = readFileSync(join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(path);
  }

  return out;
}

const asUtility: ReadonlySet<string> = new Set(
  [...CSS.matchAll(/@utility\s+(p-[a-z0-9-]+)/gi)].map((m) => m[1]),
);

function variantUses(): Map<string, string[]> {
  const uses = new Map<string, string[]>();

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');

    for (const [, , name] of text.matchAll(
      /(?<![-\w])(hover|focus|focus-within|focus-visible|active|disabled|group-hover|aria-pressed):(p-[a-z0-9-]+)/g,
    )) {
      const at = uses.get(name) ?? [];

      if (!at.includes(file)) at.push(file);
      uses.set(name, at);
    }
  }

  return uses;
}

describe('p-* utility variants', () => {
  test('every variant-prefixed p-* class is declared as an @utility', () => {
    const dead = [...variantUses()]
      .filter(([name]) => !asUtility.has(name))
      .map(([name, files]) => `${name} (${files.length} file(s), e.g. ${files[0].slice(SRC.length + 1)})`);

    expect(dead).toEqual([]);
  });

  test('the stylesheet actually declares p-* utilities', () => {
    // Guards the test: a renamed `@utility` block would pass vacuously with no declarations and no uses.
    expect(asUtility.size).toBeGreaterThan(0);
  });

  test('no p-* class is declared both as an @utility and as a plain rule', () => {
    // Two declarations land in different cascade layers; one home per role.
    const duplicated = [...asUtility].filter((name) =>
      new RegExp(`^\\s*\\.${name}\\s*(,|\\{)`, 'm').test(CSS),
    );

    expect(duplicated).toEqual([]);
  });
});
