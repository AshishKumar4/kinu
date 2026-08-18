/**
 * Unit tests: crafted-tool source lifting.
 *
 * `toCraftedToolSource` is the filter standing between the crafted_tools table
 * and the platform executor: whatever it lets through, some adapter will try to
 * compile. Comment-only and empty rows are the residue of a failed extraction
 * and must not reach a child Worker.
 */

import { describe, test, expect } from 'bun:test';
import { toCraftedToolSource } from '../src/tools/crafted-executor';
import type { CraftedTool } from '../src/types/craft';

function tool(patch: Partial<CraftedTool>): CraftedTool {
  return {
    name: 'summarize',
    description: 'Summarize text',
    params: null,
    code: 'export default async (a) => a;',
    scope: 'local',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

describe('toCraftedToolSource', () => {
  test('lifts a real tool row to the narrow executor shape', () => {
    expect(toCraftedToolSource(tool({}))).toEqual({
      name: 'summarize',
      description: 'Summarize text',
      code: 'export default async (a) => a;',
    });
  });

  test('drops rows with no code — nothing to compile', () => {
    expect(toCraftedToolSource(tool({ code: '' }))).toBeNull();
  });

  test('drops comment-only code, the residue of a failed extraction', () => {
    expect(toCraftedToolSource(tool({ code: '// retired: superseded by web_fetch' }))).toBeNull();
  });

  test('code that merely CONTAINS a comment is still a real tool', () => {
    const source = toCraftedToolSource(tool({ code: 'export default () => 1; // note' }));
    expect(source?.code).toBe('export default () => 1; // note');
  });

  test('an empty-string description is preserved, not replaced', () => {
    // `??` guards null/undefined only. Pinned so the distinction from the null
    // case above stays deliberate rather than accidental.
    expect(toCraftedToolSource(tool({ description: '' }))?.description).toBe('');
  });

  test('params and scope are deliberately not carried into the executor shape', () => {
    const source = toCraftedToolSource(tool({ params: { type: 'object' }, scope: 'shared' }));
    if (!source) throw new Error('expected a compiled crafted-tool source');
    expect(Object.keys(source).sort()).toEqual(['code', 'description', 'name']);
  });
});
