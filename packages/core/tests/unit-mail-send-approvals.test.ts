// An agent's message parks on the owner as one of the deferred approvals (approval-kind.ts `mail-send`): one row per
// exact message, asked once, sent once on approval, never answered "always", and the agent that asked is woken when
// the owner decides. The card shows the message as it would leave.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import { createTestActors, present } from '@kinu.run/test-utils';
import {
  approvalKindOf, DeferredApprovalQueue, DeferredApprovalStore, initDeferredApprovalsTable, mailSendExecutor, mailSendText,
  type AgentSignal, type MailSend,
} from '../src/index';
import type { ApprovalGrant } from '../src/safety/approval-gate';
import { buildPendingActions } from '../src/read-models/pending-actions';
import { makeExecRaw, makeSql } from './helpers';

const REPLY: MailSend = {
  by: 'scout', from: 'scout.api-worker.ashish@kinu.run', to: ['dana@northwind.io'], cc: [], thread: 't-dana',
  subject: 'Re: Webhook deliveries to /hooks/v2 failing with 500',
  text: 'The 500s were ours, from the signing change; fixed at 14:05. Replay from your dashboard.',
};

function world() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);

  initDeferredApprovalsTable(execRaw);

  const actors = createTestActors(sql, execRaw);
  const store = new DeferredApprovalStore(sql, actors.main);
  const woken: { actor: string; signal: AgentSignal }[] = [];
  const remembered: ApprovalGrant[] = [];

  const queue = new DeferredApprovalQueue({
    store, writes: null, remember: (grants) => { remembered.push(...grants); }, now: () => 1_000,
    wake: (actor, signal) => Effect.sync(() => { woken.push({ actor, signal }); }),
  });

  return { store, queue, woken, remembered, main: actors.main.actorId };
}

test('a message is asked once, sent once on approval, and asked again after', async () => {
  const { queue, main } = world();

  expect(queue.mailSend('mail-1', REPLY, main).outcome).toBe('asked');
  expect(queue.mailSend('mail-1', REPLY, main).outcome).toBe('asked');
  expect(queue.list().map((row) => row.id)).toEqual(['mail-1']);

  await queue.decide(['mail-1'], 'approved');
  expect(queue.mailSend('mail-1', REPLY, main).outcome).toBe('approved');

  const spend = present(queue.takeMailSend('mail-1', main), 'the approval taken as it is sent');

  expect(queue.takeMailSend('mail-1', main)).toBeNull();
  await queue.settle(spend, 'spent');
  expect(queue.mailSend('mail-1', REPLY, main).outcome).toBe('asked');
});

test('the agent that asked is woken by the owner\'s decision', async () => {
  const { queue, woken, main } = world();

  queue.mailSend('mail-1', REPLY, main);
  await queue.decide(['mail-1'], 'approved');
  expect(woken.map((each) => each.actor)).toEqual([main]);
});

test('"always" sends that one message and keeps no standing approval', async () => {
  const { queue, remembered, main } = world();

  queue.mailSend('mail-1', REPLY, main);
  await queue.decide(['mail-1'], 'always');
  expect(remembered).toEqual([]);
  expect(queue.mailSend('mail-1', REPLY, main).outcome).toBe('approved');
  expect(queue.mailSend('mail-2', { ...REPLY, text: 'Another message.' }, main).outcome).toBe('asked');
});

test('a declined message stands declined', async () => {
  const { queue, main } = world();

  queue.mailSend('mail-1', REPLY, main);
  await queue.decide(['mail-1'], 'denied');
  expect(queue.mailSend('mail-1', REPLY, main).outcome).toBe('denied');
  expect(queue.takeMailSend('mail-1', main)).toBeNull();
});

test('its card is the message as it would leave, from the agent that asked', () => {
  const { queue, main } = world();

  queue.mailSend('mail-1', REPLY, main);

  const [card] = buildPendingActions({ deferredActions: queue.list(), pendingPlans: [] });

  expect(card).toMatchObject({
    kind: 'deferred_action', raisedBy: main, title: `Send mail to dana@northwind.io: ${REPLY.subject}`,
    mail: { by: 'scout', from: REPLY.from, to: REPLY.to, cc: [], subject: REPLY.subject, text: REPLY.text },
  });
});

test('the kind is read off the row: a command whose words read like a message stays a command', () => {
  expect(approvalKindOf({ command: mailSendText(REPLY), executor: mailSendExecutor(REPLY.from) })).toEqual({ kind: 'mail-send', send: REPLY });
  expect(approvalKindOf({ command: mailSendText(REPLY), executor: 'ssh:prod' }).kind).toBe('command');
  expect(approvalKindOf({ command: mailSendText(REPLY), executor: mailSendExecutor('someone-else@kinu.run') }).kind).toBe('command');
});
