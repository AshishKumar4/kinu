/**
 * The workspace's file plane takes a path as a process takes it: a relative one from its home, and `..` after a link is
 * the parent of where the link leads, never the link's own directory (Nimbus's cwd-aware `WorkspaceFs`).
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { createWorkspaceBundle } from './helpers';

test('`..` after a link is the parent of where the link leads, for a read and a write', async () => {
  const workspace = createWorkspaceBundle(new Database(':memory:'));
  await writeText(workspace.vfs, 'target.txt', 'beside the link');
  await writeText(workspace.vfs, 'deep/target.txt', 'beside where the link leads');
  await workspace.vfs.mkdir('deep/inner', { recursive: true });
  await (await workspace.session()).vfs.as(CRED_KERNEL).symlink('/home/main/deep/inner', '/home/main/link');

  expect(await readText(workspace.vfs, 'link/../target.txt')).toBe('beside where the link leads');

  await writeText(workspace.vfs, 'link/../written.txt', 'through the link');

  expect(await readText(workspace.vfs, '/home/main/deep/written.txt')).toBe('through the link');
  expect(await workspace.vfs.stat('written.txt')).toBeNull();
});

test('an empty path is the home, as on the agent planes', async () => {
  const workspace = createWorkspaceBundle(new Database(':memory:'));
  await writeText(workspace.vfs, 'here.txt', 'at home');

  expect((await workspace.vfs.readdir('')).map((entry) => entry.name)).toContain('here.txt');
  expect((await workspace.vfs.stat(''))?.type).toBe('directory');
});
