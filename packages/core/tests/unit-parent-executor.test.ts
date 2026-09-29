import { describe, expect, test } from 'bun:test';
import { answerParentRpc, createParentExecutor, type ParentWorkspaceHandle } from '../src/execution/parent';
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';

function parentHandle(calls: string[]): ParentWorkspaceHandle {
  return {
    read: async (path: string) => {
      calls.push(`read:${path}`);

      return new TextEncoder().encode('hi');
    },
    write: async (input) => {
      calls.push(`write:${input.kind}:${input.path}`);

      return null;
    },
    list: async (path: string) => {
      calls.push(`list:${path}`);

      return [];
    },
    stat: async (path: string) => {
      calls.push(`stat:${path}`);

      return null;
    },
    delete: async (path: string) => {
      calls.push(`delete:${path}`);

      return null;
    },
    exec: async (command: string) => {
      calls.push(`exec:${command}`);

      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
}

describe('parent executor input validation', () => {
  test('readFile with no path refuses instead of reading "undefined"', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    expect(await parent.tools.readFile.execute(undefined)).toMatchObject({ reason: 'bad_input' });
    expect(calls).toEqual([]);
  });

  test('writeFile with no path refuses instead of writing "undefined"', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    expect(await parent.tools.writeFile.execute(undefined, 'x')).toMatchObject({ reason: 'bad_input' });
    expect(calls).toEqual([]);
  });

  test('exists with no path refuses instead of stating "undefined" is absent', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    expect(await parent.tools.exists.execute(undefined)).toMatchObject({ reason: 'bad_input' });
    expect(calls).toEqual([]);
  });

  test('exec with no command refuses instead of running "undefined"', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    const out = await parent.tools.exec.execute(undefined);
    expect(out).toMatchObject({ reason: 'bad_input', error: expect.stringContaining('command must be a string') });
    expect(calls).toEqual([]);
  });

  test('readdir with a non-string path refuses, while no path still lists the root', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    expect(await parent.tools.readdir.execute(123)).toMatchObject({ reason: 'bad_input' });
    expect(calls).toEqual([]);
    await parent.tools.readdir.execute(undefined);
    expect(calls).toEqual(['list:.']);
  });
});

describe('answerParentRpc: the one answer both hosts give a fork', () => {
  test('a VFS failure keeps its errno and path in the native error cause', async () => {
    const cause = new VfsError('EISDIR', 'is a directory', 'notes');

    await expect(answerParentRpc('notes', () => Promise.reject(cause)))
      .rejects.toMatchObject({ _tag: 'KinuError', code: 'io', cause });
  });

  test('an unclassified failure retains its complete cause', async () => {
    const cause = new Error('the shell refused', { cause: new Error('no such binary') });

    await expect(answerParentRpc('', () => Promise.reject(cause)))
      .rejects.toMatchObject({ _tag: 'KinuError', code: 'io', cause });
  });

  test('a success is the value', async () => {
    expect(await answerParentRpc('a.txt', async () => new Uint8Array([104, 105]))).toEqual(new Uint8Array([104, 105]));
  });
});
