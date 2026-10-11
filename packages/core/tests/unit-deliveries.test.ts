/** Deliveries (design v2 §1, v3 A): the workspace's record of what each agent is owed, and how producers write it. */
import { describe, expect, test } from 'bun:test';
import { createTestActorsOver, createTestSql } from '@kinu.run/test-utils';
import { admitSubordinateTask, AgentDeliveries, assignmentDelivery, DeliveryInbox, InProcessDeliveries, initAgentDeliveriesTable, pendingEventsDelivery, subordinateTurnContext, wordsRefusal, type Delivery, type DeliveryAnswer } from '../src/index';
import { initEventsHubTables, EventLog, type IngressDescriptor } from '../src/events/hub/index';
import { KinuError } from '../src/obs/index';
import { makeSqlExec } from './helpers';

function workspace() {
  const { db, sql, execRaw } = createTestSql();
  const { main } = createTestActorsOver(db);
  const events = makeSqlExec(db);

  initAgentDeliveriesTable(execRaw);
  initEventsHubTables(events);

  return { db, sql, main: main.actorId, deliveries: new AgentDeliveries(sql), eventLog: new EventLog(events, main) };
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

    expect(deliveries.unpaid(main).map((owed) => (owed.input.kind === 'run' ? owed.input.task.body : owed.input.text))).toEqual(['first', 'second']);
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

    const inbox = new DeliveryInbox({
      deliver: async (delivery) => {
        delivered.push(delivery);

        return 'taken';
      },
      broadcast: (event) => { carded.push(event.type); },
    });

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

describe('an assignment as its delivery', () => {
  test("binds its row under its own id, so no drain takes it and its turn reads the brief's inherited context by it", () => {
    const { eventLog } = workspace();
    const inherited = { kind: 'fork' as const, messages: [{ id: 'm-1', role: 'user' as const, content: 'the hirer said this', createdAt: 1 }] };

    const admitted = admitSubordinateTask(eventLog, {
      fromWorkspace: 'lead', kind: 'task', body: '  Count the files.  ', mode: 'plan', inheritedContext: inherited, now: Date.now(),
    });

    const delivery = assignmentDelivery(eventLog, { id: admitted.id, body: 'Count the files.', mode: 'plan', from: 'lead' });

    expect(delivery).toMatchObject({ id: admitted.id, input: { kind: 'turn', text: 'Count the files.', metadata: { drainTurnId: admitted.id, kinuMode: 'plan' } }, authorship: 'hirer' });
    expect(eventLog.pending({ variant: 'subordinate_task' })).toEqual([]);
    expect(subordinateTurnContext(eventLog, admitted.id)).toHaveLength(1);
  });
});

describe('deliveries crossed in this process', () => {
  /** An agent whose chat answers as `answer` says, and records what it took. */
  function local(answer: (delivery: Delivery) => Promise<DeliveryAnswer>) {
    const world = workspace();
    const taken: string[] = [];

    const port = new InProcessDeliveries({
      actorId: world.main, sql: world.sql, transaction: (body) => world.db.transaction(body)(), eventLog: world.eventLog,
      admit: async (delivery) => {
        const answered = await answer(delivery);

        if (answered === 'taken') taken.push(delivery.id);

        return answered;
      },
      broadcast: () => undefined,
    });

    return { ...world, port, taken };
  }

  test('a crossing that dies before the chat takes it leaves it owed, and the next open hands it over once', async () => {
    let dies = true;

    const { port, taken, deliveries, main } = local(async () => {
      if (dies) throw new KinuError('unavailable', 'the process died before the chat took it');

      return 'taken';
    });

    await port.commit(() => turn('d-1', 'first'));
    expect(deliveries.unpaid(main).map((owed) => owed.id)).toEqual(['d-1']);

    dies = false;
    await port.crossOwed();
    await port.crossOwed();
    expect({ taken, owed: deliveries.unpaid(main) }).toEqual({ taken: ['d-1'], owed: [] });
  });

  test("a chat's refusal, or one that would recur on every crossing, retires the delivery and hands its events back parked", async () => {
    const { port, deliveries, main, eventLog } = local(async (delivery) => {
      if (delivery.id === 'd-own') return { refused: { code: 'bad_input', message: 'not words it takes' } };

      throw new KinuError('unsupported', 'its chat cannot open');
    });

    eventLog.publish({ descriptor: webhook('wh-1'), now: Date.now() });
    await port.commit(() => pendingEventsDelivery(eventLog, Date.now()));
    await port.commit(() => turn('d-own', 'second'));

    expect(deliveries.unpaid(main)).toEqual([]);
    // Parked: pending to the drain something else starts, never waking one of its own.
    expect(eventLog.pending({}).map((event) => event.variant)).toEqual(['webhook']);
  });
});
