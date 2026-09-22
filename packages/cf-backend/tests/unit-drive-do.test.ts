/**
 * The Drive on the user's own Durable Object via RPC: the tenant derives from the signed-in profile, never a caller;
 * a workspace token is refused before any tenant is touched; an out-of-order chunk is refused, not appended.
 */
import { describe, expect, test } from 'bun:test';
import {
  CapabilityDeniedError, DRIVE_SKILLS_DIR, mossaicVfs, packZip, unpackZip, type DriveUploadOutcome, type UserCaller,
} from '@kinu.run/core';
import type { DriveAnswer } from '../src/user/user-do';
import { fakeMossaic, type FakeMossaic } from '@kinu.run/test-utils';
import { deriveUserId } from '../src/auth/store';
import { USER_DO_RPC_SURFACE } from '../src/rpc-surface';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';
import { driveBound, tenantDrive, type MossaicObject } from '../src/drive/tenant';

const SKILL = (name: string): string => `---\nname: ${name}\ndescription: ${name} does things\n---\nSteps.`;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

async function signedIn(mossaic: FakeMossaic, email: string, id: string): Promise<TestUserDO> {
  const harness = createTestUserDO({ durableObjectId: id, drive: (tenant) => mossaicVfs(mossaic.tenant(tenant)) });
  await harness.userDO.ensureProfile(await testOwner(), email);

  return harness;
}

/** One whole upload, sent as the route sends it: chunks in order, the last one final. */
async function upload(harness: TestUserDO, owner: UserCaller, path: string, parts: readonly Uint8Array[]) {
  const transferId = crypto.randomUUID();
  let offset = 0;
  let last: DriveAnswer<DriveUploadOutcome> = { ok: true, value: { ok: true } };

  for (const [index, part] of parts.entries()) {
    last = await harness.userDO.drive_writeChunk(owner, { target: { kind: 'file', path }, transferId, offset, chunk: part, final: index === parts.length - 1 });
    offset += part.byteLength;
  }

  return last;
}

describe('the Drive\'s bindings', () => {
  // Measured on the deployed build 2026-09-21: both objects bound, no secret, every listing answered 500
  // from the tenant object. A Drive that cannot list is absent at the seam, not met on a route.
  test('two objects without the signing secret are no Drive', () => {
    const refusing = (binding: string): MossaicObject => ({
      idFromName: (name) => { throw new Error(`${binding}.idFromName(${name}): not reachable in this test`); },
      get: (id) => { throw new Error(`${binding}.get(${id.toString()}): not reachable in this test`); },
    });

    const objects = { MOSSAIC_USER: refusing('MOSSAIC_USER'), MOSSAIC_SHARD: refusing('MOSSAIC_SHARD') };

    expect(driveBound(objects)).toBe(false);
    expect(driveBound({ ...objects, JWT_SECRET: '' })).toBe(false);
    expect(tenantDrive({ ...objects, JWT_SECRET: '' }, 'tenant')).toBeNull();
    expect(driveBound({ ...objects, JWT_SECRET: 'signs-the-cursors' })).toBe(true);
    expect(driveBound({ JWT_SECRET: 'signs-the-cursors' })).toBe(false);
  });
});

describe('the Drive on the UserDO', () => {
  test('the tenant is the profile\'s own; the other user\'s object reaches none of it', async () => {
    const mossaic = fakeMossaic();
    const owner = await testOwner();
    const alice = await signedIn(mossaic, 'alice@example.com', 'do-alice');
    const bob = await signedIn(mossaic, 'bob@example.com', 'do-bob');

    expect(await upload(alice, owner, '/notes.txt', [bytes('alice '), bytes('only')])).toEqual({ ok: true, value: { ok: true } });
    expect(await alice.userDO.drive_mkdir(owner, '/projects')).toEqual({ ok: true, value: undefined });

    const listed = await alice.userDO.drive_list(owner, '/');

    expect(listed.ok && listed.value.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ['blueprints', 'folder'], ['projects', 'folder'], ['skills', 'folder'], ['notes.txt', 'file'],
    ]);

    // Keyed by the id the edge derives from the email, so the workspace mount reads the same store.
    expect([...mossaic.stores.keys()]).toEqual([await deriveUserId('alice@example.com')]);
    expect(mossaic.stores.get(await deriveUserId('alice@example.com'))?.size).toBe(1);

    const bobs = await bob.userDO.drive_list(owner, '/');

    expect([...mossaic.stores.keys()]).toEqual([await deriveUserId('alice@example.com'), await deriveUserId('bob@example.com')]);

    expect(bobs.ok && bobs.value.entries.map((entry) => entry.name)).toEqual(['blueprints', 'skills']);
    expect(await bob.userDO.drive_startDownload(owner, '/notes.txt', 't1')).toMatchObject({ ok: false, code: 'missing' });
    expect(await bob.userDO.drive_delete(owner, '/notes.txt')).toMatchObject({ ok: false, code: 'missing' });
    expect(await bob.userDO.drive_rename(owner, '/projects', '/mine')).toMatchObject({ ok: false, code: 'missing' });
    expect(await bob.userDO.drive_markAsSkill(owner, '/projects')).toMatchObject({ ok: false, code: 'bad_input' });

    const again = await alice.userDO.drive_list(owner, '/');

    expect(again.ok && again.value.entries.map((entry) => entry.name)).toEqual(['blueprints', 'projects', 'skills', 'notes.txt']);
    alice.close();
    bob.close();
  });

  test('a workspace token is refused at the boundary; the surface lists every Drive method', async () => {
    const mossaic = fakeMossaic();
    const harness = await signedIn(mossaic, 'alice@example.com', 'do-alice');
    const token = await provisionTestWorkspace(harness, 'ws-a', 'Workspace A');
    const workspace: UserCaller = { workspaceToken: token };

    await expect(harness.userDO.drive_list(workspace, '/')).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(harness.userDO.drive_writeChunk(workspace, { target: { kind: 'file', path: '/x' }, transferId: 't', offset: 0, chunk: bytes('x'), final: true }))
      .rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(mossaic.stores.size).toBe(0);

    const methods = ['drive_list', 'drive_mkdir', 'drive_rename', 'drive_delete', 'drive_markAsSkill', 'drive_addSkill',
      'drive_writeChunk', 'drive_abortUpload', 'drive_startDownload', 'drive_readChunk', 'drive_abortDownload'];

    for (const method of methods) expect(USER_DO_RPC_SURFACE).toContain(method);
    harness.close();
  });

  test('bytes cross as ordered chunks both ways; an out-of-order chunk is refused, not appended', async () => {
    const owner = await testOwner();
    const harness = await signedIn(fakeMossaic(), 'alice@example.com', 'do-alice');
    const transferId = crypto.randomUUID();
    const target = { kind: 'file', path: '/big.bin' } as const;

    expect(await harness.userDO.drive_writeChunk(owner, { target, transferId, offset: 0, chunk: bytes('abc'), final: false })).toEqual({ ok: true, value: { ok: true } });
    expect(await harness.userDO.drive_writeChunk(owner, { target, transferId, offset: 7, chunk: bytes('zzz'), final: true }))
      .toMatchObject({ ok: false, code: 'bad_input', error: expect.stringContaining('out of sync') });
    expect(await harness.userDO.drive_writeChunk(owner, { target: { kind: 'file', path: '/other' }, transferId, offset: 3, chunk: bytes('x'), final: true }))
      .toMatchObject({ ok: false, code: 'bad_input' });
    expect(await harness.userDO.drive_writeChunk(owner, { target, transferId, offset: 3, chunk: bytes('def'), final: true })).toEqual({ ok: true, value: { ok: true } });

    const opened = await harness.userDO.drive_startDownload(owner, '/big.bin', 'd1');

    expect(opened).toEqual({ ok: true, value: { size: 6, name: 'big.bin' } });
    const first = await harness.userDO.drive_readChunk(owner, 'd1', 0, 4);
    const second = await harness.userDO.drive_readChunk(owner, 'd1', 4, 4);

    expect(first.ok && new TextDecoder().decode(first.value.bytes)).toBe('abcd');
    expect(second.ok && new TextDecoder().decode(second.value.bytes)).toBe('ef');
    expect(await harness.userDO.drive_readChunk(owner, 'd1', 0, 4)).toMatchObject({ ok: false, code: 'bad_input' });
    harness.close();
  });

  test('a zip lands as a folder, a skill lands under /skills, a folder downloads as one zip', async () => {
    const owner = await testOwner();
    const harness = await signedIn(fakeMossaic(), 'alice@example.com', 'do-alice');
    const archive = packZip([{ path: 'deploy/SKILL.md', bytes: bytes(SKILL('deploy')) }, { path: 'deploy/run.sh', bytes: bytes('echo') }]);

    expect(await harness.userDO.drive_writeChunk(owner, { target: { kind: 'zip', folder: '/unpacked' }, transferId: 'u1', offset: 0, chunk: archive, final: true }))
      .toEqual({ ok: true, value: { ok: true } });
    expect(await harness.userDO.drive_writeChunk(owner, { target: { kind: 'skill', name: null }, transferId: 'u2', offset: 0, chunk: archive, final: true }))
      .toEqual({ ok: true, value: { ok: true, skill: { name: 'deploy', linked: `${DRIVE_SKILLS_DIR}/deploy` } } });
    expect(await harness.userDO.drive_writeChunk(owner, { target: { kind: 'skill', name: null }, transferId: 'u3', offset: 0, chunk: archive, final: true }))
      .toMatchObject({ ok: false, code: 'denied', error: expect.stringContaining('already exists') });
    expect(await harness.userDO.drive_addSkill(owner, SKILL('triage'))).toEqual({ ok: true, value: { name: 'triage', linked: `${DRIVE_SKILLS_DIR}/triage` } });
    expect(await harness.userDO.drive_addSkill(owner, 'no front matter')).toMatchObject({ ok: false, code: 'bad_input' });
    expect(await harness.userDO.drive_markAsSkill(owner, '/unpacked/deploy')).toMatchObject({ ok: false, code: 'denied' });
    expect(await harness.userDO.drive_delete(owner, DRIVE_SKILLS_DIR)).toMatchObject({ ok: false, code: 'denied' });

    const opened = await harness.userDO.drive_startDownload(owner, '/unpacked', 'd2');

    expect(opened.ok && opened.value.name).toBe('unpacked.zip');
    const chunk = await harness.userDO.drive_readChunk(owner, 'd2', 0, opened.ok ? opened.value.size : 0);

    expect(chunk.ok && (await unpackZip(chunk.value.bytes)).map((entry) => entry.path)).toEqual(['deploy/SKILL.md', 'deploy/run.sh']);
    harness.close();
  });

  test('an unbound deployment and an unsigned object each state their absence', async () => {
    const owner = await testOwner();
    const unbound = createTestUserDO({ drive: () => null });
    await unbound.userDO.ensureProfile(owner, 'alice@example.com');
    expect(await unbound.userDO.drive_list(owner, '/')).toMatchObject({ ok: false, code: 'unavailable' });
    unbound.close();

    const unsigned = createTestUserDO({ drive: (tenant) => mossaicVfs(fakeMossaic().tenant(tenant)) });
    expect(await unsigned.userDO.drive_list(owner, '/')).toMatchObject({ ok: false, code: 'missing' });
    unsigned.close();
  });
});
