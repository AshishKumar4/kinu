import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initSlateLiveShareTables, SlateLiveShareStore } from '../src/slates/live-shares';
import { setShareMode, shareLiveSlate } from '../src/slates/live-sharing';
import { initSlateBuildTable, SlateBuilds } from '../src/slates/builds';
import { GALLERY_CATEGORIES, type GalleryCategory } from '../src/slates/gallery-api';
import { grantAdmits, slateCapabilityGraph } from '../src/slates/capability-graph';
import { makeExecRaw, makeSqlExec } from './helpers';
import type { ShareGrant } from '../src/slates/sharing';

const grant: ShareGrant = {
  slates: ['issues'],
  members: [
    { slate: 'issues', namespace: 'workspace', member: 'readFile', impact: 'observe' },
    { slate: 'issues', namespace: 'workspace', member: 'writeFile', impact: 'mutate' },
  ],
};

function shareDb() {
  const db = new Database(':memory:');
  initSlateLiveShareTables(makeExecRaw(db));
  let now = 1_000;

  return { db, shares: new SlateLiveShareStore(makeSqlExec(db), () => now++) };
}

const liveShare = () => ({
  id: 's1', slate: 'issues', visibility: 'users' as const, handle: '0123456789', grant,
});

test('a live share round-trips its grant and refuses viewers once revoked', () => {
  const { db, shares } = shareDb();

  try {
    const added = shares.add(liveShare());
    expect(added).toEqual({
      id: 's1', slate: 'issues', visibility: 'users', handle: '0123456789',
      grant, createdAt: 1_000, revokedAt: null, users: [], editors: [], mode: 'own', grantRevision: null, editedBy: null, gallery: null,
    });

    expect(shares.get('s1')).toMatchObject({ id: 's1', slate: 'issues', visibility: 'users', handle: '0123456789', grant });
    expect(shares.get('nope')).toBeUndefined();
    expect(shares.live('s1')).toMatchObject({ id: 's1', slate: 'issues', visibility: 'users', handle: '0123456789', grant });
    expect(shares.byHandle('0123456789')).toMatchObject({ id: 's1', slate: 'issues', visibility: 'users', handle: '0123456789', grant });
    expect(shares.byHandle('9999999999')).toBeUndefined();
    expect(shares.list().map((share) => share.id)).toEqual(['s1']);

    const second = shares.add({ id: 's2', slate: 'digest', visibility: 'public', handle: 'abcdef0123', grant });
    expect(shares.list().map((share) => share.id)).toEqual(['s2', 's1']);

    expect(shares.revoke('s1').revokedAt).toBe(1_002);
    expect(shares.revoke('s1').revokedAt).toBe(1_002);
    expect(shares.get('s1')?.revokedAt).toBe(1_002);
    expect(() => shares.revoke('nope')).toThrow();
    expect(shares.byHandle('0123456789')).toBeUndefined();
    expect(() => shares.live('s1')).toThrow();
    expect(() => shares.live('nope')).toThrow();
    expect(second.revokedAt).toBeNull();
  } finally {
    db.close();
  }
});

test('edit attribution comes from the slate mark in every mode, never from an encoded grant revision', () => {
  const { db, shares } = shareDb();

  shares.add(liveShare());
  shares.markEdit('issues', 'pat@example.test', 'r0');
  shares.markEdit('issues', 'sam@example.test', 'r1');

  expect(shares.editMark('issues')).toEqual({ editor: 'sam@example.test', revisionBefore: 'r1' });
  expect(shares.get('s1')).toMatchObject({ mode: 'own', grantRevision: null, editedBy: 'sam@example.test' });
  expect(shares.byHandle('0123456789')?.editedBy).toBe('sam@example.test');
  expect(shares.add({ ...liveShare(), id: 's2', handle: '1123456789', authority: { mode: 'owner', grantRevision: 'r0' } }))
    .toMatchObject({ grantRevision: 'r0', editedBy: 'sam@example.test' });
  shares.restoreEditMark('issues', null);

  expect(shares.list().every((row) => row.editedBy === null)).toBe(true);
  expect(shares.get('s2')?.grantRevision).toBe('r0');
  db.close();
});

test('named users land on the share and a revoked share takes no more', () => {
  const { db, shares } = shareDb();

  try {
    const share = shares.add(liveShare());

    const withUsers = shares.addUsers(share.id, [
      { userId: 'u2', email: 'beta@example.com' },
      { userId: 'u1', email: 'alpha@example.com' },
    ]);

    expect(withUsers.users).toEqual(['alpha@example.com', 'beta@example.com']);
    expect(shares.addUsers(share.id, [{ userId: 'u1', email: 'alpha@example.com' }]).users).toEqual(['alpha@example.com', 'beta@example.com']);

    expect(shares.hasUser(share.id, 'u1')).toBe(true);
    expect(shares.hasUser(share.id, 'u2')).toBe(true);
    expect(shares.hasUser(share.id, 'u3')).toBe(false);
    expect(shares.hasUser('nope', 'u1')).toBe(false);
    expect(shares.get(share.id)?.users).toEqual(['alpha@example.com', 'beta@example.com']);

    shares.revoke(share.id);
    expect(() => shares.addUsers(share.id, [{ userId: 'u3', email: 'c@example.com' }])).toThrow();
  } finally {
    db.close();
  }
});

test('a viewer request records its calls and settles', () => {
  const { db, shares } = shareDb();

  try {
    const share = shares.add(liveShare());
    const request = shares.openRequest({ share: share.id, viewer: 'user:u1', path: '/' });
    const other = shares.openRequest({ share: share.id, viewer: 'source:deadbeef', path: '/' });

    expect(request).not.toBe(other);
    shares.recordCall(request, { slate: 'issues', namespace: 'workspace', member: 'readFile', impact: 'observe', ok: true });
    shares.recordCall(request, { slate: 'issues', namespace: 'workspace', member: 'writeFile', impact: 'mutate', ok: false });
    shares.settleRequest(request, 'closed');

    const requests = shares.requests(share.id);
    expect(requests.map((row) => row.id)).toEqual([other, request]);
    expect(requests[1]).toEqual({
      id: request, share: 's1', viewer: 'user:u1', slate: 'issues', path: '/',
      calls: [
        { slate: 'issues', namespace: 'workspace', member: 'readFile', impact: 'observe', ok: true },
        { slate: 'issues', namespace: 'workspace', member: 'writeFile', impact: 'mutate', ok: false },
      ],
      outcome: 'closed', createdAt: expect.any(Number), settledAt: expect.any(Number),
    });
    expect(requests[0]?.outcome).toBe('open');
    expect(requests[0]?.settledAt).toBeNull();

    expect(() => shares.recordCall(99_999, { slate: 'issues', namespace: 'workspace', member: 'readFile', impact: 'observe', ok: true }))
      .toThrow();
  } finally {
    db.close();
  }
});

test('a socket-held request still records its calls after a thousand newer requests', () => {
  const { db, shares } = shareDb();

  try {
    const share = shares.add(liveShare());
    const held = shares.openRequest({ share: share.id, viewer: 'user:u1', path: '/' });

    for (let n = 0; n < 1_000; n += 1) shares.settleRequest(shares.openRequest({ share: share.id, viewer: 'user:u2', path: '/' }), 'ok');

    shares.recordCall(held, { slate: 'issues', namespace: 'workspace', member: 'readFile', impact: 'observe', ok: true });
    expect(shares.requests(share.id).find((row) => row.id === held)?.calls).toHaveLength(1);
  } finally {
    db.close();
  }
});

test('sharing a live slate cuts the grant the dialog approved and opens at the host URL', async () => {
  const { db, shares } = shareDb();

  try {
    const graph = slateCapabilityGraph({
      slate: 'issues', workspace: 'my-workspace', catalog: { mcp: [], slates: ['issues'] },
      usage: () => [{ namespace: 'workspace', member: 'readFile' }, { namespace: 'workspace', member: 'writeFile' }],
    });

    const created = shareLiveSlate({
      shares, graph, visibility: 'users',
      approved: [{ slate: 'issues', namespace: 'workspace', member: 'writeFile' }], fork: true,
      url: (share) => `https://app.kinu.run/shared/live/ws/${share}`,
    });

    expect(created.share.handle).toMatch(/^[a-f0-9]{10}$/);
    expect(grantAdmits(created.share.grant, 'issues', 'workspace', 'writeFile')?.impact).toBe('mutate');
    expect(grantAdmits(created.share.grant, 'issues', 'workspace', 'readFile')?.impact).toBe('observe');
    expect(grantAdmits(created.share.grant, 'issues', 'workspace', 'exec')).toBeNull();
    expect(created.share.grant.fork).toBe(true);
    // Its one link is the app's page for it, never its bare host.
    expect(created.url).toBe(`https://app.kinu.run/shared/live/ws/${created.share.id}`);

    expect(shares.list().map((share) => share.id)).toEqual([created.share.id]);
    expect(shares.byHandle(created.share.handle)?.id).toBe(created.share.id);
    expect(shares.live(created.share.id)).toEqual(created.share);

    shares.revoke(created.share.id);
    expect(() => shares.live(created.share.id)).toThrow();
    expect(shares.byHandle(created.share.handle)).toBeUndefined();
  } finally {
    db.close();
  }
});

test('a slate\'s live shares say what its server acts with, a revoked one nothing', () => {
  const { db, shares } = shareDb();

  try {
    shares.add(liveShare());
    shares.add({ ...liveShare(), id: 's2', handle: '1123456789' });
    db.exec("UPDATE slate_live_shares SET mode = 'owner', grant_revision = 'rev-1' WHERE id = 's2'");
    shares.add({ ...liveShare(), id: 's3', handle: '2123456789' });
    shares.revoke('s3');
    shares.add({ ...liveShare(), id: 'other', slate: 'other', handle: '3123456789' });

    expect(shares.authoritiesOf('issues')).toEqual([
      { mode: 'own', grant, grantRevision: null },
      { mode: 'owner', grant, grantRevision: 'rev-1' },
    ]);
    expect(shares.authoritiesOf('nothing')).toEqual([]);
  } finally {
    db.close();
  }
});

test('an owner share names the revision its reach was approved for, and an own share names none', () => {
  const { db, shares } = shareDb();

  try {
    shares.add(liveShare());

    expect(() => db.exec("UPDATE slate_live_shares SET mode = 'owner' WHERE id = 's1'")).toThrow('CHECK constraint failed');
    expect(() => db.exec("UPDATE slate_live_shares SET grant_revision = 'rev-1' WHERE id = 's1'")).toThrow('CHECK constraint failed');
    expect(() => db.exec("UPDATE slate_live_shares SET mode = 'all' WHERE id = 's1'")).toThrow('CHECK constraint failed');
  } finally {
    db.close();
  }
});

test('its owner turns a share to owner mode over the reach at a built revision, and back to own', () => {
  const { db, shares } = shareDb();

  try {
    const graph = slateCapabilityGraph({
      slate: 'issues', workspace: 'my-workspace', catalog: { mcp: [], slates: ['issues'] },
      usage: () => [{ namespace: 'workspace', member: 'readFile' }, { namespace: 'workspace', member: 'writeFile' }],
    });

    shares.add(liveShare());
    expect(() => setShareMode({ shares, share: 's1', graph, mode: 'owner', approved: [], revision: null })).toThrow('has not built yet');

    setShareMode({ shares, share: 's1', graph, mode: 'owner', approved: [{ slate: 'issues', namespace: 'workspace', member: 'writeFile' }], revision: 'rev-1' });
    expect(shares.authoritiesOf('issues')).toEqual([{ mode: 'owner', grant: expect.objectContaining({ members: grant.members }), grantRevision: 'rev-1' }]);

    setShareMode({ shares, share: 's1', graph, mode: 'own', approved: [], revision: 'rev-1' });
    expect(shares.get('s1')).toMatchObject({ mode: 'own', grantRevision: null });
  } finally {
    db.close();
  }
});

test('a slate\'s build record tells its listener only when the code it serves moves', () => {
  const db = new Database(':memory:');
  initSlateBuildTable(makeExecRaw(db));
  const builds = new SlateBuilds(makeSqlExec(db));
  const moved: string[] = [];

  builds.whenBuilt((slate, authority, key) => { moved.push(`${slate}:${authority}:${key}`); });
  builds.built('issues', 'root', 'k1', { modules: {} });
  builds.built('issues', 'root', 'k1', { modules: {} });
  builds.built('issues', 'root', 'k2', { modules: {} });

  expect(moved).toEqual(['issues:root:k1', 'issues:root:k2']);
});

test('a live share is listed with its card\'s words while on its viewers\' own access, once per slate, and nowhere once revoked', () => {
  const { db, shares } = shareDb();

  try {
    const card = { line: 'Triage the open issues', category: 'work' } satisfies { line: string; category: GalleryCategory };

    shares.add(liveShare());
    shares.add({ ...liveShare(), id: 's2', handle: '9876543210' });

    expect(shares.setListing('s1', card)).toBe(true);
    expect(shares.get('s1')?.gallery).toEqual(card);

    // One listing per slate: listing another share of it takes the first off.
    expect(shares.setListing('s2', { ...card, category: 'fun' })).toBe(true);
    expect([shares.get('s1')?.gallery, shares.get('s2')?.gallery]).toEqual([null, { ...card, category: 'fun' }]);

    // Never on the owner's access: the store refuses, and the table refuses a row that would say so.
    shares.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, grant);
    expect(shares.setListing('s1', card)).toBe(false);
    expect(() => db.exec(`UPDATE slate_live_shares SET listing_line = 'x', listing_category = 'work' WHERE id = 's1'`)).toThrow('CHECK constraint failed');
    expect(() => db.exec(`UPDATE slate_live_shares SET listing_line = 'x', listing_category = 'games' WHERE id = 's2'`)).toThrow('CHECK constraint failed');
    expect(() => db.exec(`UPDATE slate_live_shares SET listing_line = 'x', listing_category = NULL WHERE id = 's2'`)).toThrow('CHECK constraint failed');

    // Every category the Gallery offers is one the table keeps.
    for (const category of GALLERY_CATEGORIES) expect(shares.setListing('s2', { ...card, category })).toBe(true);

    shares.revoke('s2');
    expect(shares.get('s2')?.gallery).toBeNull();
    expect(shares.setListing('s2', card)).toBe(false);
  } finally {
    db.close();
  }
});

test('people are added to use a slate or to edit it too, a role named again replaces the last, and a revoked share edits nothing', () => {
  const { db, shares } = shareDb();

  try {
    shares.add(liveShare());
    expect(shares.isShared('issues')).toBe(true);
    expect(shares.hasEditors('issues')).toBe(false);

    const added = shares.addUsers('s1', [{ userId: 'u-pat', email: 'pat@example.test', role: 'edit' }, { userId: 'u-sam', email: 'sam@example.test' }]);

    expect(added).toMatchObject({ users: ['pat@example.test', 'sam@example.test'], editors: ['pat@example.test'] });
    expect([shares.editsSlate('issues', 'u-pat'), shares.editsSlate('issues', 'u-sam'), shares.editsSlate('other', 'u-pat')]).toEqual([true, false, false]);

    // Named again to use it: Pat no longer edits it.
    expect(shares.addUsers('s1', [{ userId: 'u-pat', email: 'pat@example.test', role: 'use' }]).editors).toEqual([]);
    expect(shares.editsSlate('issues', 'u-pat')).toBe(false);

    shares.addUsers('s1', [{ userId: 'u-pat', email: 'pat@example.test', role: 'edit' }]);
    shares.revoke('s1');
    expect([shares.editsSlate('issues', 'u-pat'), shares.hasEditors('issues'), shares.isShared('issues')]).toEqual([false, false, false]);
  } finally {
    db.close();
  }
});
