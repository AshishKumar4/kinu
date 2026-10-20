// The inert boundary a measured turn runs behind: what Plan permits runs, and any call Plan would refuse is kept from
// running, recorded as intended, and answered from its record where one exists.
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { currentWorkMode, permitInPlan, requireWorkModePermission, toolsBehindBoundary, type ToolBoundary } from '../src/execution/work-mode';
import { toolExecute } from '@kinu.run/test-utils';
import type { JsonValue } from '../src/utils/json';

/** What a kept call with no record answers. */
const NOT_RUN = expect.stringContaining('Not run');

/** A read Plan permits, a write it does not, and a dispatcher whose write action checks the invocation's mode. */
function world() {
  const done: string[] = [];
  const PathInput = jsonSchema<{ path: string }>({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
  const FileInput = jsonSchema<{ op: 'read' | 'write'; path: string }>({ type: 'object', properties: { op: { enum: ['read', 'write'] }, path: { type: 'string' } }, required: ['op', 'path'] });

  const tools: ToolSet = {
    look: permitInPlan(tool({
      inputSchema: PathInput,
      execute: async ({ path }) => {
        done.push(`looked at ${path}`);

        return 'seen';
      },
    })),
    remove: tool({
      inputSchema: PathInput,
      execute: async ({ path }) => {
        done.push(`removed ${path}`);

        return 'removed';
      },
    }),
    file: permitInPlan(tool({
      inputSchema: FileInput,
      execute: async ({ op, path }) => {
        if (op === 'write') requireWorkModePermission(currentWorkMode(), false, 'file.write');
        done.push(`${op} ${path}`);

        return op;
      },
    })),
  };

  const intended: { name: string; input: JsonValue; refused: readonly string[] }[] = [];

  return { done, tools, intended, boundary: { intended: (call) => { intended.push({ ...call }); } } satisfies ToolBoundary };
}

describe('the inert boundary', () => {
  test('a read runs; a write, and a dispatcher\'s write action, are kept from running and recorded as intended', async () => {
    const { done, tools, intended, boundary } = world();
    const kept = toolsBehindBoundary(tools, boundary);

    expect(await toolExecute(kept.look)({ path: 'a.ts' })).toBe('seen');
    expect(await toolExecute(kept.remove)({ path: 'a.ts' })).toEqual(NOT_RUN);
    expect(await toolExecute(kept.file)({ op: 'read', path: 'b.ts' })).toBe('read');
    expect(await toolExecute(kept.file)({ op: 'write', path: 'b.ts' })).toEqual(NOT_RUN);

    expect(done).toEqual(['looked at a.ts', 'read b.ts']);
    expect(intended).toEqual([
      { name: 'remove', input: { path: 'a.ts' }, refused: ['remove'] },
      { name: 'file', input: { op: 'write', path: 'b.ts' }, refused: ['file.write'] },
    ]);
  });

  test('a kept call is answered from its record where the same call was recorded', async () => {
    const { done, tools, boundary } = world();
    const kept = toolsBehindBoundary(tools, { ...boundary, recorded: (name, input) => (name === 'remove' && JSON.stringify(input) === '{"path":"old.log"}' ? 'removed earlier' : null) });

    const remove = toolExecute<{ path: string }, string>(kept.remove);
    expect([await remove({ path: 'old.log' }), await remove({ path: 'new.log' })]).toEqual(['removed earlier', NOT_RUN]);
    expect(done).toEqual([]);
  });

  test('a call that fails on its own still fails; the boundary answers only what Plan refused', async () => {
    const kept = toolsBehindBoundary({
      look: permitInPlan(tool({
        inputSchema: jsonSchema<{ path: string }>({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
        execute: async (): Promise<string> => { throw new Error('disk gone'); },
      })),
    }, { intended: () => {} });

    await expect(toolExecute(kept.look)({ path: 'a.ts' })).rejects.toThrow('disk gone');
  });
});
