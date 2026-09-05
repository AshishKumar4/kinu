import { describe, expect, test } from 'bun:test';
import { createParentExecutor, type ParentWorkspaceHandle } from '../src/execution/parent';
import { parseRefusal } from '../src/execution/exec-result';

function parentHandle(calls: string[]): ParentWorkspaceHandle {
  return {
    read: async (path: string) => {
      calls.push(`read:${path}`);
      return { ok: true, value: new TextEncoder().encode('hi') };
    },
    write: async (input) => {
      calls.push(`write:${input.kind}:${input.path}`);
      return { ok: true, value: null };
    },
    list: async (path: string) => {
      calls.push(`list:${path}`);
      return { ok: true, value: [] };
    },
    stat: async (path: string) => {
      calls.push(`stat:${path}`);
      return { ok: true, value: null };
    },
    delete: async (path: string) => {
      calls.push(`delete:${path}`);
      return { ok: true, value: null };
    },
    exec: async (command: string) => {
      calls.push(`exec:${command}`);
      return { ok: true, value: { stdout: 'ok', stderr: '', exitCode: 0 } };
    },
  };
}

describe('parent executor input validation', () => {
  test('readFile with no path refuses instead of reading "undefined"', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    const out = String(await parent.tools.readFile.execute(undefined));
    expect(parseRefusal(out)?.reason).toBe('bad_input');
    expect(calls).toEqual([]);
  });

  test('writeFile with no path refuses instead of writing "undefined"', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    const out = String(await parent.tools.writeFile.execute(undefined, 'x'));
    expect(parseRefusal(out)?.reason).toBe('bad_input');
    expect(calls).toEqual([]);
  });

  test('exists with no path refuses instead of stating "undefined" is absent', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    const out = String(await parent.tools.exists.execute(undefined));
    expect(parseRefusal(out)?.reason).toBe('bad_input');
    expect(calls).toEqual([]);
  });

  test('exec with no command refuses instead of running "undefined"', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    const out = String(await parent.tools.exec.execute(undefined));
    expect(parseRefusal(out)?.reason).toBe('bad_input');
    expect(calls).toEqual([]);
  });

  test('readdir with a non-string path refuses, while no path still lists the root', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    expect(parseRefusal(String(await parent.tools.readdir.execute(123)))?.reason).toBe('bad_input');
    expect(calls).toEqual([]);
    await parent.tools.readdir.execute(undefined);
    expect(calls).toEqual(['list:.']);
  });
});
