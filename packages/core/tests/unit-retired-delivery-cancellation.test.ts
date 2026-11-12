import { expect, test } from 'bun:test';
import { createTestActorsOver, createTestSql } from '@kinu.run/test-utils';
import { actorReferenceOf, DeliveryCoordinator, EventLog, initAgentDeliveriesTable, pendingEventsDelivery, type DeliveryAnswer } from '../src/index';
import { initEventsHubTables } from '../src/events/hub/schema';
import { makeSqlExec } from './helpers';

for (const answer of ['taken', 'cancelled', 'refused'] as const) {
  test(`retiring an agent during an awaited crossing cancels its captured deliveries and leases after a ${answer} answer`, async () => {
    const { db, sql, execRaw } = createTestSql();
    const actors = createTestActorsOver(db);
    const child = actors.sibling('release-reviewer');
    const events = makeSqlExec(db);

    initAgentDeliveriesTable(execRaw);
    initEventsHubTables(events);

    const log = new EventLog(events, child);
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let admitted = 0;
    let identityReads = 0;

    const coordinator = new DeliveryCoordinator({
      sql, transaction: (body) => db.transaction(body)(), wake: () => async () => {},
      live: (actorId) => actors.directory.list().some((actor) => actor.actorId === actorId),
      eventLog: (actorId) => {
        identityReads += 1;

        return new EventLog(events, actors.directory.open(actorId));
      },
      admit: async (): Promise<DeliveryAnswer> => {
        admitted += 1;

        if (answer === 'refused') return { refused: { code: 'bad_input', message: 'the input was refused' } };
        arrived.resolve();
        await release.promise;

        return answer;
      },
      refused: async () => {
        arrived.resolve();
        await release.promise;

        return false;
      },
    });

    const submit = (id: string) => coordinator.owe(child.actorId, () => {
      log.publish({ descriptor: {
        ingress: 'peer_async', variant: 'peer_agent', same_owner: true,
        payload: { from_agent_name: 'sender', from_user_id: '', topic: 'Release status', body: 'Review the release.', sender_event_id: id, kinu_mode: 'build', reply_expected: false },
      }, now: Date.now() });

      const delivery = pendingEventsDelivery(log, Date.now());

      return { value: delivery?.id, delivery };
    });

    const first = submit('first');

    await arrived.promise;
    const second = submit('second');
    const settled = Promise.allSettled([first, second]);

    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_deliveries WHERE actor_id = ${child.actorId}`[0]?.n).toBe(answer === 'refused' ? 1 : 2);
    actors.directory.apply(actors.main, [], { action: 'retire', name: child.name, reference: actorReferenceOf(child) });
    actors.directory.apply(actors.main, [], { action: 'release', name: child.name, reference: actorReferenceOf(child) });
    release.resolve();

    const results = await settled;

    expect({
      results: results.map((result) => result.status), admitted, identityReads,
      owed: sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_deliveries WHERE actor_id = ${child.actorId}`[0]?.n,
      leases: sql<{ turn_id: string | null; consumed_at: number | null; step_idx: number }>`SELECT turn_id, consumed_at, step_idx FROM agent_log WHERE actor_id = ${child.actorId} ORDER BY received_at`,
    }).toEqual({
      results: ['fulfilled', 'fulfilled'], admitted: 1, identityReads: 0, owed: 0,
      leases: [{ turn_id: null, consumed_at: null, step_idx: -2 }, { turn_id: null, consumed_at: null, step_idx: -2 }],
    });
  });
}
