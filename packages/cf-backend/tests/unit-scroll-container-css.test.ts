/**
 * Two invariants of the app's scroll containers, both locked against defects
 * that no typecheck, build or render test could see.
 *
 * 1. A scroller that names ONE overflow axis has silently opted the other into
 *    `auto`: `visible` computes to `auto` the moment its partner is not
 *    visible. The tab strip asked only for `overflow-x: auto`, and because a
 *    tab overhangs the strip by the pixel its `-mb-px` pulls back — layout the
 *    tab grammar depends on, not content — the strip carried one pixel of
 *    vertical scrollable overflow and grew a vertical scrollbar beside a
 *    single row of tabs. Measured on the rendered page: `scrollHeight` 40 vs
 *    `clientHeight` 39, `overflow-y` computed `auto`.
 *
 * 2. Element defaults that every component must be able to override have to
 *    live in a layer. Unlayered rules outrank every layer no matter how
 *    specific the selector beside them, so `* { scrollbar-width: thin }` at
 *    the top of the file beat `.p-tabstrip { scrollbar-width: none }` inside
 *    `@layer components` — the strip's own suppression never applied, and
 *    `getComputedStyle` returned `thin`. The same trap is why the component
 *    classes were moved into a layer in the first place; the scrollbar block
 *    was left behind.
 *
 * Both assert the shape that produces the behaviour rather than the exact
 * text, so the values may change freely.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dir, '..', 'src', 'index.css'), 'utf8');

interface Rule {
  /** The selector, or the at-rule prelude for `@…` blocks. */
  readonly prelude: string;
  /** Declarations written directly in this block, nested blocks excluded. */
  readonly declarations: string;
  /** Enclosing at-rule preludes, outermost first. */
  readonly atRules: readonly string[];
}

/** Every rule block in a (possibly nested) stylesheet, comments stripped. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const atRules: string[] = [];
  let prelude = '';
  let declarations = '';
  const stack: { prelude: string; declarations: string; isAt: boolean }[] = [];

  for (const ch of text) {
    if (ch === '{') {
      const isAt = prelude.trimStart().startsWith('@');
      stack.push({ prelude, declarations, isAt });
      if (isAt) atRules.push(prelude.trim());
      prelude = '';
      declarations = '';
    } else if (ch === '}') {
      const frame = stack.pop();
      if (!frame) continue;
      if (frame.isAt) atRules.pop();
      else out.push({ prelude: frame.prelude.trim(), declarations, atRules: [...atRules] });
      prelude = '';
      declarations = frame.declarations;
    } else if (ch === ';') {
      declarations += prelude + ';';
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return out;
}

const ALL = rules(CSS);

describe('scroll containers', () => {
  test('a rule that sets one overflow axis sets both', () => {
    const oneAxis = ALL.filter((r) => {
      const x = /(^|[;\s])overflow-x\s*:/.test(r.declarations);
      const y = /(^|[;\s])overflow-y\s*:/.test(r.declarations);
      return x !== y;
    });
    expect(oneAxis.map((r) => r.prelude)).toEqual([]);
  });

  test('universal scrollbar defaults are layered, so a component can override them', () => {
    const universal = ALL.filter((r) =>
      /scrollbar-(width|color)\s*:/.test(r.declarations) || r.prelude.includes('::-webkit-scrollbar'),
    );
    expect(universal.length).toBeGreaterThan(0);

    const unlayered = universal.filter((r) => !r.atRules.some((a) => a.startsWith('@layer')));
    expect(unlayered.map((r) => r.prelude)).toEqual([]);
  });

  test('the tab strip suppresses its scrollbar in a layer a utility can still beat', () => {
    const strip = ALL.find((r) => r.prelude === '.p-tabstrip');
    expect(strip?.declarations).toContain('scrollbar-width: none');
    expect(strip?.atRules).toContain('@layer components');
  });
});
