import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initSlateLiveShareTables, SlateLiveShareStore } from '../src/slates/live-shares';
import { WorkspaceLiveShares, type WorkspaceLiveSharesDeps } from '../src/slates/live-sharing';
import { cutShareGrant, slateCapabilityGraph, type SlateBindingCatalog } from '../src/slates/capability-graph';
import { parseSlateProject } from '../src/slates/project';
import { makeExecRaw, makeSqlExec } from './helpers';
import type { ShareGrant } from '../src/slates/sharing';

const grant: ShareGrant = {
  slates: ['issues'],
  members: [
    { slate: 'issues', binding: 'FILES', member: 'readFile', effect: 'read' },
    { slate: 'issues', binding: 'FILES', member: 'writeFile', effect: 'mutate' },
  ],
};

/** The store over its own three tables and nothing else. */
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
    // Revoke is idempotent and the row stays readable through `get`.
    expect(shares.revoke('s1').revokedAt).toBe(1_002);
    expect(shares.get('s1')?.revokedAt).toBe(1_002);
    expect(() => shares.revoke('nope')).toThrow('No such share');
    // Revoked: no address, no live read.
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

    // Equal created_at orders by email.
    const withUsers = shares.addUsers(share.id, [
      { userId: 'u2', email: 'beta@example.com' },
      { userId: 'u1', email: 'alpha@example.com' },
    ]);

    expect(withUsers.users).toEqual(['alpha@example.com', 'beta@example.com']);
    // Re-adding the same user is a no-op, not a second row.
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
    const request = shares.openRequest({ share: share.id, viewer: 'user:u1', slate: 'issues', path: '/' });
    const other = shares.openRequest({ share: share.id, viewer: 'source:deadbeef', slate: 'issues', path: '/' });

    expect(request).not.toBe(other);
    shares.recordCall(request, { slate: 'issues', binding: 'FILES', member: 'readFile', effect: 'read', ok: true });
    shares.recordCall(request, { slate: 'issues', binding: 'FILES', member: 'writeFile', effect: 'mutate', ok: false });
    shares.settleRequest(request, 'closed');

    const requests = shares.requests(share.id);
    expect(requests.map((row) => row.id)).toEqual([other, request]);
    expect(requests[1]).toEqual({
      id: request, share: 's1', viewer: 'user:u1', slate: 'issues', path: '/',
      calls: [
        { slate: 'issues', binding: 'FILES', member: 'readFile', effect: 'read', ok: true },
        { slate: 'issues', binding: 'FILES', member: 'writeFile', effect: 'mutate', ok: false },
      ],
      outcome: 'closed', createdAt: expect.any(Number), settledAt: expect.any(Number),
    });
    expect(requests[0]?.outcome).toBe('open');
    expect(requests[0]?.settledAt).toBeNull();

    expect(() => shares.recordCall(99_999, { slate: 'issues', binding: 'FILES', member: 'readFile', effect: 'read', ok: true }))
      .toThrow('No viewer request 99999');
  } finally {
    db.close();
  }
});

test('WorkspaceLiveShares cuts the grant the dialog approved and opens at the host URL', async () => {
  const { db, shares } = shareDb();

  try {
    const project = parseSlateProject({
      main: 'server.js',
      slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile', 'writeFile'] } } },
    });

    const catalog = {
      executors: [{ namespace: 'workspace', members: ['readFile', 'writeFile', 'exec'] }],
      mcp: [], tools: [], tiers: [], slates: { issues: project },
    } satisfies SlateBindingCatalog;

    const deps: WorkspaceLiveSharesDeps = {
      workspace: 'my-workspace', shares,
      catalog: async () => catalog,
      shareUrl: async (handle) => `https://${handle}-token0-ws.kinu.run`,
    };

    const live = new WorkspaceLiveShares(deps);

    const expected = slateCapabilityGraph({ slate: 'issues', workspace: 'my-workspace', catalog });

    expect(await live.graph('issues')).toEqual(expected);

    const created = await live.share('issues', 'users', [{ slate: 'issues', binding: 'FILES', member: 'writeFile' }]);
    expect(created.share.handle).toMatch(/^[a-f0-9]{10}$/);
    expect(created.share.grant).toEqual(cutShareGrant(expected, [{ slate: 'issues', binding: 'FILES', member: 'writeFile' }]));
    expect(created.url).toBe(`https://${created.share.handle}-token0-ws.kinu.run`);

    expect(live.list().map((share) => share.id)).toEqual([created.share.id]);
    expect(live.byHandle(created.share.handle)?.id).toBe(created.share.id);
    expect(live.read(created.share.id)).toEqual(created.share);

    live.revoke(created.share.id);
    expect(() => live.read(created.share.id)).toThrow('no longer shared');
    expect(live.byHandle(created.share.handle)).toBeUndefined();
  } finally {
    db.close();
  }
});
