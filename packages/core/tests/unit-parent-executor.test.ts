import { describe, expect, test } from 'bun:test';
import { answerParentRpc, createParentExecutor, type ParentWorkspaceHandle } from '../src/execution/parent';
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { exists, readText } from '@nimbus-sh/core/vfs/vfs.js';
import { createTestRuntime } from './helpers';
import { present } from '@kinu.run/test-utils';

function parentHandle(calls: string[]): ParentWorkspaceHandle {
  return {
    exec: async (command: string) => {
      calls.push(`exec:${command}`);

      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
}

describe('parent executor input validation', () => {
  test('exec with no command refuses instead of running "undefined"', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    const out = await parent.tools.exec.execute(undefined);
    expect(out).toMatchObject({ reason: 'bad_input', error: expect.stringContaining('command must be a string') });
    expect(calls).toEqual([]);
  });

  test('exec forwards a shell search to the parent workspace', async () => {
    const calls: string[] = [];
    const parent = createParentExecutor({ handle: parentHandle(calls) });
    expect(await parent.tools.exec.execute('find . -name notes.md')).toBe('ok');
    expect(calls).toEqual(['exec:find . -name notes.md']);
  });

  test('a missing cwd runs none of a multi-command parent script', async () => {
    const { rt } = createTestRuntime();
    const shell = present(rt.shell, 'the real parent shell');
    const parent = createParentExecutor({ handle: { exec: (command) => shell.exec(command) } });
    const command = 'pwd; echo x > f';

    await parent.tools.exec.execute(command, { cwd: rt.storage.home });
    expect(await readText(rt.storage.vfs, 'f')).toBe('x\n');
    await rt.storage.vfs.unlink('f');

    const answer = await parent.tools.exec.execute(command, { cwd: `${rt.storage.home}/missing-parent-cwd`, parts: true });

    expect(answer).toMatchObject({ stdout: '', exitCode: 1 });
    expect(await exists(rt.storage.vfs, 'f')).toBe(false);
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
