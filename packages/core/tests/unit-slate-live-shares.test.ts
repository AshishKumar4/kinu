import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initSlateLiveShareTables, SIGNED_OUT_VIEWER, SlateLiveShareStore } from '../src/slates/live-shares';
import { SlateShareStore } from '../src/slates/shares';
import { setShareMode, shareLiveSlate } from '../src/slates/live-sharing';
import { initSlateBuildTable, SlateBuilds } from '../src/slates/builds';
import { GALLERY_CATEGORIES, type GalleryCategory } from '../src/slates/gallery-api';
import { grantAdmits, slateCapabilityGraph } from '../src/slates/capability-graph';
import { makeExecRaw, makeSqlExec } from './helpers';
import type { ShareGrant } from '../src/slates/sharing';
import { SlateShareViewers } from '../src/slates/share-viewers';

const grant: ShareGrant = {
  slates: ['issues'],
  members: [
    { slate: 'issues', namespace: 'workspace', member: 'fs.text', impact: 'observe' },
    { slate: 'issues', namespace: 'workspace', member: 'fs.write', impact: 'mutate' },
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
  shares.markEdit('issues', 'pat@example.test');
  shares.markEdit('issues', 'sam@example.test');

  expect(shares.editMark('issues')).toEqual({ editor: 'sam@example.test' });
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

// Both kinds keep their people in one table: a blueprint's recipient is no viewer of a live share of the same id space.
test('a blueprint\'s recipient is not a live share\'s user, and a live share\'s user is the live share\'s alone', () => {
  const { db, shares } = shareDb();

  try {
    const blueprints = new SlateShareStore(makeSqlExec(db), () => 1);

    blueprints.add({ id: 'b1', slate: 'issues', publication: 'p1' });
    blueprints.addUsers('b1', [{ userId: 'u1', email: 'alpha@example.com' }]);
    shares.add(liveShare());
    shares.addUsers('s1', [{ userId: 'u2', email: 'beta@example.com' }]);

    expect([shares.hasUser('b1', 'u1'), shares.hasUser('s1', 'u2'), shares.hasUser('s1', 'u1')]).toEqual([false, true, false]);
  } finally {
    db.close();
  }
});

test('a share row holds one kind whole: a blueprint holds no live field, a live share no publication', () => {
  const { db } = shareDb();

  try {
    const insert = (row: Record<string, string | number | null>) => {
      const columns = Object.keys(row);

      db.query(`INSERT INTO slate_shares (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
    };

    const blueprint = { id: 'b1', kind: 'blueprint', slate_id: 'issues', created_at: 1, publication_id: 'p1' };
    const live = { id: 's1', kind: 'live', slate_id: 'issues', created_at: 1, visibility: 'users', handle: '0123456789', grant_json: '{}', mode: 'own' };

    insert(blueprint);
    insert(live);

    for (const mixed of [
      { ...blueprint, id: 'b2', handle: '9876543210' },
      { ...blueprint, id: 'b3', mode: 'own' },
      { ...live, id: 's2', handle: '1111111111', publication_id: 'p1' },
      { ...live, id: 's3', handle: '2222222222', grant_json: null },
    ]) {
      expect(() => { insert(mixed); }).toThrow('CHECK constraint failed');
    }
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
    shares.recordCall(request, { slate: 'issues', namespace: 'workspace', member: 'fs.text', impact: 'observe', ok: true });
    shares.recordCall(request, { slate: 'issues', namespace: 'workspace', member: 'fs.write', impact: 'mutate', ok: false });
    shares.settleRequest(request, 'closed');

    const requests = shares.requests(share.id);
    expect(requests.map((row) => row.id)).toEqual([other, request]);
    expect(requests[1]).toEqual({
      id: request, share: 's1', viewer: 'user:u1', slate: 'issues', path: '/',
      calls: [
        { slate: 'issues', namespace: 'workspace', member: 'fs.text', impact: 'observe', ok: true },
        { slate: 'issues', namespace: 'workspace', member: 'fs.write', impact: 'mutate', ok: false },
      ],
      outcome: 'closed', createdAt: expect.any(Number), settledAt: expect.any(Number),
    });
    expect(requests[0]?.outcome).toBe('open');
    expect(requests[0]?.settledAt).toBeNull();

    expect(() => shares.recordCall(99_999, { slate: 'issues', namespace: 'workspace', member: 'fs.text', impact: 'observe', ok: true }))
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

    shares.recordCall(held, { slate: 'issues', namespace: 'workspace', member: 'fs.text', impact: 'observe', ok: true });
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
      usage: () => [{ namespace: 'workspace', member: 'fs.text' }, { namespace: 'workspace', member: 'fs.write' }],
    });

    const created = shareLiveSlate({
      shares, graph, visibility: 'users',
      approved: [{ slate: 'issues', namespace: 'workspace', member: 'fs.write' }], fork: true,
      url: (share) => `https://app.kinu.run/shared/live/ws/${share}`,
    });

    expect(created.share.handle).toMatch(/^[a-f0-9]{10}$/);
    expect(grantAdmits(created.share.grant, 'issues', 'workspace', 'fs.write')?.impact).toBe('mutate');
    expect(grantAdmits(created.share.grant, 'issues', 'workspace', 'fs.text')?.impact).toBe('observe');
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
    db.exec("UPDATE slate_shares SET mode = 'owner', grant_revision = 'rev-1' WHERE id = 's2'");
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

    expect(() => db.exec("UPDATE slate_shares SET mode = 'owner' WHERE id = 's1'")).toThrow('CHECK constraint failed');
    expect(() => db.exec("UPDATE slate_shares SET grant_revision = 'rev-1' WHERE id = 's1'")).toThrow('CHECK constraint failed');
    expect(() => db.exec("UPDATE slate_shares SET mode = 'all' WHERE id = 's1'")).toThrow('CHECK constraint failed');
  } finally {
    db.close();
  }
});

test('its owner turns a share to owner mode over the reach at a built revision, and back to own', () => {
  const { db, shares } = shareDb();

  try {
    const graph = slateCapabilityGraph({
      slate: 'issues', workspace: 'my-workspace', catalog: { mcp: [], slates: ['issues'] },
      usage: () => [{ namespace: 'workspace', member: 'fs.text' }, { namespace: 'workspace', member: 'fs.write' }],
    });

    shares.add(liveShare());
    expect(() => setShareMode({ shares, share: 's1', graph, mode: 'owner', approved: [], revision: null })).toThrow('has not built yet');

    setShareMode({ shares, share: 's1', graph, mode: 'owner', approved: [{ slate: 'issues', namespace: 'workspace', member: 'fs.write' }], revision: 'rev-1' });
    expect(shares.authoritiesOf('issues')).toEqual([{ mode: 'owner', grant: expect.objectContaining({ members: grant.members }), grantRevision: 'rev-1' }]);

    setShareMode({ shares, share: 's1', graph, mode: 'own', approved: [], revision: 'rev-1' });
    expect(shares.get('s1')).toMatchObject({ mode: 'own', grantRevision: null });
  } finally {
    db.close();
  }
});

test('creating or editing a share cannot grant any computer member, and a refusal leaves its stored authority unchanged', () => {
  const { db, shares } = shareDb();

  try {
    const graph = slateCapabilityGraph({
      slate: 'issues', workspace: 'w', catalog: { mcp: [], slates: ['issues'] },
      usage: () => [{ namespace: 'computer', member: 'exec' }, { namespace: 'computer', member: 'fs.text' }],
    });

    for (const member of ['exec', 'fs.text']) {
      expect(() => shareLiveSlate({ shares, graph, visibility: 'public', approved: [{ slate: 'issues', namespace: 'computer', member }], url: () => null }))
        .toThrow(/computer.*viewer.*(?:credentials|secrets)/isu);
      expect(shares.list()).toEqual([]);
    }

    const held = shares.add(liveShare());

    for (const member of ['exec', 'fs.text']) {
      expect(() => setShareMode({ shares, share: held.id, graph, mode: 'owner', approved: [{ slate: 'issues', namespace: 'computer', member }], revision: 'r1' }))
        .toThrow(/computer.*viewer.*(?:credentials|secrets)/isu);
      expect(shares.get(held.id)).toEqual(held);
    }
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
    expect(() => db.exec(`UPDATE slate_shares SET listing_line = 'x', listing_category = 'work' WHERE id = 's1'`)).toThrow('CHECK constraint failed');
    expect(() => db.exec(`UPDATE slate_shares SET listing_line = 'x', listing_category = 'games' WHERE id = 's2'`)).toThrow('CHECK constraint failed');
    expect(() => db.exec(`UPDATE slate_shares SET listing_line = 'x', listing_category = NULL WHERE id = 's2'`)).toThrow('CHECK constraint failed');

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

test("an 'Always for this slate' approval stands on each live owner share of its slate, at one revision, until taken back", () => {
  const { db, shares } = shareDb();

  try {
    const owner = (id: string, slate = 'issues') => {
      shares.add({ ...liveShare(), id, slate, handle: `${id.padEnd(10, '0')}` });
      shares.setAuthority(id, { mode: 'owner', grantRevision: 'rev-1' }, grant);
    };

    owner('s1');
    owner('s2');
    owner('s3', 'notes');
    shares.add({ ...liveShare(), id: 's4', handle: 's400000000' });
    owner('s5');
    shares.revoke('s5');

    // Made by the slate it hops to: the entry names the caller, as grant members do, and stands on the shared slate's shares.
    const create = { slate: 'digest', namespace: 'mcp.github', member: 'create_issue', root: { repo: 'kinu', owner: 'acme' }, revision: 'rev-1' };

    // Every live owner share of the slate holds it; its own-access, revoked and other slates' shares do not.
    expect(shares.preapprove('issues', create)).toEqual(['s1', 's2']);
    expect(shares.preapprovalsOf('issues', 'rev-1')).toEqual([create]);
    expect(shares.preapprovalsOf('issues', null)).toEqual([]);
    expect([shares.get('s4')?.grant.preapproved, shares.get('s3')?.grant.preapproved, shares.get('s5')?.grant.preapproved]).toEqual([undefined, undefined, undefined]);

    // The same shape again, its root's keys in any order, is one approval.
    shares.preapprove('issues', { ...create, root: { owner: 'acme', repo: 'kinu' } });
    expect(shares.get('s1')?.grant.preapproved).toHaveLength(1);

    // One at a new revision voids the old ones: they go.
    const comment = { ...create, member: 'add_comment', revision: 'rev-2' };

    shares.preapprove('issues', comment);
    expect([shares.preapprovalsOf('issues', 'rev-1'), shares.preapprovalsOf('issues', 'rev-2')]).toEqual([[], [comment]]);

    // Taken back from every share of the slate, whatever revision it was given at.
    expect(shares.withdrawPreapproval('issues', { slate: 'digest', namespace: 'mcp.github', member: 'add_comment', root: { repo: 'kinu', owner: 'acme' } })).toEqual(['s1', 's2']);
    expect(shares.preapprovalsOf('issues', 'rev-2')).toEqual([]);
    expect(shares.withdrawPreapproval('issues', { slate: 'digest', namespace: 'mcp.github', member: 'add_comment', root: {} })).toEqual([]);
    // The rest of the grant is as it was.
    expect(shares.get('s1')?.grant).toEqual({ ...grant, preapproved: [] });
  } finally {
    db.close();
  }
});

test("a listed share's Gallery capture holds while it is listed, public and its own, and its slate's sharing has not moved", () => {
  const { db, shares } = shareDb();

  try {
    shares.add({ ...liveShare(), visibility: 'public' });
    expect(shares.galleryCapture('s1')).toBeNull();
    shares.setListing('s1', { line: 'Triage', category: 'work' });
    const capture = shares.galleryCapture('s1');

    expect(capture).toMatchObject({ slate: 'issues', handle: '0123456789' });
    expect(capture?.held()).toBe(true);
    // Unlisted, turned to the owner's access, turned back and listed again, all while a shot is taken: it holds no more.
    shares.setListing('s1', null);
    expect(capture?.held()).toBe(false);
    shares.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, grant);
    shares.setAuthority('s1', { mode: 'own', grantRevision: null }, grant);
    shares.setListing('s1', { line: 'Triage', category: 'work' });
    expect(capture?.held()).toBe(false);
    expect(shares.galleryCapture('s1')?.held()).toBe(true);

    // A share only its named people open is never taken through.
    shares.add({ id: 's2', slate: 'digest', visibility: 'users', handle: 'abcdef0123', grant });
    shares.setListing('s2', { line: 'Digest', category: 'work' });
    expect(shares.galleryCapture('s2')).toBeNull();
  } finally {
    db.close();
  }
});

test("a share's numbers: distinct people signed in, every open, and signed-out opens counted but never as people", () => {
  const { db, shares } = shareDb();

  try {
    expect(shares.views('s1')).toEqual({ viewers: 0, opens: 0, signedOutOpens: 0 });

    for (const viewer of ['key-pat', 'key-pat', 'key-lee', SIGNED_OUT_VIEWER, SIGNED_OUT_VIEWER, SIGNED_OUT_VIEWER]) shares.opened('s1', viewer);
    shares.opened('s2', 'key-pat');

    expect(shares.views('s1')).toEqual({ viewers: 2, opens: 6, signedOutOpens: 3 });
    // One row per person: what is counted is a query over them, never a total kept beside.
    expect(db.query("SELECT viewer, opens FROM slate_share_views WHERE share = 's1' ORDER BY viewer").all())
      .toEqual([{ viewer: '', opens: 3 }, { viewer: 'key-lee', opens: 1 }, { viewer: 'key-pat', opens: 2 }]);
    expect(shares.views('s2')).toEqual({ viewers: 1, opens: 1, signedOutOpens: 0 });
  } finally {
    db.close();
  }
});


// Owner decision, 2026-10-20 (account deletion): a signed-in viewer's requests are kept under the share's keyed hash of
// them, never their account, so a deleted account leaves nothing in another owner's workspace that names it, and
// nothing there needs reaching when it is deleted.
test("a signed-in viewer's requests are kept under the share's key for them, never their account", async () => {
  const { db, shares } = shareDb();

  try {
    shares.add({ ...liveShare(), visibility: 'public', grant: { slates: ['issues'], members: [] } });
    const keys: string[] = [];

    const viewers = new SlateShareViewers({
      live: shares, shareEntry: () => null,
      viewerKey: async (share, userId) => {
        keys.push(`${share}:${userId}`);

        return 'k-priya';
      },
    });

    const admission = await viewers.admit({ handle: '0123456789', claim: { userId: 'u-priya', source: 'ip', consented: true }, pathname: '/' });

    expect(admission).toMatchObject({ kind: 'admitted', viewer: { subject: 'viewer:k-priya' } });
    expect(keys).toEqual(['s1:u-priya']);
    expect(shares.requests('s1').map((request) => request.viewer)).toEqual(['viewer:k-priya']);
    expect(db.query("SELECT COUNT(*) AS n FROM slate_viewer_requests WHERE instr(viewer, 'u-priya') > 0").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

// Owner decision, 2026-10-20 (account deletion): a revoked share has no members, so none is kept naming a person after
// nothing can use it.
test('revoking a share deletes its members with it', () => {
  const { db, shares } = shareDb();

  try {
    shares.add(liveShare());
    shares.addUsers('s1', [{ userId: 'u-priya', email: 'priya.raman@example.com' }]);
    shares.revoke('s1');

    expect(db.query('SELECT COUNT(*) AS n FROM slate_share_users WHERE share_id = ?').get('s1')).toEqual({ n: 0 });
  } finally { db.close(); }
});
