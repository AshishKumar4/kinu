/**
 * Removing a tree on a plane with no removal of its own (Nimbus's walked rm -r, `removeTree`): a child the walk cannot
 * read is kept and named, and everything else under the operand still goes.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { exists, writeText, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { removeTree } from '../src/vfs/mounts';
import { createWorkspaceBundle } from './helpers';

test('an unreadable directory keeps itself and its parents; its readable siblings are removed', async () => {
  const workspace = createWorkspaceBundle(new Database(':memory:'));
  const files = workspace.vfs;
  await writeText(files, 'tree/free.txt', 'removable');
  await writeText(files, 'tree/open/also.txt', 'removable too');
  await writeText(files, 'tree/locked/inside.txt', 'unreadable');
  await (await workspace.session()).vfs.as(CRED_KERNEL).chmod('/home/main/tree/locked', 0);

  // The plane's own file calls, and no removal of its own, so the walk is Nimbus's.
  const { workspace: nimbus } = await workspace.session();

  const plane: VFS = {
    readFile: (path) => files.readFile(path),
    writeFile: (path, data) => files.writeFile(path, data),
    readdir: (path) => files.readdir(path),
    stat: (path, options) => files.stat(path, options),
    unlink: (path) => files.unlink(path),
    mkdir: (path, options) => files.mkdir(path, options),
    rmdir: (path) => nimbus.fs.rmdir(path),
  };

  const kept = await removeTree(plane, '/home/main/tree');

  expect(kept?.failed.path).toBe('/home/main/tree/locked');
  expect(kept?.remaining).toEqual(['/home/main/tree', '/home/main/tree/locked']);
  expect(await exists(files, 'tree/free.txt')).toBe(false);
  expect(await exists(files, 'tree/open')).toBe(false);
});
