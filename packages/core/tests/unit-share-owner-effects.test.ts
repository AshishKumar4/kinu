// A shared slate's server is one principal (docs/SLATE-SHARING-NIMBUS.md §2): whoever's request it serves, the owner's
// own included, it acts with what its shares lend it now, read again at the very send. Each call of it that acts runs
// only on the owner's approval of that exact call, taken once, or on their pre-approval of that tool and root at this
// revision. The owner's queue is the workspace's own deferred approvals, as the orchestrator hands it over.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import { createTestActors } from '@kinu.run/test-utils';
import { initSlateLiveShareTables, SlateLiveShareStore } from '../src/slates/live-shares';
import { SlateShareViewers } from '../src/slates/share-viewers';
import { SharedServers, type SharedServerDeps } from '../src/slates/shared-server';
import { approvalKindOf, DeferredApprovalQueue, DeferredApprovalStore, initOwnerRequestsTable } from '../src/index';
import { preapproveSlateEffect } from '../src/slates/live-sharing';
import { settle } from '../src/obs/effect';
import type { ShareGrant } from '../src/slates/sharing';
import type { JsonValue } from '../src/utils/json';
import { slateCallAddress } from '../src/slates/surface';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers';

const grant: ShareGrant = {
  slates: ['board', 'digest'],
  members: [
    { slate: 'board', namespace: 'workspace', member: 'fs.text', impact: 'observe' },
    { slate: 'board', namespace: 'workspace', member: 'fs.write', impact: 'mutate' },
    { slate: 'board', namespace: 'web', member: 'connectBrowser', impact: 'execute' },
    { slate: 'digest', namespace: 'workspace', member: 'fs.text', impact: 'observe' },
  ],
};

/** Whether each member the owner's own requests call acts. */
const IMPACTS = new Map([['fs.text', false], ['fs.write', true], ['web.connectBrowser', true]]);

/** `revisions` is each slate's revision now; the share approved `board`'s at `rev-1`. */
function world(mode: 'own' | 'owner', revisions: Readonly<Record<string, string>> = { board: 'rev-1', digest: 'rev-9' }, toolContract?: SharedServerDeps['toolContract']) {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);

  initSlateLiveShareTables(execRaw);
  initOwnerRequestsTable(execRaw);
  const live = new SlateLiveShareStore(makeSqlExec(db));
  const sql = makeSql(db);

  const remembered: unknown[] = [];

  const queue = new DeferredApprovalQueue({
    store: new DeferredApprovalStore(sql, createTestActors(sql, execRaw).main), writes: null, remember: (grants) => { remembered.push(...grants); }, wake: () => Effect.void,
    // As the orchestrator hands it over: the owner's "Always for this slate" stands on the slate's owner shares.
    preapprove: async (effect) => { preapproveSlateEffect(live, effect); },
  });

  live.add({ id: 's1', slate: 'board', visibility: 'public', handle: '0123456789', grant });

  if (mode === 'owner') live.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, grant);

  const ownerEffects = { ask: queue.slateEffect.bind(queue), take: queue.takeSlateEffect.bind(queue), settle: async (...settled: Parameters<typeof queue.settle>) => queue.settle(...settled) };

  const servers = new SharedServers({
    authoritiesOf: (slate) => live.authoritiesOf(slate), revision: (slate) => revisions[slate] ?? null, generation: (slate) => live.generation(slate), ownerEffects,
    ...(toolContract !== undefined && { toolContract }),
  }, async () => 'Sam');

  const viewers = new SlateShareViewers({ live, shareEntry: () => null, ownerUserId: () => 'sam', ownerEffects });
  const ran: string[] = [];

  /** `meanwhile`: what changes while the dispatch prepares, before it sends; the dispatch admits the call just before it acts. */
  const call = (member: string, options: { subject?: string; authorize?: true; slate?: string; chain?: string[]; args?: JsonValue[]; fails?: true; meanwhile?: () => void } = {}) => {
    const subject = options.subject ?? 'user:ana';
    const slate = options.slate ?? 'board';
    const chain = options.chain ?? [];
    const args = options.args ?? [{ path: 'notes.md', text: 'hello' }];

    return viewers.call({
      share: 's1', id: slate, chain,
      request: { path: member.split('.'), args, invocation: null, ...(options.authorize && { authorize: options.authorize }) },
      issued: { id: slate, chain, incarnation: 'p1', generations: {}, viewer: { share: 's1', subject, request: live.openRequest({ share: 's1', viewer: subject, path: '/' }) } },
      gate: (routed) => servers.gate({ slate, chain, address: routed.address, effect: routed.effect, args, on: subject }),
      bound: (address) => servers.bounded({ slate, chain, address }),
      run: async (_route, _nested, admit) => {
        options.meanwhile?.();
        admit();
        ran.push(`${subject}:${member}`);

        if (options.fails) throw new Error('the call failed after it was handed on');

        return { ok: true, value: { done: true } };
      },
    });
  };

  /** The owner's own request to their shared slate: the server's like any other. */
  const ownersCall = async (member: string, args: JsonValue[] = [{ path: 'notes.md', text: 'hello' }]) => {
    const address = slateCallAddress(member.split('.'));
    const send = await settle(servers.gate({ slate: 'board', chain: [], address, effect: IMPACTS.get(member) ?? true, args, on: 'the owner' }));
    const spend = send.admit();

    ran.push(`owner:${member}`);

    if (spend !== null) await queue.settle(spend, 'spent');

    return send.bounded;
  };

  // The owner's decision stack: what the shared slate asked of them, as their Work tab lists it.
  const asked = () => queue.list().map((row) => approvalKindOf(row));
  const approveAll = async (answer: 'approved' | 'always' = 'approved') => queue.decide(queue.list().map((row) => row.id), answer);

  return { call, ownersCall, ran, asked, approveAll, live, queue, servers, remembered };
}

test('an owner share\'s acting call waits for the owner, then runs once on their approval', async () => {
  const { call, ran, asked, approveAll } = world('owner');

  await expect(call('fs.write')).rejects.toThrow('waits for the owner to approve it: fs.write on workspace');
  expect(asked().map((kind) => (kind.kind === 'slate-effect' ? [kind.effect.slate, kind.effect.caller, kind.effect.tool, kind.effect.viewer, kind.effect.revision, kind.effect.payload] : kind.kind)))
    .toEqual([['board', 'board', 'fs.write', 'user:ana', 'rev-1', { path: 'notes.md', text: 'hello' }]]);
  expect(ran).toEqual([]);

  await approveAll();
  expect(await call('fs.write')).toMatchObject({ ok: true });
  // Spent: the same call made again is asked of the owner again.
  await expect(call('fs.write')).rejects.toThrow('waits for the owner');
  expect({ ran, asked: asked().length }).toEqual({ ran: ['user:ana:fs.write'], asked: 1 });
});

test('an approval is spent once its call is handed on, even when the call fails after', async () => {
  const { call, ran, asked, approveAll } = world('owner');

  await expect(call('fs.write')).rejects.toThrow('waits for the owner');
  await approveAll();
  await expect(call('fs.write', { fails: true })).rejects.toThrow('the call failed after it was handed on');
  await expect(call('fs.write')).rejects.toThrow('waits for the owner');
  expect({ ran, asked: asked().length }).toEqual({ ran: ['user:ana:fs.write'], asked: 1 });
});

test('an approval admits the exact call it was asked for, and no other payload', async () => {
  const { call, ran, approveAll } = world('owner');

  await expect(call('fs.write')).rejects.toThrow('waits for the owner');
  await approveAll();
  await expect(call('fs.write', { args: [{ path: 'notes.md', text: 'something else' }] })).rejects.toThrow('waits for the owner');
  expect(ran).toEqual([]);
});

test("one principal. the owner's own request to their shared slate asks them for each effect too; an observing call asks no one", async () => {
  const owned = world('owner');

  expect(await owned.call('fs.text')).toMatchObject({ ok: true });
  await expect(owned.ownersCall('fs.write')).rejects.toThrow('waits for the owner to approve it: fs.write on workspace');
  expect(owned.asked().map((kind) => (kind.kind === 'slate-effect' ? kind.effect.viewer : null))).toEqual(['the owner']);
  await owned.approveAll();
  expect(await owned.ownersCall('fs.write')).toBe(true);
  expect(owned.ran).toEqual(['user:ana:fs.text', 'owner:fs.write']);
});

test("an own share lends its server nothing, for anyone, and says who can turn on My access", async () => {
  const own = world('own');

  await expect(own.call('fs.text')).rejects.toThrow('Sam can turn on My access');
  await expect(own.ownersCall('fs.write')).rejects.toThrow('can turn on My access');
  expect({ ran: own.ran, asked: own.asked() }).toEqual({ ran: [], asked: [] });
});

test('an owner share whose slate moved past the approved revision lends nothing, observing or not, the owner\'s own request included', async () => {
  const { call, ownersCall, ran, asked } = world('owner', { board: 'rev-2', digest: 'rev-9' });

  await expect(call('fs.text')).rejects.toThrow('changed since its owner approved what it reaches');
  await expect(call('fs.write')).rejects.toThrow('changed since its owner approved what it reaches');
  await expect(ownersCall('fs.write')).rejects.toThrow('changed since its owner approved what it reaches');
  expect({ ran, asked: asked().length }).toEqual({ ran: [], asked: 0 });
});

test("a call from a slate the shared one hops to is held to the shared server's grant and revision, not its own", async () => {
  const { call, servers } = world('owner');

  expect(await call('fs.text', { slate: 'digest', chain: ['board'] })).toMatchObject({ ok: true });
  // The hop's own leaf the shared server's grant does not reach: refused, whoever the share is.
  await expect(call('fs.write', { slate: 'digest', chain: ['board'] })).rejects.toThrow(/does not (grant|reach) workspace\.fs\.write/u);
  expect(() => { servers.within({ slate: 'digest', chain: ['board'], address: { namespace: 'workspace', member: 'fs.write' } }); }).toThrow('does not reach');
});

test("a browser member the class runs waits on the owner when the host is asked to authorize it, and its refusal report asks nothing", async () => {
  const { call, ran, asked, approveAll } = world('owner');

  await expect(call('web.connectBrowser', { authorize: true, args: ['kitesurf'] })).rejects.toThrow('waits for the owner to approve it: connectBrowser on web');
  expect(asked().map((kind) => (kind.kind === 'slate-effect' ? kind.effect.payload : null))).toEqual(['kitesurf']);
  await approveAll();
  expect(await call('web.connectBrowser', { authorize: true, args: ['kitesurf'] })).toMatchObject({ ok: true });

  // What the class hands its host member when its own run failed: no effect, so nothing is asked.
  expect(await call('web.connectBrowser', { args: [{ refused: 'no socket', reason: 'unavailable' }] })).toMatchObject({ ok: true });
  expect({ ran, asked: asked().length }).toEqual({ ran: ['user:ana:web.connectBrowser', 'user:ana:web.connectBrowser'], asked: 0 });
});

test('a call whose share stops lending while its dispatch prepares never acts, and takes no approval', async () => {
  const revoked = world('owner');

  await expect(revoked.call('fs.write')).rejects.toThrow('waits for the owner');
  await revoked.approveAll();
  await expect(revoked.call('fs.write', { meanwhile: () => { revoked.live.revoke('s1'); } })).rejects.toThrow('no longer shared');
  await expect(revoked.call('fs.text', { meanwhile: () => { revoked.live.revoke('s1'); } })).rejects.toThrow('no longer shared');
  expect({ ran: revoked.ran, approved: revoked.queue.list().length }).toEqual({ ran: [], approved: 0 });

  // Turned back to each viewer's own access mid-call: what was admitted on the owner's access is not sent on it.
  const turned = world('owner');

  await expect(turned.call('fs.write')).rejects.toThrow('waits for the owner');
  await turned.approveAll();
  await expect(turned.call('fs.write', { meanwhile: () => { turned.live.setAuthority('s1', { mode: 'own', grantRevision: null }, grant); } })).rejects.toThrow('changed how it lends');
  expect(turned.ran).toEqual([]);

  // Its approval retired mid-call (the server's revision moved, or its owner took it back).
  const retired = world('owner');

  await expect(retired.call('fs.write')).rejects.toThrow('waits for the owner');
  await retired.approveAll();
  await expect(retired.call('fs.write', { meanwhile: () => { retired.queue.retireSlateEffects('board'); } })).rejects.toThrow('taken back');
  expect(retired.ran).toEqual([]);
});

test('a call on one share fails closed when another share of the same server stops lending while it prepares', async () => {
  const both = world('owner');

  both.live.add({ id: 's2', slate: 'board', visibility: 'public', handle: '9876543210', grant });
  both.live.setAuthority('s2', { mode: 'owner', grantRevision: 'rev-1' }, grant);
  expect(await both.call('fs.text')).toMatchObject({ ok: true });
  // s2 turns to each viewer's own access: the server lends nothing now, so s1's call is not sent either.
  await expect(both.call('fs.text', { meanwhile: () => { both.live.setAuthority('s2', { mode: 'own', grantRevision: null }, grant); } })).rejects.toThrow('can turn on My access');
});

test('a pre-approved tool and root run unasked at that revision only; another root, or another revision, asks', async () => {
  const pre = world('owner');
  const preapproved: ShareGrant = { ...grant, preapproved: [{ slate: 'board', namespace: 'workspace', member: 'fs.write', root: {}, revision: 'rev-1' }] };

  pre.live.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, preapproved);
  expect(await pre.call('fs.write')).toMatchObject({ ok: true });
  expect(await pre.ownersCall('fs.write')).toBe(true);
  expect(pre.asked()).toEqual([]);

  const stale = world('owner');

  stale.live.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, { ...grant, preapproved: [{ ...preapproved.preapproved?.[0] ?? { slate: '', namespace: '', member: '', root: {} }, revision: 'rev-0' }] });
  await expect(stale.call('fs.write')).rejects.toThrow('waits for the owner');
});

test('R5-P1 roots by operation. "Always" on one repository never runs an operation whose handler takes its target by global ID', async () => {
  const github = world('owner', undefined, async (namespace, member) => (namespace === 'mcp.GitHub' ? { preset: 'github', tool: member } : null));
  const tool = { slate: 'board', namespace: 'mcp.GitHub', member: 'discussion_comment_write' };

  github.live.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, {
    ...grant, members: [...grant.members, { ...tool, impact: 'mutate' }], preapproved: [{ ...tool, root: { owner: 'acme', repo: 'a' }, revision: 'rev-1' }],
  });
  const send = async (payload: JsonValue) => settle(github.servers.gate({ slate: 'board', chain: [], address: { namespace: tool.namespace, member: tool.member }, effect: true, args: [payload], on: 'the owner' }));

  // A comment added to repository A's discussion: the operation the owner's "Always for acme/a" covers, unasked.
  expect((await send({ owner: 'acme', repo: 'a', method: 'add', discussionNumber: 1, body: 'hi' })).bounded).toBe(true);
  expect(github.asked()).toEqual([]);
  // Naming acme/a, but taking the comment by its node ID wherever it is: the whole connection's, so it asks.
  await expect(send({ owner: 'acme', repo: 'a', method: 'update', commentNodeID: 'DC_elsewhere', body: 'x' })).rejects.toThrow('waits for the owner');
});

test('a server started, or a request made, under other sharing of its slate acts no more', () => {
  const { servers, live } = world('owner');
  const then = live.generation('board');
  const record = { id: 'board', chain: [], incarnation: 'p1', generations: { board: then } };

  expect(servers.lineage('board', { incarnation: 'p1', generation: then, ancestors: {} }, record)).toBeNull();
  expect(servers.lineage('board', { incarnation: 'p2', generation: then, ancestors: {} }, record)?.message).toContain('another of its servers');
  live.setAuthority('s1', { mode: 'own', grantRevision: null }, grant);
  expect(servers.lineage('board', { incarnation: 'p1', generation: then, ancestors: {} }, null)?.message).toContain('started before its sharing changed');
  expect(servers.lineage('board', { incarnation: 'p1', generation: live.generation('board'), ancestors: {} }, record)?.message).toContain("sharing changed since this request began");
});

test('R4-P1 inherited chain. a slate started under a shared one acts no more, request or none, once that one shares otherwise', () => {
  const { servers, live } = world('owner');
  // The digest, reached by the owner's request through the shared board: its own sharing, and the board's as it was then.
  const digest = { incarnation: 'p2', generation: live.generation('digest'), ancestors: { board: live.generation('board') } };

  expect(servers.lineage('digest', digest, null)).toBeNull();
  live.revoke('s1');
  // The board now lends the owner everything, so nothing else would bound the digest: its sealed lineage refuses it.
  expect(servers.authorityOf('board')).toEqual({ kind: 'owner' });
  expect(servers.lineage('digest', digest, null)?.message).toContain("Slate board's sharing changed since slate digest was started under it");
});

test('R4-P1 nested lineage. a member reached inside a running call meets its lineage before any bound as it stands now', () => {
  const { servers, live } = world('owner');
  const board = { incarnation: 'p1', generation: live.generation('board'), ancestors: {} };
  const member = { slate: 'board', chain: [], address: { namespace: 'workspace', member: 'deleteFile' } };

  expect(servers.beyond({ ...member, fence: { lineage: board, record: null } })?.message).toContain('does not reach');
  live.revoke('s1');
  // Unshared now, the member is the owner's own; reached by the call that began shared, it is refused.
  expect(servers.beyond(member)).toBeNull();
  expect(() => { servers.within({ ...member, fence: { lineage: board, record: null } }); }).toThrow('started before its sharing changed');
});

test('R3-P1 fence. a sharing change fences its slate in the same call that writes the row, before anything can await', () => {
  const { servers, live } = world('own');
  const ownServer = { incarnation: 'p1', generation: live.generation('board'), ancestors: {} };

  // The last share revoked: in that very call its server, started on each person's own access, is fenced. Nothing
  // awaited afterwards (unlisting it from the Gallery, stopping it) can leave it running with the owner's authority.
  live.revoke('s1');
  expect(servers.authorityOf('board')).toEqual({ kind: 'owner' });
  expect(servers.lineage('board', ownServer, null)?.message).toContain('started before its sharing changed');

  // Shared again, and turned to the owner's access: each fences what ran before it.
  const unshared = { incarnation: 'p2', generation: live.generation('board'), ancestors: {} };

  live.add({ id: 's2', slate: 'board', visibility: 'public', handle: '9876543210', grant });
  expect(servers.lineage('board', unshared, null)?.message).toContain('started before its sharing changed');
  const shared = { incarnation: 'p3', generation: live.generation('board'), ancestors: {} };

  live.setAuthority('s2', { mode: 'owner', grantRevision: 'rev-1' }, grant);
  expect(servers.lineage('board', shared, null)?.message).toContain('started before its sharing changed');
  // Revoking what is already revoked changes nothing, so it fences nothing.
  const now = live.generation('board');

  live.revoke('s1');
  expect(live.generation('board')).toBe(now);
});

test("'Always for this slate' runs the asked call, then that tool on that root unasked at this revision; another root asks", async () => {
  const { call, ran, asked, approveAll, live, remembered } = world('owner');
  const write = (path: string) => call('fs.write', { args: [{ path, text: 'hello' }] });

  await expect(write('notes.md')).rejects.toThrow('waits for the owner');
  await approveAll('always');
  // It stands for this slate alone: no standing grant of the environment's is recorded for it.
  expect({ preapproved: live.get('s1')?.grant.preapproved, remembered }).toEqual({ preapproved: [{ slate: 'board', namespace: 'workspace', member: 'fs.write', root: {}, revision: 'rev-1' }], remembered: [] });

  // The asked call runs on it, and every other write of the same tool and root runs unasked after it.
  expect(await write('notes.md')).toMatchObject({ ok: true });
  expect(await write('todo.md')).toMatchObject({ ok: true });
  expect({ ran: ran.length, asked: asked().length }).toEqual({ ran: 2, asked: 0 });

  // Taken back on the sheet: the next write asks again.
  live.withdrawPreapproval('board', { slate: 'board', namespace: 'workspace', member: 'fs.write', root: {} });
  await expect(write('todo.md')).rejects.toThrow('waits for the owner');
});

test("'Always' leaves no one-shot approval behind it: taken back, the very call it was given on asks again", async () => {
  const { call, ran, asked, approveAll, live } = world('owner');
  const write = () => call('fs.write', { args: [{ path: 'notes.md', text: 'hello' }] });

  await expect(write()).rejects.toThrow('waits for the owner');
  await approveAll('always');
  expect(await write()).toMatchObject({ ok: true });

  // Taken back on the sheet; the call it was given on, made again, is the owner's to answer again.
  live.withdrawPreapproval('board', { slate: 'board', namespace: 'workspace', member: 'fs.write', root: {} });
  await expect(write()).rejects.toThrow('waits for the owner');
  expect({ ran: ran.length, asked: asked().length }).toEqual({ ran: 1, asked: 1 });
});

test("'Always' on a call another slate made names that caller, on the shared slate's shares", async () => {
  const { asked, approveAll, live, servers } = world('owner');
  const args = [{ path: 'notes.md' }];
  const reaching: ShareGrant = { ...grant, members: [...grant.members, { slate: 'digest', namespace: 'workspace', member: 'fs.write', impact: 'mutate' }] };

  live.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, reaching);

  await expect(settle(servers.gate({ slate: 'digest', chain: ['board'], address: { namespace: 'workspace', member: 'fs.write' }, effect: true, args, on: 'user:ana' }))).rejects.toThrow('waits for the owner');
  expect(asked().map((kind) => (kind.kind === 'slate-effect' ? [kind.effect.slate, kind.effect.caller] : null))).toEqual([['board', 'digest']]);
  await approveAll('always');
  expect(live.get('s1')?.grant.preapproved).toEqual([{ slate: 'digest', namespace: 'workspace', member: 'fs.write', root: {}, revision: 'rev-1' }]);
});

test("R3-P1 pending edit. while an editor's change awaits review, the owner share lends nothing and says whose change it is", async () => {
  const { live, servers, call } = world('owner');

  live.markEdit('board', 'pat@example.test');
  expect(live.authoritiesOf('board')).toMatchObject([{ mode: 'owner', grantRevision: null, editedBy: 'pat@example.test' }]);
  expect(servers.authorityOf('board')).toEqual({ kind: 'none' });
  await expect(call('fs.text')).rejects.toThrow("pat@example.test's change to slate board is awaiting Sam's review");
});
