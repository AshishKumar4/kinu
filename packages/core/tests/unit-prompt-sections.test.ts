/**
 * Sectionising the system prompt changed representation and nothing else.
 *
 * Every line of prose that `prompt.ts` used to push into an array now lives in
 * `prompting/section-templates.ts` as one addressable template per section. The
 * point of the move is that a section becomes a value GEPA can score and replace
 * (`evolution/gepa/section-bridge.ts`); the CONDITION of the move is that not one
 * byte the model reads changed on the way.
 *
 * So the landing proof is three-part, and each part covers a hole the others
 * leave:
 *
 *   1. Byte-identity across a branch matrix. `fixtures/prompt-golden.json` is
 *      generated over `fixtures/prompt-surface-matrix.ts`, which takes every
 *      conditional in the eleven sections in both directions.
 *
 *      RE-CUT 2026-08-25. The fixture was originally the PRE-SECTIONISATION
 *      builder's output, and part 1 read "the move changed representation and
 *      nothing else". That claim has been retired because the prompt content
 *      deliberately changed: a measured slimming pass took the matrix from
 *      135,116 bytes to 120,952 across the same 27 surfaces, −14,164 (−10.5%).
 *      What was removed was duplication, each piece of it shipping twice in one
 *      request — every tool's `summary` (in the prompt index AND line 1 of its
 *      own schema description), the `agent.*` API bullets (a weaker hand-copy of
 *      the codemode type block carried in the execute_tools description), and
 *      one of two paragraphs stating the mount doctrine in different words.
 *      Placement changed too: `Runtime context` moved to the end of the prefix
 *      and `Execution environments` ahead of the tool index.
 *
 *      Part 1 keeps its full drift-catching power either way: the fixture is
 *      only ever regenerated deliberately (`bun run scripts/prompt-golden.ts`),
 *      so any source edit that moves a prompt byte without that regeneration
 *      still fails here. What changed is only which baseline it compares to.
 *   2. That comparison is SENSITIVE — one character of any one section's source
 *      moves the prompt. Without this, part 1 could be comparing two things that
 *      are equal for a reason other than correctness.
 *   3. The prose is actually GONE from the builder. Bytes cannot tell a live
 *      template from a reverted inline literal, because both render the same.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPromptSync } from '../src/prompt';
import { PROMPT_SECTIONS } from '../src/prompting/section-templates';
import { templateContract } from '../src/prompting/template';
import { PROMPT_MATRIX } from './fixtures/prompt-surface-matrix';
import { createTestRuntime } from '@kinu.run/test-utils';
import * as v from 'valibot';

const here = dirname(fileURLToPath(import.meta.url));
// Parsed, not asserted: this is a file on disk, and a fixture that has rotted
// into some other shape must say so here rather than at the first comparison.
const golden = v.parse(
  v.record(v.string(), v.string()),
  JSON.parse(readFileSync(join(here, 'fixtures', 'prompt-golden.json'), 'utf8')),
);

/** The section's heading letter, changed. Always plain text, always rendered
 *  whenever the section renders at all, and never inside a `{{…}}` tag — so the
 *  mutation is one character and the template still parses. */
function mutateOneCharacter(source: string): string {
  const at = source.indexOf('## ') + 3;
  expect(at).toBeGreaterThan(2);
  return `${source.slice(0, at)}Z${source.slice(at + 1)}`;
}

describe('the sectionised builder renders the pre-change bytes', () => {
  const { rt } = createTestRuntime();

  test('the golden fixture covers exactly the matrix, with no case rendering empty', () => {
    // Guards the vacuous pass: a matrix case the fixture never captured, or a
    // captured case that renders nothing, would make its comparison free.
    expect(Object.keys(golden).sort()).toEqual(PROMPT_MATRIX.map((c) => c.name).sort());
    for (const name of Object.keys(golden)) expect(golden[name]?.length ?? 0).toBeGreaterThan(200);
  });

  for (const testCase of PROMPT_MATRIX) {
    test(`${testCase.name} — byte-identical`, () => {
      expect(buildSystemPromptSync(rt, testCase.opts)).toBe(golden[testCase.name]);
    });
  }

  test('the whole matrix is the same number of bytes the fixture recorded', () => {
    // Drift gate over every surface at once: a byte that moved without a
    // deliberate regeneration shows up here as a nonzero delta.
    const before = Object.values(golden)
      .reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
    const after = PROMPT_MATRIX
      .reduce((sum, c) => sum + Buffer.byteLength(buildSystemPromptSync(rt, c.opts), 'utf8'), 0);
    expect(after - before).toBe(0);
  });

  test('the matrix total stays under its recorded ceiling', () => {
    // The per-section budgets in `unit-prompt.test.ts` gate ONE surface. This
    // gates the whole matrix, so growth that hides by spreading thinly across branches —
    // a family overlay, a plan-mode arm, an executor row — still has to be a
    // reviewed decision. Measured 120,952 on 2026-08-25 after the slimming pass
    // (from 135,116); the ceiling is ~1% over, like the section budgets.
    // Raise it only alongside an intentional content change, and say so.
    //
    // Raised 2026-08-28 to 127,200, measured 125,938: the delegation ladder
    // gained a THIRD rung (`ask` by `role` — one temporary agent per question),
    // which is one paragraph of selection doctrine in the `agents` schema
    // description plus one bullet each in the Delegation and Code-execution
    // sections. The rung it replaces — `rlm.query`'s decomposition recipe — was
    // removed in the same change, so the net is the ~3.7k a rung costs across
    // every surface that renders the ladder, not a duplicate of what went.
    const MATRIX_CEILING_BYTES = 127_200;
    const total = PROMPT_MATRIX
      .reduce((sum, c) => sum + Buffer.byteLength(buildSystemPromptSync(rt, c.opts), 'utf8'), 0);
    expect({ total, over: total > MATRIX_CEILING_BYTES })
      .toEqual({ total, over: false });
  });
});

describe('the byte-identity comparison is sensitive to one character', () => {
  const { rt } = createTestRuntime();
  // The general surface renders every unconditional section. Role/profile is
  // intentionally conditional, so its own matrix case is its proof surface.
  const full = PROMPT_MATRIX.find((c) => c.name === 'cf-full-surface');
  const roleCase = PROMPT_MATRIX.find((c) => c.name === 'role-general');
  if (!full || !roleCase) throw new Error('matrix lost a required proof surface');

  test('all eleven sections reach a surface that enables them', () => {
    for (const section of PROMPT_SECTIONS) {
      const target = section.id === 'role/profile' ? roleCase : full;
      const prompt = buildSystemPromptSync(rt, target.opts);
      // Up to the newline OR the first tag: `## Delegation` is followed
      // immediately by its first `{{#if}}`, with no newline between them.
      const heading = /^## [^\n{]*/u.exec(section.source)?.[0] ?? '';
      expect({ id: section.id, present: prompt.includes(heading) })
        .toEqual({ id: section.id, present: true });
    }
  });

  for (const section of PROMPT_SECTIONS) {
    test(`${section.id} — one changed character makes the prompt differ`, () => {
      // Through `sectionOverrides`, which is the real promotion path: this is
      // simultaneously the red proof for part 1 and the proof that a promoted
      // section actually reaches the model.
      const target = section.id === 'role/profile' ? roleCase : full;
      const mutated = buildSystemPromptSync(rt, {
        ...target.opts,
        sectionOverrides: { [section.id]: mutateOneCharacter(section.source) },
      });
      expect(mutated).not.toBe(golden[target.name]);
      // And it differs by exactly that character, nowhere else.
      expect(mutated.length).toBe((golden[target.name] ?? '').length);
    });
  }

  test('an override for an unknown id changes nothing', () => {
    // The registry is the addressing scheme; a typo must not silently no-op
    // some OTHER section, and must not throw on a live turn either.
    expect(buildSystemPromptSync(rt, {
      ...full.opts,
      sectionOverrides: { 'state/does-not-exist': '## Nope' },
    })).toBe(golden[full.name]);
  });
});

describe('the prose left the builder', () => {
  const source = readFileSync(join(here, '..', 'src', 'prompt.ts'), 'utf8');

  /** The longest uninterrupted run of plain text in a section — the phrase that
   *  would still be in `prompt.ts` if the conversion were reverted. Derived from
   *  the template itself so it cannot drift from the prose it is guarding. */
  function longestLiteralRun(templateSource: string): string {
    return templateSource
      .split(/\{\{[^}]*\}\}/u)
      .flatMap((chunk) => chunk.split('\n'))
      .reduce((longest, line) => (line.length > longest.length ? line : longest), '');
  }

  for (const section of PROMPT_SECTIONS) {
    test(`${section.id} — its prose is not in prompt.ts`, () => {
      if (section.id === 'role/profile') {
        expect(source.includes('## Role:')).toBe(false);
        return;
      }
      const phrase = longestLiteralRun(section.source);
      expect(phrase.length).toBeGreaterThan(40);
      expect(source.includes(phrase)).toBe(false);
    });
  }

  test('the builder still renders every section through its template', () => {
    // The other half: prose absent because the section was DELETED would pass
    // the checks above and fail the model. Each section renders through one
    // `render(CONSTANT, …)` call, so the builder must carry at least eleven.
    const rendered = source.match(/\brender\([A-Z][A-Z_]*,/gu) ?? [];
    expect(rendered.length).toBeGreaterThanOrEqual(PROMPT_SECTIONS.length);
    // …and the one seam they all go through is built from the turn's overrides,
    // or a promoted section would compile and never reach a prompt.
    expect(source).toContain('const render = sectionRenderer(opts.sectionOverrides);');
  });
});

describe('PROMPT_SECTIONS — the addressing scheme', () => {
  test('eleven sections, unique ids, every one a real template', () => {
    expect(PROMPT_SECTIONS).toHaveLength(11);
    expect(new Set(PROMPT_SECTIONS.map((s) => s.id)).size).toBe(11);
    for (const section of PROMPT_SECTIONS) {
      expect(section.source.startsWith('## ')).toBe(true);
      // Compiles, and its contract is readable — what the promotion gate compares
      // a candidate against.
      expect(templateContract(section.id, section.source)).toBeDefined();
    }
  });

  test('every id is namespaced, so a section and a line can never collide', () => {
    for (const section of PROMPT_SECTIONS) expect(section.id).toMatch(/^[a-z]+\/[a-z-]+$/u);
  });
});
