/** The `/shared` mount isolates by tenant resolved live from the owner, not by path. */
import { describe, expect, test } from 'bun:test';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { withMountTable } from '../src/vfs/mounts';
import { mossaicVfs, type MossaicClient } from '../src/vfs/mossaic-vfs';
import { sharedDriveMount, SHARED_DRIVE_UNCLAIMED } from '../src/vfs/shared-drive';
import { isVfsError, type VfsErrorCode } from '../src/vfs/errno';
import { FakeMossaicError, fakeMossaic, type FakeMossaic } from '@kinu.run/test-utils';

const SHARED_ROOT = '/shared';

function workspacePlane(mossaic: FakeMossaic, owner: () => string | null) {
  const base = createMemoryVfs().vfs;

  return withMountTable(base, [sharedDriveMount(
    () => {
      const id = owner();

      return id === null ? null : mossaicVfs(mossaic.tenant(id));
    },
    () => SHARED_DRIVE_UNCLAIMED,
  )]);
}

describe('the /shared mount', () => {
  test('two owners see two tenants through one path; the cross-read is refused by tenant', async () => {
    const mossaic = fakeMossaic();
    const alice = workspacePlane(mossaic, () => 'user-alice');
    const aliceSecond = workspacePlane(mossaic, () => 'user-alice');
    const bob = workspacePlane(mossaic, () => 'user-bob');

    await alice.writeFile(`${SHARED_ROOT}/notes.txt`, 'alice only');

    expect(await aliceSecond.readFile(`${SHARED_ROOT}/notes.txt`, { encoding: 'utf8' })).toBe('alice only');
    expect(await aliceSecond.readdir(SHARED_ROOT)).toEqual(['notes.txt']);

    expect(await bob.exists(`${SHARED_ROOT}/notes.txt`)).toBe(false);
    expect(await bob.stat(`${SHARED_ROOT}/notes.txt`)).toBeNull();
    await expect(bob.readFile(`${SHARED_ROOT}/notes.txt`)).rejects.toMatchObject({ code: 'ENOENT' });

    await bob.writeFile(`${SHARED_ROOT}/notes.txt`, 'bob only');
    expect(await alice.readFile(`${SHARED_ROOT}/notes.txt`, { encoding: 'utf8' })).toBe('alice only');
    expect(mossaic.stores.get('user-bob')?.size).toBe(1);
    expect(mossaic.stores.get('user-alice')?.size).toBe(1);
  });

  test('an unclaimed workspace has no Drive: a stated absence, never an empty folder', async () => {
    let owner: string | null = null;
    const plane = workspacePlane(fakeMossaic(), () => owner);

    await expect(plane.readdir(SHARED_ROOT)).rejects.toMatchObject({ code: 'ENXIO', message: expect.stringContaining(SHARED_DRIVE_UNCLAIMED) });

    owner = 'user-late';
    expect(await plane.readdir(SHARED_ROOT)).toEqual([]);
  });

  test('the mount forwards the native operations the Drive has: rename, recursive removal, stats listing', async () => {
    const plane = workspacePlane(fakeMossaic(), () => 'user-alice');

    await plane.writeFile(`${SHARED_ROOT}/skills/deploy/SKILL.md`, '---\nname: deploy\ndescription: d\n---\nbody');
    await plane.rename(`${SHARED_ROOT}/skills/deploy/SKILL.md`, `${SHARED_ROOT}/skills/ship/SKILL.md`);
    expect(await plane.exists(`${SHARED_ROOT}/skills/ship/SKILL.md`)).toBe(true);

    const listed = await plane.readdirStats(`${SHARED_ROOT}/skills`);

    expect(listed).toEqual([{ name: 'ship', stat: { size: 0, mtimeMs: expect.any(Number), isDir: true } }]);
    await plane.removeRecursive(`${SHARED_ROOT}/skills`);
    expect(await plane.readdir(SHARED_ROOT)).toEqual([]);
  });
});

describe('the Mossaic adapter boundary', () => {
  function throwing(code: string): MossaicClient {
    const fail = (path: string): never => { throw new FakeMossaicError(code, path); };

    return {
      readFile: async (p) => fail(p), writeFile: async (p) => fail(p), readdir: async (p) => fail(p),
      stat: async (p) => fail(p), exists: async (p) => fail(p), unlink: async (p) => fail(p),
      mkdir: async (p) => fail(p), rmdir: async (p) => fail(p), removeRecursive: async (p) => fail(p),
      rename: async (p) => fail(p), symlink: async (_t, p) => fail(p), readlink: async (p) => fail(p),
      listChildren: async (p) => fail(p), createReadStream: async (p) => fail(p),
    };
  }

  const TRANSLATED: readonly (readonly [theirs: string, ours: VfsErrorCode])[] = [
    ['ENOENT', 'ENOENT'], ['EEXIST', 'EEXIST'], ['EISDIR', 'EISDIR'], ['ENOTDIR', 'ENOTDIR'],
    ['ENOTEMPTY', 'ENOTEMPTY'], ['EACCES', 'EACCES'], ['ENOTSUP', 'ENOTSUP'],
    ['EMOSSAIC_UNAVAILABLE', 'ENXIO'], ['EAGAIN', 'ENXIO'], ['EBUSY', 'ENXIO'],
    ['EINVAL', 'EIO'], ['EFBIG', 'EIO'], ['ELOOP', 'EIO'], ['EBADF', 'EPERM'],
  ];

  test.each(TRANSLATED)('Mossaic %s arrives as Kinu %s, path and cause kept', async (theirs, ours) => {
    const vfs = mossaicVfs(throwing(theirs));

    try {
      await vfs.readFile('/x');
      throw new Error('did not throw');
    } catch (error) {
      expect(isVfsError(error)).toBe(true);

      if (!isVfsError(error)) return;

      expect(error.code).toBe(ours);
      expect(error.path).toBe('/x');
      expect(error.cause).toBeInstanceOf(FakeMossaicError);
    }
  });

  test('a throw with no Mossaic code is EIO carrying the original', async () => {
    const client = throwing('ENOENT');

    client.readFile = async () => { throw new TypeError('fetch failed'); };

    await expect(mossaicVfs(client).readFile('/x')).rejects.toMatchObject({ code: 'EIO', message: expect.stringContaining('fetch failed') });
  });

  test('stat answers null for ENOENT and throws every other code', async () => {
    expect(await mossaicVfs(throwing('ENOENT')).stat('/gone')).toBeNull();
    await expect(mossaicVfs(throwing('EMOSSAIC_UNAVAILABLE')).stat('/x')).rejects.toMatchObject({ code: 'ENXIO' });
  });
});
