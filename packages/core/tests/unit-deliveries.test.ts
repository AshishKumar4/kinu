/** Deliveries (design v2 §1, v3 A): the workspace's record of what each agent is owed, and how producers write it. */
import { describe, expect, test } from 'bun:test';
import { createTestActorsOver, createTestSql } from '@kinu.run/test-utils';
import { AgentDeliveries, DeliveryInbox, initAgentDeliveriesTable, pendingEventsDelivery, wordsRefusal, type Delivery } from '../src/index';
import { initEventsHubTables, EventLog, type IngressDescriptor } from '../src/events/hub/index';
import { makeSqlExec } from './helpers';

function workspace() {
  const { db, sql, execRaw } = createTestSql();
  const { main } = createTestActorsOver(db);
  const events = makeSqlExec(db);

  initAgentDeliveriesTable(execRaw);
  initEventsHubTables(events);

  return { db, main: main.actorId, deliveries: new AgentDeliveries(sql), eventLog: new EventLog(events, main) };
}

const turn = (id: string, text: string): Delivery => ({ id, input: { kind: 'turn', text }, authorship: 'hirer' });

function webhook(deliveryId: string): IngressDescriptor {
  return {
    ingress: 'webhook_hmac', variant: 'webhook',
    payload: { webhook_id: 'w1', http_method: 'POST', http_headers: {}, body: { x: 1 }, delivery_id: deliveryId },
    auth_outcome: 'verified', webhook_id: 'w1',
  };
}

describe('AgentDeliveries', () => {
  test('owes each delivery once, in the order its producer committed it, until the agent answers for it', () => {
    const { main, deliveries } = workspace();

    expect(deliveries.add(main, turn('d-1', 'first'))).toBe(true);
    expect(deliveries.add(main, turn('d-2', 'second'))).toBe(true);
    expect(deliveries.add(main, turn('d-1', 'first, again'))).toBe(false);

    expect(deliveries.unpaid(main).map((owed) => owed.input.text)).toEqual(['first', 'second']);
    expect(deliveries.owes(main)).toBe(true);

    deliveries.paid(main, 'd-1');
    deliveries.paid(main, 'd-2');
    expect(deliveries.owes(main)).toBe(false);
  });

  test("a cutoff cancels every delivery owed at that moment and answers which", () => {
    const { main, deliveries } = workspace();

    deliveries.add(main, turn('d-1', 'first'));
    deliveries.add(main, turn('d-2', 'second'));

    expect(deliveries.cancel(main).map((owed) => owed.id)).toEqual(['d-1', 'd-2']);
    expect(deliveries.unpaid(main)).toEqual([]);
  });
});

describe('a signal as a delivery', () => {
  test("is carded, committed under its key, and answered queued: a person's words are never a signal", async () => {
    const delivered: Delivery[] = [];
    const carded: string[] = [];
    const inbox = new DeliveryInbox({ deliver: async (delivery) => { delivered.push(delivery); }, broadcast: (event) => { carded.push(event.type); } });

    expect(await inbox.send({ kind: 'mcp', text: 'Tally the refunds.', idempotencyKey: 'mcp-1' })).toBe('queued');
    expect(delivered.map((delivery) => [delivery.id, delivery.input.kind, delivery.authorship])).toEqual([['mcp-1', 'turn', 'hirer']]);
    expect(carded).toEqual(['signal_card']);

    await expect(inbox.send({ kind: 'mcp', text: 'x', user: { id: 'u-1', mode: 'build' } })).rejects.toThrow('never as a signal');
  });
});

describe('pending events as one delivery', () => {
  test('binds the events to its turn as it is written, so a second drain finds none', () => {
    const { db, eventLog } = workspace();

    eventLog.publish({ descriptor: webhook('w-1'), now: 1 });
    eventLog.publish({ descriptor: webhook('w-2'), now: 1 });

    const delivery = db.transaction(() => pendingEventsDelivery(eventLog, 2))();

    expect(delivery?.input.kind).toBe('turn');
    expect(delivery === null ? null : delivery.id.startsWith('evt-')).toBe(true);
    expect(pendingEventsDelivery(eventLog, 3)).toBeNull();
  });
});

describe('words at the door', () => {
  test('refuses an unusable id or empty words before anything is written', () => {
    expect(wordsRefusal({ id: '', input: { kind: 'words', text: 'hi' }, authorship: 'owner' })?.message).toContain('A message id is 1 to 128 characters');
    expect(wordsRefusal({ id: 'm-1', input: { kind: 'words', text: '   ' }, authorship: 'owner' })?.message).toContain('send requires the message text');
    expect(wordsRefusal({ id: 'm-1', input: { kind: 'words', text: 'hi' }, authorship: 'owner' })).toBeNull();
  });
});
