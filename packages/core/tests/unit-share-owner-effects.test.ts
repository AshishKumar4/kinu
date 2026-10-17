// An `owner` share's server acts with its owner's access, so each call of it that acts runs only on the owner's
// approval of that exact call, taken once (docs/SLATE-SHARING-NIMBUS.md §2). An observing call needs none, an `own`
// share asks nothing of the owner, and the owner's own call is theirs to make. The owner's queue is the workspace's own
// deferred approvals, as the orchestrator hands it over.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import { createTestActors } from '@kinu.run/test-utils';
import { initSlateLiveShareTables, SlateLiveShareStore } from '../src/slates/live-shares';
import { SlateShareViewers } from '../src/slates/share-viewers';
import { approvalKindOf, DeferredApprovalQueue, DeferredApprovalStore, initDeferredApprovalsTable } from '../src/index';
import type { ShareGrant } from '../src/slates/sharing';
import type { JsonValue } from '../src/utils/json';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers';

const grant: ShareGrant = {
  slates: ['board', 'digest'],
  members: [
    { slate: 'board', namespace: 'workspace', member: 'readFile', impact: 'observe' },
    { slate: 'board', namespace: 'workspace', member: 'writeFile', impact: 'mutate' },
    { slate: 'board', namespace: 'web', member: 'connectBrowser', impact: 'execute' },
    { slate: 'digest', namespace: 'workspace', member: 'readFile', impact: 'observe' },
  ],
};

/** `revisions` is each slate's revision now; the share approved `board`'s at `rev-1`. */
function world(mode: 'own' | 'owner', revisions: Readonly<Record<string, string>> = { board: 'rev-1', digest: 'rev-9' }) {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);

  initSlateLiveShareTables(execRaw);
  initDeferredApprovalsTable(execRaw);
  const live = new SlateLiveShareStore(makeSqlExec(db));
  const sql = makeSql(db);

  const queue = new DeferredApprovalQueue({
    store: new DeferredApprovalStore(sql, createTestActors(sql, execRaw).main), writes: null, remember: () => undefined, wake: () => Effect.void,
  });

  live.add({ id: 's1', slate: 'board', visibility: 'public', handle: '0123456789', grant });

  if (mode === 'owner') live.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, grant);

  const viewers = new SlateShareViewers({
    live, shareEntry: () => null, ownerUserId: () => 'sam', revision: (slate) => revisions[slate] ?? null,
    ownerEffects: { ask: (id, effect) => queue.slateEffect(id, effect), take: (id) => queue.takeSlateEffect(id), settle: async (spend, outcome) => queue.settle(spend, outcome) },
  });

  const ran: string[] = [];

  /** `between`: what changes while the dispatch prepares, before it sends; the dispatch admits the call just before it acts. */
  const call = (member: string, options: { subject?: string; authorize?: true; slate?: string; args?: JsonValue[]; fails?: true; between?: () => void } = {}) => {
    const subject = options.subject ?? 'user:ana';

    return viewers.call({
      share: 's1', id: options.slate ?? 'board', chain: [],
      request: { path: member.split('.'), args: options.args ?? [{ path: 'notes.md', text: 'hello' }], invocation: null, ...(options.authorize && { authorize: options.authorize }) },
      issued: { id: 'inv', chain: [], viewer: { share: 's1', subject, request: live.openRequest({ share: 's1', viewer: subject, path: '/' }) } },
      run: async (_route, _nested, admit) => {
        options.between?.();
        admit?.();
        ran.push(`${subject}:${member}`);

        if (options.fails) throw new Error('the call failed after it was handed on');

        return { ok: true, value: { done: true } };
      },
    });
  };

  // The owner's decision stack: what this share asked of them, as their Work tab lists it.
  const asked = () => queue.list().map((row) => approvalKindOf(row));
  const approveAll = async () => queue.decide(queue.list().map((row) => row.id), 'approved');

  return { call, ran, asked, approveAll, live, queue };
}

test('an owner share\'s acting call waits for the owner, then runs once on their approval', async () => {
  const { call, ran, asked, approveAll } = world('owner');

  await expect(call('writeFile')).rejects.toThrow('waits for the owner to approve it: writeFile on workspace');
  expect(asked().map((kind) => (kind.kind === 'slate-effect' ? [kind.effect.tool, kind.effect.viewer, kind.effect.revision, kind.effect.payload] : kind.kind)))
    .toEqual([['writeFile', 'user:ana', 'rev-1', { path: 'notes.md', text: 'hello' }]]);
  expect(ran).toEqual([]);

  await approveAll();
  expect(await call('writeFile')).toMatchObject({ ok: true });
  // Spent: the same call made again is asked of the owner again.
  await expect(call('writeFile')).rejects.toThrow('waits for the owner');
  expect({ ran, asked: asked().length }).toEqual({ ran: ['user:ana:writeFile'], asked: 1 });
});

test('an approval is spent once its call is handed on, even when the call fails after', async () => {
  const { call, ran, asked, approveAll } = world('owner');

  await expect(call('writeFile')).rejects.toThrow('waits for the owner');
  await approveAll();
  await expect(call('writeFile', { fails: true })).rejects.toThrow('the call failed after it was handed on');
  await expect(call('writeFile')).rejects.toThrow('waits for the owner');
  expect({ ran, asked: asked().length }).toEqual({ ran: ['user:ana:writeFile'], asked: 1 });
});

test('an approval admits the exact call it was asked for, and no other payload', async () => {
  const { call, ran, approveAll } = world('owner');

  await expect(call('writeFile')).rejects.toThrow('waits for the owner');
  await approveAll();
  await expect(call('writeFile', { args: [{ path: 'notes.md', text: 'something else' }] })).rejects.toThrow('waits for the owner');
  expect(ran).toEqual([]);
});

test('an observing call, an own share and the owner\'s own call ask the owner nothing', async () => {
  const owned = world('owner');

  expect(await owned.call('readFile')).toMatchObject({ ok: true });
  expect(await owned.call('writeFile', { subject: 'user:sam' })).toMatchObject({ ok: true });
  expect(owned.asked()).toEqual([]);

  const own = world('own');

  expect(await own.call('writeFile')).toMatchObject({ ok: true });
  expect(own.asked()).toEqual([]);
});

test('an owner share whose slate moved past the approved revision lends nothing, observing or not, until its owner approves again', async () => {
  const { call, ran, asked } = world('owner', { board: 'rev-2', digest: 'rev-9' });

  await expect(call('readFile')).rejects.toThrow('changed since its owner approved what it reaches');
  await expect(call('writeFile')).rejects.toThrow('changed since its owner approved what it reaches');
  expect(await call('writeFile', { subject: 'user:sam' })).toMatchObject({ ok: true });
  expect({ ran, asked: asked().length }).toEqual({ ran: ['user:sam:writeFile'], asked: 0 });
});

test('a call from a slate the share hops to is held to the shared slate\'s approved revision, not its own', async () => {
  const { call } = world('owner');

  expect(await call('readFile', { slate: 'digest' })).toMatchObject({ ok: true });
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

  await expect(revoked.call('writeFile')).rejects.toThrow('waits for the owner');
  await revoked.approveAll();
  await expect(revoked.call('writeFile', { between: () => { revoked.live.revoke('s1'); } })).rejects.toThrow('no longer shared');
  await expect(revoked.call('readFile', { between: () => { revoked.live.revoke('s1'); } })).rejects.toThrow('no longer shared');
  expect({ ran: revoked.ran, approved: revoked.queue.list().length }).toEqual({ ran: [], approved: 0 });

  // Turned back to each viewer's own access mid-call: what was admitted on the owner's access is not sent on it.
  const turned = world('owner');

  await expect(turned.call('writeFile')).rejects.toThrow('waits for the owner');
  await turned.approveAll();
  await expect(turned.call('writeFile', { between: () => { turned.live.setAuthority('s1', { mode: 'own', grantRevision: null }, grant); } })).rejects.toThrow('stopped lending');
  expect(turned.ran).toEqual([]);

  // Its approval retired mid-call (the share's revision moved, or its owner took it back).
  const retired = world('owner');

  await expect(retired.call('writeFile')).rejects.toThrow('waits for the owner');
  await retired.approveAll();
  await expect(retired.call('writeFile', { between: () => { retired.queue.retireSlateEffects('s1'); } })).rejects.toThrow('taken back');
  expect(retired.ran).toEqual([]);
});
