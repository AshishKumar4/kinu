import { expect, test } from 'bun:test';
import { ByteRange } from '@agent-core/core/content';
import { CHUNK_SIZE } from '@nimbus-sh/core/constants.js';
import { WorkspaceSlateContentStore } from '../src/slates/content';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { createTestWorkspace, createWorkspaceBundle } from './helpers';

const SLATE_CONTENT_ROOT = '/etc/kinu-slate-content';

test('Slate content retains exact bytes and ranges in the workspace VFS', async () => {
  const ws = createTestWorkspace();

  try {
    const session = await createWorkspaceBundle(ws.db).session();
    const content = new WorkspaceSlateContentStore(session.vfs.as(CRED_KERNEL));
    const bytes = Uint8Array.from({ length: CHUNK_SIZE + 7 }, (_, index) => index % 251);
    const stored = await content.put(bytes);
    bytes.fill(0);
    const reopened = new WorkspaceSlateContentStore(session.vfs.as(CRED_KERNEL));
    const expected = Uint8Array.from({ length: CHUNK_SIZE + 7 }, (_, index) => index % 251);
    expect(await reopened.get(stored.ref)).toEqual(expected);
    expect(await reopened.get(stored.ref, ByteRange.slice(CHUNK_SIZE - 3, 8))).toEqual(expected.slice(CHUNK_SIZE - 3, CHUNK_SIZE + 5));
    expect((await reopened.put(expected)).ref.value).toBe(stored.ref.value);
    expect((await reopened.stat(stored.ref))?.size).toBe(expected.length);
    await expect(reopened.get(stored.ref, ByteRange.slice(expected.length, 1))).rejects.toThrow();
    const path = SLATE_CONTENT_ROOT + '/' + stored.digest.value;
    const user = session.vfs.as(CRED_SESSION_USER);
    expect(() => user.writeFile(path, 'tamper')).toThrow();
    expect(() => user.unlink(path)).toThrow();
    expect(() => user.rename(SLATE_CONTENT_ROOT, SLATE_CONTENT_ROOT + '-moved')).toThrow();
    session.vfs.as(CRED_KERNEL).unlink(path);
    await expect(reopened.get(stored.ref)).rejects.toThrow('Slate content not found');
  } finally {
    ws.db.close();
  }
});

test('retained objects participate in VFS rollback without a stale cache', async () => {
  const ws = createTestWorkspace();

  try {
    const session = await createWorkspaceBundle(ws.db).session();
    const content = new WorkspaceSlateContentStore(session.vfs.as(CRED_KERNEL));
    const bytes = new TextEncoder().encode('not committed');
    let retained: Awaited<ReturnType<typeof content.put>> | undefined;

    expect(() => session.vfs.withTransaction(() => {
      retained = content.retain(bytes);
      throw new Error('abort source capture');
    })).toThrow();

    if (retained === undefined) throw new Error('capture did not reach retain');
    expect(await content.stat(retained.ref)).toBeUndefined();
    const committed = content.retain(bytes);
    expect(await content.get(committed.ref)).toEqual(bytes);
  } finally {
    ws.db.close();
  }
});

test('retention refuses a pre-existing path with mutable ownership or a symlink', async () => {
  const ws = createTestWorkspace();

  try {
    const session = await createWorkspaceBundle(ws.db).session();
    const kernel = session.vfs.as(CRED_KERNEL);
    kernel.mkdir(SLATE_CONTENT_ROOT, { mode: 0o700 });
    kernel.chown(SLATE_CONTENT_ROOT, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
    expect(() => new WorkspaceSlateContentStore(kernel)).toThrow('not kernel-owned and protected');
    kernel.chown(SLATE_CONTENT_ROOT, 0, 0);
    const content = new WorkspaceSlateContentStore(kernel);
    const retained = content.retain(new Uint8Array([42]));
    const path = SLATE_CONTENT_ROOT + '/' + retained.digest.value;
    kernel.unlink(path);
    kernel.symlink('/etc/passwd', path);
    expect(() => content.retain(new Uint8Array([42]))).toThrow('not kernel-owned and protected');
  } finally {
    ws.db.close();
  }
});
