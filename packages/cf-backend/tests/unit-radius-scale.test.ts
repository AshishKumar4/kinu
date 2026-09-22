/**
 * Every radius token must bottom out in a real length. Defends: an undeclared `--radius` invalidating
 * `calc(var(--radius) - 2px)` so every `rounded-*` computed to `0px`, invisible to typecheck and render tests.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dir, '..', 'src', 'index.css'), 'utf8');

const NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const RUNGS = ['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl'] as const;

const ROLES = ['--r-control', '--r-row', '--r-card', '--r-overlay'] as const;

/** Excludes the Plannotator scope: its local `--radius` is what hid the global omission. */
function globalDeclarations(): Map<string, string> {
  const plannotator = NO_COMMENTS.indexOf('[data-kinu-plan-review]');
  const scope = plannotator === -1 ? NO_COMMENTS : NO_COMMENTS.slice(0, plannotator);
  const out = new Map<string, string>();

  for (const [, name, value] of scope.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
    out.set(name, value.trim());
  }

  return out;
}

const DECLARED = globalDeclarations();

const LENGTH = /^-?\d*\.?\d+(px|rem|em|%)$/;

/** A `calc` containing one unresolvable `var()` is unresolvable as a whole. */
function resolve(token: string, seen: string[] = []): { ok: true; value: string } | { ok: false; at: string } {
  if (seen.includes(token)) return { ok: false, at: `cycle via ${token}` };
  const raw = DECLARED.get(token);

  if (raw === undefined) return { ok: false, at: token };
  const refs = [...raw.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]);

  if (refs.length === 0) {
    return LENGTH.test(raw) ? { ok: true, value: raw } : { ok: false, at: `${token} → non-length ${raw}` };
  }

  for (const ref of refs) {
    const inner = resolve(ref, [...seen, token]);

    if (!inner.ok) return inner;
  }

  return { ok: true, value: raw };
}

function unresolved(tokens: readonly string[]): string[] {
  const out: string[] = [];

  for (const token of tokens) {
    const res = resolve(token);

    if (!res.ok) out.push(`${token}: unresolved at ${res.at}`);
  }

  return out;
}

describe('radius scale', () => {
  test('every rung Tailwind reads is declared and resolves to a length', () => {
    expect(unresolved(RUNGS)).toEqual([]);
  });

  test('every role alias resolves to a length', () => {
    expect(unresolved(ROLES)).toEqual([]);
  });

  test('no global token depends on a bare `--radius`', () => {
    // `--radius` is the Plannotator stylesheet's own contract; nothing global may read it.
    const offenders = [...DECLARED].filter(([, value]) => /var\(\s*--radius\s*[,)]/.test(value));
    expect(offenders.map(([name, value]) => `${name}: ${value}`)).toEqual([]);
  });

  test('every `border-radius: var(…)` in the stylesheet resolves', () => {
    const unresolvedRules: string[] = [];

    for (const [, token] of NO_COMMENTS.matchAll(/border-radius:\s*var\(\s*(--[a-z0-9-]+)/gi)) {
      const res = resolve(token);

      if (!res.ok) unresolvedRules.push(`${token}: unresolved at ${res.at}`);
    }

    expect(unresolvedRules).toEqual([]);
  });
});
