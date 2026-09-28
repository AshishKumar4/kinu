/** `toCraftedToolSource`: comment-only and empty rows must not reach a child Worker. */

import { describe, test, expect } from 'bun:test';
import { toCraftedToolSource } from '../src/tools/crafted-executor';
import type { CraftedTool } from '../src/types/craft';

function tool(patch: Partial<CraftedTool>): CraftedTool {
  return {
    name: 'summarize',
    description: 'Summarize text',
    code: 'export default async (a) => a;',
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
    expect(toCraftedToolSource(tool({ description: '' }))?.description).toBe('');
  });
});
