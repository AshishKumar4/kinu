/**
 * Every radius token must bottom out in a real length.
 *
 * The defect this locks was invisible to typecheck, lint, build and every
 * render test, and it shipped: `@theme inline` mapped Tailwind's radius scale
 * onto `calc(var(--radius) - 2px)` and friends, and `--radius` was never
 * declared outside `[data-kinu-plan-review]`. A `var()` that resolves to
 * nothing makes the whole declaration invalid at computed-value time, so
 * `border-radius` fell back to its initial value — 0px. Measured in the
 * browser at the time: `rounded-sm`, `rounded-md`, `rounded-lg` and
 * `rounded-xl` all computed to `0px`, and `.p-card` rendered square while
 * declaring `var(--r-card)`. 191 call sites were affected, Kumo's own compiled
 * components among them, and the only surface that stayed round was
 * `.p-composer` — which is exactly the "some borders are sharp while the prompt
 * box is round a bit" report.
 *
 * Nothing errors when this breaks, which is why it needs a test rather than
 * care. The assertion resolves the custom-property graph the way a browser
 * would and requires each radius to end at a length, so the values may change
 * freely — only the property of being defined is locked.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dir, '..', 'src', 'index.css'), 'utf8');
const NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The rungs Tailwind's `rounded-*` utilities read. */
const RUNGS = ['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl'] as const;
/** The role names the `.p-*` component classes read. */
const ROLES = ['--r-control', '--r-row', '--r-card', '--r-overlay'] as const;

/**
 * Custom properties declared anywhere outside the Plannotator scope. That scope
 * is excluded deliberately: it declares its own `--radius` for the vendored
 * plan-review stylesheet, and that local declaration is precisely what made the
 * global omission hard to see.
 */
function globalDeclarations(): Map<string, string> {
  const plannotator = NO_COMMENTS.indexOf('[data-kinu-plan-review]');
  const scope = plannotator === -1 ? NO_COMMENTS : NO_COMMENTS.slice(0, plannotator);
  const out = new Map<string, string>();
  for (const [, name, value] of scope.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
    out.set(name!, value!.trim());
  }
  return out;
}

const DECLARED = globalDeclarations();

/** A CSS length, i.e. somewhere for a `var()` chain to stop. */
const LENGTH = /^-?\d*\.?\d+(px|rem|em|%)$/;

/**
 * Resolve a token the way the cascade does: follow `var()` references until a
 * length is reached, or report where the chain died. `calc(…)` is followed into
 * its operands, because a `calc` containing one unresolvable `var()` is
 * unresolvable as a whole — the exact shape of the original bug.
 */
function resolve(token: string, seen: string[] = []): { ok: true; value: string } | { ok: false; at: string } {
  if (seen.includes(token)) return { ok: false, at: `cycle via ${token}` };
  const raw = DECLARED.get(token);
  if (raw === undefined) return { ok: false, at: token };
  const refs = [...raw.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]!);
  if (refs.length === 0) {
    return LENGTH.test(raw) ? { ok: true, value: raw } : { ok: false, at: `${token} → non-length ${raw}` };
  }
  for (const ref of refs) {
    const inner = resolve(ref, [...seen, token]);
    if (!inner.ok) return inner;
  }
  return { ok: true, value: raw };
}

/** Tokens that fail to resolve, each with the point the chain died. Written as a
 *  loop so the failure variant narrows and the reason is read off a typed field
 *  rather than an asserted shape. */
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
    // `--radius` is the Plannotator stylesheet's own contract. Anything global
    // reading it is reading a property that does not exist there, which is the
    // original defect verbatim.
    const offenders = [...DECLARED].filter(([, value]) => /var\(\s*--radius\s*[,)]/.test(value));
    expect(offenders.map(([name, value]) => `${name}: ${value}`)).toEqual([]);
  });

  test('every `border-radius: var(…)` in the stylesheet resolves', () => {
    const unresolved: string[] = [];
    for (const [, token] of NO_COMMENTS.matchAll(/border-radius:\s*var\(\s*(--[a-z0-9-]+)/gi)) {
      const res = resolve(token!);
      if (!res.ok) unresolved.push(`${token}: unresolved at ${res.at}`);
    }
    expect(unresolved).toEqual([]);
  });
});
