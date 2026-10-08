import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initSlateLiveShareTables, SlateLiveShareStore } from '../src/slates/live-shares';
import { shareLiveSlate } from '../src/slates/live-sharing';
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
      grant, createdAt: 1_000, revokedAt: null, users: [],
    });

    expect(shares.get('s1')).toEqual(added);
    expect(shares.get('nope')).toBeUndefined();
    expect(shares.live('s1')).toEqual(added);
    expect(shares.byHandle('0123456789')).toEqual(added);
    expect(shares.byHandle('9999999999')).toBeUndefined();
    expect(shares.list().map((share) => share.id)).toEqual(['s1']);

    const second = shares.add({ id: 's2', slate: 'digest', visibility: 'public', handle: 'abcdef0123', grant });
    expect(shares.list().map((share) => share.id)).toEqual(['s2', 's1']);

    expect(shares.revoke('s1').revokedAt).toBe(1_002);
    expect(shares.revoke('s1').revokedAt).toBe(1_002);
    expect(shares.get('s1')?.revokedAt).toBe(1_002);
    expect(() => shares.revoke('nope')).toThrow('No such share');
    expect(shares.byHandle('0123456789')).toBeUndefined();
    expect(() => shares.live('s1')).toThrow('This slate is no longer shared');
    expect(() => shares.live('nope')).toThrow('No such share');
    expect(second.revokedAt).toBeNull();
  } finally {
    db.close();
  }
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
    expect(shares.addUsers(share.id, [{ userId: 'u1', email: 'alpha@example.com' }]).users).toEqual(withUsers.users);

    expect(shares.hasUser(share.id, 'u1')).toBe(true);
    expect(shares.hasUser(share.id, 'u2')).toBe(true);
    expect(shares.hasUser(share.id, 'u3')).toBe(false);
    expect(shares.hasUser('nope', 'u1')).toBe(false);
    expect(shares.get(share.id)?.users).toEqual(['alpha@example.com', 'beta@example.com']);

    shares.revoke(share.id);
    expect(() => shares.addUsers(share.id, [{ userId: 'u3', email: 'c@example.com' }])).toThrow('no longer shared');
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
      .toThrow('No viewer request 99999');
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

    const created = await shareLiveSlate({
      shares, graph, visibility: 'users',
      approved: [{ slate: 'issues', namespace: 'workspace', member: 'writeFile' }], fork: true,
      url: async (handle) => `https://${handle}-token0-ws.kinu.run`,
    });

    expect(created.share.handle).toMatch(/^[a-f0-9]{10}$/);
    expect(grantAdmits(created.share.grant, 'issues', 'workspace', 'writeFile')?.impact).toBe('mutate');
    expect(grantAdmits(created.share.grant, 'issues', 'workspace', 'readFile')?.impact).toBe('observe');
    expect(grantAdmits(created.share.grant, 'issues', 'workspace', 'exec')).toBeNull();
    expect(created.share.grant.fork).toBe(true);
    expect(created.url).toBe(`https://${created.share.handle}-token0-ws.kinu.run`);

    expect(shares.list().map((share) => share.id)).toEqual([created.share.id]);
    expect(shares.byHandle(created.share.handle)?.id).toBe(created.share.id);
    expect(shares.live(created.share.id)).toEqual(created.share);

    shares.revoke(created.share.id);
    expect(() => shares.live(created.share.id)).toThrow('no longer shared');
    expect(shares.byHandle(created.share.handle)).toBeUndefined();
  } finally {
    db.close();
  }
});
