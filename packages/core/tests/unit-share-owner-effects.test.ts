// An `owner` share's server acts with its owner's access, so each call of it that acts runs only on the owner's
// approval of that exact call, taken once (docs/SLATE-SHARING-NIMBUS.md §2). An observing call needs none, an `own`
// share asks nothing of the owner, and the owner's own call is theirs to make.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initSlateLiveShareTables, SlateLiveShareStore } from '../src/slates/live-shares';
import { SlateShareViewers, type OwnerEffects } from '../src/slates/share-viewers';
import type { SlateEffect } from '../src/safety/approval-kind';
import type { ApprovalSpend } from '../src/safety/approval-gate';
import type { ShareGrant } from '../src/slates/sharing';
import { makeExecRaw, makeSqlExec } from './helpers';

const grant: ShareGrant = {
  slates: ['board'],
  members: [
    { slate: 'board', namespace: 'workspace', member: 'readFile', impact: 'observe' },
    { slate: 'board', namespace: 'workspace', member: 'writeFile', impact: 'mutate' },
  ],
};

/** The owner's queue as the viewers meet it: an ask per exact call, approved by the test, taken once. */
function ownerQueue() {
  const asked = new Map<string, { effect: SlateEffect; approved: boolean }>();
  const settled: string[] = [];
  let spends = 0;

  const queue: OwnerEffects = {
    ask: (id, effect) => {
      const held = asked.get(id);

      if (held?.approved === true) {
        asked.delete(id);
        spends += 1;

        return { outcome: 'run', spend: { approvalId: id, spend: spends } satisfies ApprovalSpend };
      }

      if (held === undefined) asked.set(id, { effect, approved: false });

      return { outcome: 'asked', action: { id, actor: 'main', command: '', executor: '', context: {}, reason: '', status: 'queued', requestedAt: 0, decidedAt: null } };
    },
    settle: async (spend, outcome) => {
      settled.push(`${spend.approvalId}:${outcome}`);

      return true;
    },
  };

  return { queue, asked, settled, approveAll: () => { for (const held of asked.values()) held.approved = true; } };
}

function world(mode: 'own' | 'owner', revision = 'rev-1') {
  const db = new Database(':memory:');

  initSlateLiveShareTables(makeExecRaw(db));
  const live = new SlateLiveShareStore(makeSqlExec(db));

  live.add({ id: 's1', slate: 'board', visibility: 'public', handle: '0123456789', grant });

  if (mode === 'owner') live.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, grant);
  const owner = ownerQueue();
  const viewers = new SlateShareViewers({ live, shareEntry: () => null, ownerUserId: () => 'sam', revision: () => revision, ownerEffects: owner.queue });
  const ran: string[] = [];

  const call = (member: string, subject = 'user:ana') => viewers.call({
    share: 's1', id: 'board', request: { path: [member], args: [{ path: 'notes.md', text: 'hello' }], invocation: null }, chain: [],
    issued: { id: 'inv', chain: [], viewer: { share: 's1', subject, request: live.openRequest({ share: 's1', viewer: subject, path: '/' }) } },
    run: async () => {
      ran.push(`${subject}:${member}`);

      return { ok: true, value: { done: true } };
    },
  });

  return { owner, call, ran };
}

test('an owner share\'s acting call waits for the owner, then runs once on their approval', async () => {
  const { owner, call, ran } = world('owner');

  await expect(call('writeFile')).rejects.toThrow('waits for the owner to approve it: writeFile on workspace');
  expect([...owner.asked.values()].map(({ effect }) => [effect.tool, effect.viewer, effect.revision, effect.payload]))
    .toEqual([['writeFile', 'user:ana', 'rev-1', { path: 'notes.md', text: 'hello' }]]);
  expect(ran).toEqual([]);

  owner.approveAll();
  expect(await call('writeFile')).toMatchObject({ ok: true });
  await expect(call('writeFile')).rejects.toThrow('waits for the owner');
  expect({ ran, settled: owner.settled.map((entry) => entry.split(':')[1]) }).toEqual({ ran: ['user:ana:writeFile'], settled: ['spent'] });
});

test('an observing call, an own share and the owner\'s own call ask the owner nothing', async () => {
  const owned = world('owner');

  expect(await owned.call('readFile')).toMatchObject({ ok: true });
  expect(await owned.call('writeFile', 'user:sam')).toMatchObject({ ok: true });
  expect(owned.owner.asked.size).toBe(0);

  const own = world('own');

  expect(await own.call('writeFile')).toMatchObject({ ok: true });
  expect(own.owner.asked.size).toBe(0);
});

test('an owner share whose slate moved past the approved revision lends nothing, observing or not, until its owner approves again', async () => {
  const { owner, call, ran } = world('owner', 'rev-2');

  await expect(call('readFile')).rejects.toThrow('changed since its owner approved what it reaches');
  await expect(call('writeFile')).rejects.toThrow('changed since its owner approved what it reaches');
  expect(await call('writeFile', 'user:sam')).toMatchObject({ ok: true });
  expect({ ran, asked: owner.asked.size }).toEqual({ ran: ['user:sam:writeFile'], asked: 0 });
});
