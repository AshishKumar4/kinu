/**
 * The section registry is the prompt's REPLACEMENT surface.
 *
 * Every line of the prompt's prose lives in `prompting/section-templates.ts` as
 * one addressable template per section, so that a section becomes a value GEPA
 * can score and swap
 * (`evolution/gepa/section-bridge.ts`). What has to hold is therefore not a
 * historical byte string — the prompt's content is changed deliberately and
 * often — but the ADDRESSING: every registered section reaches a rendered
 * prompt, an override on one section replaces exactly that section's bytes and
 * nothing else, and an id nobody registered replaces nothing.
 *
 * That is asserted over `fixtures/prompt-surface-matrix.ts`, which takes every
 * conditional in the eleven sections in both directions, so a section that only
 * renders on one branch is still measured on a surface that enables it. Each
 * comparison is between two LIVE renderings taken in the same run: a recorded
 * rendering would only say which prompt shipped the day it was recorded, and
 * the prompt is not frozen.
 *
 * The byte BUDGET is a separate matter and stays: growth that hides by
 * spreading thinly across branches has to be a reviewed decision, which is the
 * matrix ceiling below.
 *
 * End-to-end — a candidate proposed, promoted and read back out of the store
 * into the builder — is `unit-prompt-section-evolution.test.ts`; this file
 * covers the eleven addresses that path depends on.
 */

import { describe, expect, test } from 'bun:test';
import { buildSystemPromptSync } from '../src/prompt';
import { PROMPT_SECTIONS } from '../src/prompting/section-templates';
import { templateContract } from '../src/prompting/template';
import { PROMPT_MATRIX } from './fixtures/prompt-surface-matrix';
import { createTestRuntime } from '@kinu.run/test-utils';

/** The character the mutation writes. Not a letter any section heading starts
 *  with, so every position where a mutated prompt differs from its baseline is
 *  attributable to the injection rather than to something that reflowed. */
const MUTANT = 'Z';

const { rt } = createTestRuntime();

// The full surface renders every unconditional section. Role/profile is
// intentionally conditional, so its own matrix case is its proof surface.
const FULL = PROMPT_MATRIX.find((c) => c.name === 'cf-full-surface');
const ROLE = PROMPT_MATRIX.find((c) => c.name === 'role-general');
if (!FULL || !ROLE) throw new Error('matrix lost a required proof surface');

// The two baselines every comparison below is against, rendered once. Both are
// taken in this run, from this source: a recorded rendering would only say
// which prompt shipped the day it was recorded.
const FULL_PROMPT = buildSystemPromptSync(rt, FULL.opts);
const ROLE_PROMPT = buildSystemPromptSync(rt, ROLE.opts);

/** The section's heading letter, changed. Always plain text, always rendered
 *  whenever the section renders at all, and never inside a `{{…}}` tag — so the
 *  mutation is one character and the template still parses. */
function mutateOneCharacter(source: string): string {
  const at = source.indexOf('## ') + 3;
  expect(at).toBeGreaterThan(2);
  expect(source[at]).not.toBe(MUTANT);
  return `${source.slice(0, at)}${MUTANT}${source.slice(at + 1)}`;
}

/** The characters a mutated rendering carries where its baseline carries
 *  something else — the delta, read as content rather than as a count, so a
 *  failure names what moved instead of how much. */
function movedCharacters(baseline: string, mutated: string): string[] {
  const moved = new Set<string>();
  for (let index = 0; index < Math.max(baseline.length, mutated.length); index += 1) {
    if (baseline[index] !== mutated[index]) moved.add(mutated[index] ?? '<end>');
  }
  return [...moved].sort();
}

describe('every registered section reaches a rendered prompt', () => {
  test('all eleven sections reach a surface that enables them', () => {
    for (const section of PROMPT_SECTIONS) {
      const prompt = buildSystemPromptSync(rt, (section.id === 'role/profile' ? ROLE : FULL).opts);
      // Up to the newline OR the first tag: `## Delegation` is followed
      // immediately by its first `{{#if}}`, with no newline between them.
      const heading = /^## [^\n{]*/u.exec(section.source)?.[0] ?? '';
      expect({ id: section.id, present: prompt.includes(heading) })
        .toEqual({ id: section.id, present: true });
    }
  });

  test('every matrix surface renders a prompt, and no two cases are one request twice', () => {
    // Guards the vacuous pass on the other side: a surface that rendered
    // nothing, or two matrix cases that are the same request under two names,
    // would make the comparisons in this file free.
    const rendered = new Set<string>();
    for (const testCase of PROMPT_MATRIX) {
      const prompt = buildSystemPromptSync(rt, testCase.opts);
      expect({ name: testCase.name, long: prompt.length > 200 })
        .toEqual({ name: testCase.name, long: true });
      rendered.add(prompt);
    }
    expect(rendered.size).toBe(PROMPT_MATRIX.length);
  });
});

describe('an override replaces exactly its own section', () => {
  for (const section of PROMPT_SECTIONS) {
    test(`${section.id} — the override's bytes reach the model, and only its own`, () => {
      // Through `sectionOverrides`, which is the real promotion path: this is
      // simultaneously the proof that a promoted section reaches the model and
      // the proof that promoting one section cannot disturb another. It is also
      // what fails if this section's prose were ever inlined back into
      // `prompt.ts` — the builder would render the literal, ignore the
      // override, and the two prompts below would be equal.
      const isRole = section.id === 'role/profile';
      const target = isRole ? ROLE : FULL;
      const baseline = isRole ? ROLE_PROMPT : FULL_PROMPT;
      const mutated = buildSystemPromptSync(rt, {
        ...target.opts,
        sectionOverrides: { [section.id]: mutateOneCharacter(section.source) },
      });
      expect(mutated).not.toBe(baseline);
      // One character for one character: nothing reflowed, nothing else moved.
      expect(mutated.length).toBe(baseline.length);
      expect(movedCharacters(baseline, mutated)).toEqual([MUTANT]);
    });
  }

  test('an override for an unknown id changes nothing', () => {
    // The registry is the addressing scheme; a typo must not silently no-op
    // some OTHER section, and must not throw on a live turn either.
    expect(buildSystemPromptSync(rt, {
      ...FULL.opts,
      sectionOverrides: { 'state/does-not-exist': '## Nope' },
    })).toBe(FULL_PROMPT);
  });
});

describe('the prompt stays inside its byte budget', () => {
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
    // Lowered 2026-09-03 to 111,800, measured 110,668: the delegation nudge
    // came out. The Delegation section is a neutral index (no shape test,
    // no triggers, no coordination loop, no artifact trail), the Code-execution
    // section lost its `agents.ask` bullet, the `agents` schema shed the
    // Breadth/Doubt triggers and the payoff framing, and the placeholder
    // mission lost its heads/subordinates clause.
    const MATRIX_CEILING_BYTES = 111_800;
    const total = PROMPT_MATRIX
      .reduce((sum, c) => sum + Buffer.byteLength(buildSystemPromptSync(rt, c.opts), 'utf8'), 0);
    expect({ total, over: total > MATRIX_CEILING_BYTES })
      .toEqual({ total, over: false });
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
