/**
 * The `/shared` mount: one tenant per owner, isolated by TENANT.
 *
 * The failure this suite exists to catch is the one that matters for a shared
 * Drive: two users' workspaces reaching one another's files. Isolation is not
 * a path rule — both owners address the very same `/shared/...` string — it is
 * which tenant the mount resolves for the workspace's owner, live, at every
 * call. So the cross-read is asserted through the REAL composite plane
 * (`withMountTable` + `sharedDriveMount` + `mossaicVfs`) over a fake Mossaic
 * whose only job is to keep tenants apart, and the second half pins the
 * adapter's boundary: Mossaic's error union arriving as Kinu's closed codes.
 */
import { describe, expect, test } from 'bun:test';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { withMountTable } from '../src/vfs/mounts';
import { mossaicVfs, type MossaicClient } from '../src/vfs/mossaic-vfs';
import { sharedDriveMount, SHARED_DRIVE_UNCLAIMED } from '../src/vfs/shared-drive';
import { isVfsError, type VfsErrorCode } from '../src/vfs/errno';
import { FakeMossaicError, fakeMossaic, type FakeMossaic } from './helpers-fake-mossaic';

const SHARED_ROOT = '/shared';

/** A workspace plane whose owner is read live, as the hosted runtime reads it. */
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

    // The same owner's OTHER workspace mounts the same tenant: one Drive per user.
    expect(await aliceSecond.readFile(`${SHARED_ROOT}/notes.txt`, { encoding: 'utf8' })).toBe('alice only');
    expect(await aliceSecond.readdir(SHARED_ROOT)).toEqual(['notes.txt']);

    // Bob addresses the identical string and reaches his own, empty tenant.
    expect(await bob.exists(`${SHARED_ROOT}/notes.txt`)).toBe(false);
    expect(await bob.stat(`${SHARED_ROOT}/notes.txt`)).toBeNull();
    await expect(bob.readFile(`${SHARED_ROOT}/notes.txt`)).rejects.toMatchObject({ code: 'ENOENT' });

    // And nothing leaked into the other direction either.
    await bob.writeFile(`${SHARED_ROOT}/notes.txt`, 'bob only');
    expect(await alice.readFile(`${SHARED_ROOT}/notes.txt`, { encoding: 'utf8' })).toBe('alice only');
    expect(mossaic.stores.get('user-bob')?.size).toBe(1);
    expect(mossaic.stores.get('user-alice')?.size).toBe(1);
  });

  test('an unclaimed workspace has no Drive: a stated absence, never an empty folder', async () => {
    let owner: string | null = null;
    const plane = workspacePlane(fakeMossaic(), () => owner);

    await expect(plane.readdir(SHARED_ROOT)).rejects.toMatchObject({ code: 'ENXIO', message: expect.stringContaining(SHARED_DRIVE_UNCLAIMED) });

    // The claim lands later and the same plane, unrebuilt, now mounts the tenant.
    owner = 'user-late';
    expect(await plane.readdir(SHARED_ROOT)).toEqual([]);
  });

  test('the mount forwards the native operations the Drive has: rename, recursive removal, stats listing', async () => {
    const plane = workspacePlane(fakeMossaic(), () => 'user-alice');

    await plane.writeFile(`${SHARED_ROOT}/skills/deploy/SKILL.md`, '---\nname: deploy\ndescription: d\n---\nbody');
    await plane.rename(`${SHARED_ROOT}/skills/deploy/SKILL.md`, `${SHARED_ROOT}/skills/ship/SKILL.md`);
    expect(await plane.exists(`${SHARED_ROOT}/skills/ship/SKILL.md`)).toBe(true);

    const listed = await plane.readdirStats(`${SHARED_ROOT}/skills`);

    expect(listed).toEqual([{ name: 'ship', stat: { size: 0, mtimeMs: 1, isDir: true } }]);
    await plane.removeRecursive(`${SHARED_ROOT}/skills`);
    expect(await plane.readdir(SHARED_ROOT)).toEqual([]);
  });
});

describe('the Mossaic adapter boundary', () => {
  /** A client whose every call throws one Mossaic code. */
  function throwing(code: string): MossaicClient {
    const fail = (path: string): never => { throw new FakeMossaicError(code, path); };

    return {
      readFile: async (p) => fail(p), writeFile: async (p) => fail(p), readdir: async (p) => fail(p),
      stat: async (p) => fail(p), exists: async (p) => fail(p), unlink: async (p) => fail(p),
      mkdir: async (p) => fail(p), rmdir: async (p) => fail(p), removeRecursive: async (p) => fail(p),
      rename: async (p) => fail(p), symlink: async (_t, p) => fail(p), readlink: async (p) => fail(p),
      listChildren: async (p) => fail(p),
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
