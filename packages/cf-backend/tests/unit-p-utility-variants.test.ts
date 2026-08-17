/**
 * A `p-*` class used with a variant prefix must be declared as an `@utility`.
 *
 * Tailwind can only generate variant forms (`hover:`, `focus:`, `disabled:`, …)
 * for utilities it knows about. A plain `.p-text { … }` rule inside
 * `@layer components` is not one, so `hover:p-text` compiles to nothing at all:
 * no rule is emitted, no error is raised, and the element simply has no hover
 * state. The app had 130 such call sites — `hover:p-text` ×59,
 * `hover:p-card-hover` ×43, `hover:p-card` ×10, `hover:p-text-2` ×9,
 * `hover:p-danger` ×7, plus `hover:p-elevated` and `hover:p-accent` — which is
 * to say essentially every hover affordance in the product was dead. Verified
 * against the compiled stylesheet at the time: zero `.hover\:p-*` rules were
 * emitted for any of them.
 *
 * `hover:p-card-hover` is the tell that this is a trap rather than carelessness:
 * `.p-card-hover:hover` already existed and worked, and 43 call sites still
 * reached for the framework spelling.
 *
 * This is a drift test. It reads the call sites as the requirement and the
 * stylesheet as the implementation, so new `p-*` roles and new variants stay
 * covered without anyone remembering this file exists.
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

/** `p-*` classes declared with `@utility`, i.e. the ones variants work on. */
const asUtility: ReadonlySet<string> = new Set(
  [...CSS.matchAll(/@utility\s+(p-[a-z0-9-]+)/gi)].map((m) => m[1]!),
);

/** Every `variant:p-name` written in the app, mapped to where it appears. */
function variantUses(): Map<string, string[]> {
  const uses = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const [, , name] of text.matchAll(
      /(?<![-\w])(hover|focus|focus-within|focus-visible|active|disabled|group-hover|aria-pressed):(p-[a-z0-9-]+)/g,
    )) {
      const at = uses.get(name!) ?? [];
      if (!at.includes(file)) at.push(file);
      uses.set(name!, at);
    }
  }
  return uses;
}

describe('p-* utility variants', () => {
  test('every variant-prefixed p-* class is declared as an @utility', () => {
    const dead = [...variantUses()]
      .filter(([name]) => !asUtility.has(name))
      .map(([name, files]) => `${name} (${files.length} file(s), e.g. ${files[0]!.slice(SRC.length + 1)})`);
    expect(dead).toEqual([]);
  });

  test('the stylesheet actually declares p-* utilities', () => {
    // Guards the test itself: if the `@utility` block were renamed away, the
    // assertion above would pass vacuously by finding no declarations AND no
    // uses, which is the failure mode a drift test is most prone to.
    expect(asUtility.size).toBeGreaterThan(0);
  });

  test('no p-* class is declared both as an @utility and as a plain rule', () => {
    // Two declarations of one name land in different cascade layers, and which
    // one wins stops being obvious. One home per role.
    const duplicated = [...asUtility].filter((name) =>
      new RegExp(`^\\s*\\.${name}\\s*(,|\\{)`, 'm').test(CSS),
    );
    expect(duplicated).toEqual([]);
  });
});
