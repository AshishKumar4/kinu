/**
 * Unit tests: crafted-tool source lifting.
 *
 * `toCraftedToolSource` is the filter standing between the crafted_tools table
 * and the platform executor: whatever it lets through, some adapter will try to
 * compile. Comment-only and empty rows are the residue of a failed extraction
 * and must not reach a child Worker.
 */

import { describe, test, expect } from 'bun:test';
import { toCraftedToolSource } from '../src/tools/crafted-executor.js';
import type { CraftedTool } from '../src/types/craft.js';

function tool(patch: Partial<CraftedTool>): CraftedTool {
  return {
    name: 'summarize',
    description: 'Summarize text',
    params: null,
    code: 'export default async (a) => a;',
    scope: 'local',
    created_at: 0,
    updated_at: 0,
    ...patch,
  } as CraftedTool;
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
    expect(toCraftedToolSource(tool({ code: null as unknown as string }))).toBeNull();
  });

  test('drops comment-only code, the residue of a failed extraction', () => {
    expect(toCraftedToolSource(tool({ code: '// retired: superseded by web_fetch' }))).toBeNull();
  });

  test('code that merely CONTAINS a comment is still a real tool', () => {
    const source = toCraftedToolSource(tool({ code: 'export default () => 1; // note' }));
    expect(source?.code).toBe('export default () => 1; // note');
  });

  test('a null description gets a derived one — the executor never sees a hole', () => {
    // The description is what the model reads to decide whether to call the
    // tool; a missing one makes the tool effectively uncallable.
    const source = toCraftedToolSource(tool({ description: null as unknown as string }));
    expect(source?.description).toBe('Crafted tool: summarize');
  });

  test('an empty-string description is preserved, not replaced', () => {
    // `??` guards null/undefined only. Pinned so the distinction from the null
    // case above stays deliberate rather than accidental.
    expect(toCraftedToolSource(tool({ description: '' }))?.description).toBe('');
  });

  test('params and scope are deliberately not carried into the executor shape', () => {
    const source = toCraftedToolSource(tool({ params: { type: 'object' }, scope: 'shared' }));
    expect(Object.keys(source!).sort()).toEqual(['code', 'description', 'name']);
  });
});
