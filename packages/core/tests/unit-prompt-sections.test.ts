/**
 * Section addressing: every registered section reaches a rendered prompt, an
 * override replaces exactly that section's bytes, and an unknown id replaces
 * nothing. Measured over `fixtures/prompt-surface-matrix.ts` against live renderings.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { buildSystemPromptSync } from '../src/prompt';
import { renderDynamicContextBlock } from '../src/prompting/volatile-context';
import { PROMPT_SECTIONS } from '../src/prompting/section-templates';
import { definePromptSection, templateContract } from '../src/prompting/template';
import { PROMPT_MATRIX } from './fixtures/prompt-surface-matrix';
import { createTestRuntime } from '@kinu.run/test-utils';
import { PROMPT_SECTION_MAX_BYTES } from '../src/prompting/section-store';

/** Not a heading's first letter, so every diff position is attributable to the injection. */
const MUTANT = 'Z';

const { rt } = createTestRuntime();

// Role/profile is conditional; its own matrix case covers it.
const FULL = PROMPT_MATRIX.find((c) => c.name === 'cf-full-surface');

const ROLE = PROMPT_MATRIX.find((c) => c.name === 'role-task');

if (!FULL || !ROLE) throw new Error('matrix lost a required proof surface');

const FULL_PROMPT = buildSystemPromptSync(rt, FULL.opts);

const ROLE_PROMPT = buildSystemPromptSync(rt, ROLE.opts);

/** One-character change outside any `{{…}}` tag, so the template still parses. */
function mutateOneCharacter(source: string): string {
  const at = source.indexOf('## ') + 3;
  expect(at).toBeGreaterThan(2);
  expect(source[at]).not.toBe(MUTANT);

  return `${source.slice(0, at)}${MUTANT}${source.slice(at + 1)}`;
}

function movedCharacters(baseline: string, mutated: string): string[] {
  const moved = new Set<string>();

  for (let index = 0; index < Math.max(baseline.length, mutated.length); index += 1) {
    if (baseline[index] !== mutated[index]) moved.add(mutated[index] ?? '<end>');
  }

  return [...moved].sort();
}

describe('every registered section reaches a rendered prompt', () => {
  test('the Markdown extraction preserves every rendered byte of the surface matrix', () => {
    const hashes = Object.fromEntries(PROMPT_MATRIX.map(({ name, opts }) => [
      name, createHash('sha256').update(buildSystemPromptSync(rt, opts)).digest('hex'),
    ]));

    expect(hashes).toMatchSnapshot();
  });

  test('all sections reach a surface that enables them', () => {
    for (const section of PROMPT_SECTIONS) {
      const prompt = buildSystemPromptSync(rt, (section.id === 'role/profile' ? ROLE : FULL).opts);
      // `## Delegation` is followed directly by `{{#if}}`.
      const heading = /^## [^\n{]*/u.exec(section.source)?.[0] ?? '';
      expect({ id: section.id, present: prompt.includes(heading) })
        .toEqual({ id: section.id, present: true });
    }
  });

  test('every matrix surface renders a prompt, and no two cases are one request twice', () => {
    // Guards against a vacuous pass.
    const rendered = new Set<string>();

    for (const testCase of PROMPT_MATRIX) {
      const prompt = buildSystemPromptSync(rt, testCase.opts);
      expect({ name: testCase.name, long: prompt.length > 200 })
        .toEqual({ name: testCase.name, long: true });
      const mode = testCase.mode ?? { workMode: 'build', planSubmission: false };
      rendered.add(`${prompt}\n${renderDynamicContextBlock({ mode })}`);
    }

    expect(rendered.size).toBe(PROMPT_MATRIX.length);
  });
});

describe('an override replaces exactly its own section', () => {
  for (const section of PROMPT_SECTIONS) {
    test(`${section.id} — the override's bytes reach the model, and only its own`, () => {
      // Through `sectionOverrides`, the real promotion path. Also fails if the prose is inlined into `prompt.ts`.
      const isRole = section.id === 'role/profile';
      const target = isRole ? ROLE : FULL;
      const baseline = isRole ? ROLE_PROMPT : FULL_PROMPT;

      const mutated = buildSystemPromptSync(rt, {
        ...target.opts,
        sectionOverrides: { [section.id]: mutateOneCharacter(section.source) },
      });

      expect(mutated).not.toBe(baseline);
      expect(mutated.length).toBe(baseline.length);
      expect(movedCharacters(baseline, mutated)).toEqual([MUTANT]);
    });
  }

  test('an override for an unknown id changes nothing', () => {
    // An unknown id must neither disturb another section nor throw.
    expect(buildSystemPromptSync(rt, {
      ...FULL.opts,
      sectionOverrides: { 'state/does-not-exist': '## Nope' },
    })).toBe(FULL_PROMPT);
  });
});

describe('the prompt stays inside its byte budget', () => {
  test('the matrix total stays under its recorded ceiling', () => {
    // Whole-matrix byte ceiling, so growth spread across branches is still reviewed.
    // Raise it only alongside an intentional content change.
    const MATRIX_CEILING_BYTES = 229_708;

    const total = PROMPT_MATRIX
      .reduce((sum, c) => sum + Buffer.byteLength(buildSystemPromptSync(rt, c.opts), 'utf8'), 0);

    expect({ total, over: total > MATRIX_CEILING_BYTES })
      .toEqual({ total, over: false });
  });
});

describe('PROMPT_SECTIONS — the addressing scheme', () => {
  test('file prose and its typed declaration must use exactly the same slots and flags', () => {
    const declaration = '{{value}}{{#if enabled}}{{/if}}';
    const source = '## File{{#if enabled}}: {{value}}{{else}}off{{/if}}';
    const section = definePromptSection('fixture/file', declaration, source);
    expect(section.render({ value: 'ready', enabled: true })).toBe('## File: ready');
    expect(section.render({ value: 'ready', enabled: false })).toBe('## Fileoff');

    for (const invalid of [
      source + '{{undeclared}}',
      source.replace('{{value}}', 'literal'),
      source + '{{#if undeclared}}{{/if}}',
      source.replace('{{#if enabled}}: {{value}}{{else}}off{{/if}}', '{{value}}'),
      source.replace('{{value}}', '{{#if value}}{{/if}}'),
    ]) {
      expect(() => definePromptSection('fixture/file', declaration, invalid)).toThrow('differs from declaration');
    }
  });

  test('eighteen sections, unique ids, every one a real evolvable template', () => {
    expect(PROMPT_SECTIONS).toHaveLength(18);
    expect(new Set(PROMPT_SECTIONS.map((s) => s.id)).size).toBe(18);
    expect(PROMPT_SECTIONS.map(({ id }) => id)).toEqual([
      'guidance/operating', 'role/profile', 'tools/index', 'executors/section',
      'state/persistence', 'state/code-execution', 'state/delegation',
      'state/background-work', 'state/verification', 'state/output-format',
      'state/workspace-instructions', 'lead/responsibility', 'lead/brief',
      'lead/parallel', 'lead/review', 'lead/interruptions', 'lead/delivery', 'lead/direct-edit',
    ]);

    for (const section of PROMPT_SECTIONS) {
      expect(section.source.startsWith('## ')).toBe(true);
      expect(Buffer.byteLength(section.source, 'utf8')).toBeLessThanOrEqual(PROMPT_SECTION_MAX_BYTES);
      expect(templateContract(section.id, section.source)).toBeDefined();
    }
  });

  test('every id is namespaced, so a section and a line can never collide', () => {
    for (const section of PROMPT_SECTIONS) expect(section.id).toMatch(/^[a-z]+\/[a-z-]+$/u);
  });
});
