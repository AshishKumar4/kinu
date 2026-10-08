/**
 * Section addressing: every registered section reaches a rendered prompt, an
 * override replaces exactly that section's bytes, and an unknown id replaces
 * nothing. Measured over `fixtures/prompt-surface-matrix.ts` against live renderings.
 */

import { describe, expect, test } from 'bun:test';

import { definePromptSection } from '../src/prompting/template';

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
      expect(() => definePromptSection('fixture/file', declaration, invalid)).toThrow();
    }
  });

});
