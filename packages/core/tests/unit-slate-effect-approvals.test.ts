// A shared slate's effect in `owner` mode parks on the owner as one of the deferred approvals (approval-kind.ts): one
// row per exact call, asked once, run once on approval and never again, retired with its share, never waking an agent
// and never in an agent's turn. The kind is read off the row by one codec, which a command's look-alike text never
// fools.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import { createTestActors, present } from '@kinu.run/test-utils';
import {
  approvalKindOf, DeferredApprovalQueue, DeferredApprovalStore, initOwnerRequestsTable, slateEffectExecutor, slateEffectText, type AgentSignal,
  type SlateEffect,
} from '../src/index';
import { buildPendingActions } from '../src/read-models/pending-actions';
import { makeExecRaw, makeSql } from './helpers';

const EFFECT: SlateEffect = {
  slate: 'board', caller: 'board', revision: 'rev-1', server: 'github', tool: 'createIssue', root: { repo: 'kinu/kinu' },
  payload: { title: 'Ship it' }, viewer: 'user:ana',
};

function world() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);

  initOwnerRequestsTable(execRaw);
  const store = new DeferredApprovalStore(sql, createTestActors(sql, execRaw).main);
  const woken: AgentSignal[] = [];

  const queue = new DeferredApprovalQueue({
    store, writes: null, remember: () => undefined, now: () => 1_000,
    wake: (_actor, signal) => Effect.sync(() => { woken.push(signal); }),
  });

  return { store, queue, woken };
}

test('an owner-mode effect is asked once, runs once on approval, and asks again after', async () => {
  const { queue, woken } = world();

  expect(queue.slateEffect('call-1', EFFECT).outcome).toBe('asked');
  expect(queue.slateEffect('call-1', EFFECT).outcome).toBe('asked');
  expect(queue.list().map((row) => row.id)).toEqual(['call-1']);

  await queue.decide(['call-1'], 'approved');
  // Asking finds it approved and takes nothing: the approval is taken where the call is sent, once.
  expect(queue.slateEffect('call-1', EFFECT).outcome).toBe('approved');
  const spend = present(queue.takeSlateEffect('call-1'), 'the approval taken at the send');

  expect(queue.takeSlateEffect('call-1')).toBeNull();

  // Taken and running: the same call made meanwhile waits, and is not asked twice.
  expect(queue.slateEffect('call-1', EFFECT).outcome).toBe('asked');
  expect(queue.list()).toEqual([]);

  await queue.settle(spend, 'spent');
  // The approval is used: the same call made again is asked of the owner again, and runs once more on their word.
  expect(queue.slateEffect('call-1', EFFECT).outcome).toBe('asked');
  expect(queue.list().map((row) => [row.id, row.status])).toEqual([['call-1', 'queued']]);
  await queue.decide(['call-1'], 'approved');
  expect(queue.slateEffect('call-1', EFFECT).outcome).toBe('approved');
  // No agent asked it, so none is woken by its decision.
  expect(woken).toEqual([]);
});

test('an effect whose run did not happen keeps its approval for the next', async () => {
  const { queue } = world();

  queue.slateEffect('call-1', EFFECT);
  await queue.decide(['call-1'], 'approved');
  await queue.settle(present(queue.takeSlateEffect('call-1'), 'the approval taken'), 'did-not-run');
  expect(queue.slateEffect('call-1', EFFECT).outcome).toBe('approved');
});

test('a declined effect stands, and a share\'s open effects retire with it', async () => {
  const { queue } = world();

  queue.slateEffect('call-1', EFFECT);
  await queue.decide(['call-1'], 'denied');
  expect(queue.slateEffect('call-1', EFFECT).outcome).toBe('denied');

  queue.slateEffect('call-2', { ...EFFECT, payload: { title: 'Another' } });
  queue.slateEffect('call-3', { ...EFFECT, slate: 'digest', caller: 'digest' });
  expect(queue.retireSlateEffects('board')).toEqual(['call-2']);
  expect(queue.list().map((row) => row.id)).toEqual(['call-3']);
});

test('an effect is the owner\'s decision card, with its payload, and no part of an agent\'s turn', () => {
  const { queue, store } = world();

  queue.slateEffect('call-1', EFFECT);

  const [card] = buildPendingActions({
    deferredActions: queue.list(),
    pendingPlans: [],
  });

  expect(card).toMatchObject({ id: 'call-1', title: 'Approve: createIssue on github, for user:ana through a share of board', detail: '{\n  "title": "Ship it"\n}' });
  expect(card?.raisedBy).toBeUndefined();
  // What "Always for this slate" would stand for, named on the card before the owner answers it.
  expect(card?.effect).toEqual({ slate: EFFECT.slate, caller: EFFECT.caller, server: EFFECT.server, tool: EFFECT.tool, root: EFFECT.root });
  expect(queue.approvals(store.actorId)).toEqual([]);
});

test('the kind is read off the row: a command whose words read like an effect stays a command', () => {
  const text = slateEffectText(EFFECT);

  expect(approvalKindOf({ command: text, executor: slateEffectExecutor('board') })).toEqual({ kind: 'slate-effect', effect: EFFECT });
  expect(approvalKindOf({ command: text, executor: 'dev-laptop' })).toEqual({ kind: 'command', command: text });
  expect(approvalKindOf({ command: text, executor: slateEffectExecutor('share-2') }).kind).toBe('command');
  expect(approvalKindOf({ command: `file write a.txt sha256:${'a'.repeat(64)} over sha256:${'b'.repeat(64)}`, executor: 'workspace' }))
    .toEqual({ kind: 'write', write: { path: 'a.txt', next: 'a'.repeat(64), current: 'b'.repeat(64) } });
});
