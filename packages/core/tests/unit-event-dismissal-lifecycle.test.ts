import { expect, test } from 'bun:test';
import { createTestActorsOver, createTestSql } from '@kinu.run/test-utils';
import { actorReferenceOf, AgentDeliveries, EventLog, initAgentDeliveriesTable } from '../src/index';
import { initEventsHubTables } from '../src/events/hub/schema';
import { makeSqlExec } from './helpers';

test('event dismissal preserves scope and authority for live tools and retirement cleanup', () => {
  const { db, sql, execRaw } = createTestSql();
  const actors = createTestActorsOver(db);
  const child = actors.sibling('reviewer');
  const events = makeSqlExec(db);

  initEventsHubTables(events);
  initAgentDeliveriesTable(execRaw);

  const root = new EventLog(events, actors.main);
  const sibling = new EventLog(events, child);

  const publish = (log: EventLog, text: string) => log.publish({ descriptor: {
    ingress: 'chat_ws', variant: 'chat', payload: { text }, operator_user_id: 'owner', session_id: 'session',
  }, now: Date.now() }).id;

  const one = publish(root, 'one selected event');
  const active = publish(root, 'an admitted input');
  const completed = publish(root, 'an answered input');
  const pending = publish(root, 'an input still pending');
  const other = publish(sibling, 'another actor holds this input');

  root.markConsumed(active, 'evt-active', 0);
  root.markConsumed(completed, 'evt-completed', 0);
  root.markTurnCompleted('evt-completed');
  sibling.markConsumed(other, 'evt-other', 0);
  root.dismiss(one, 'operator chose to dismiss', 'tool');
  new AgentDeliveries(sql).cancel(actors.main.actorId);

  expect(root.pending().map((event) => event.id)).toEqual([pending]);
  expect(root.query({ turn_id: 'evt-completed' }).map((event) => event.id)).toEqual([completed]);
  expect(sibling.query({ turn_id: 'evt-other' }).map((event) => event.id)).toEqual([other]);
  expect(sql<{ id: string; turn_id: string | null; consumed_at: number | null; step_idx: number; by: string }>`
    SELECT id, turn_id, consumed_at, step_idx, json_extract(payload, '$.__dismissed.by') AS by
    FROM agent_log WHERE actor_id = ${actors.main.actorId} AND id IN (${one}, ${active}) ORDER BY rowid`)
    .toEqual([
      { id: one, turn_id: null, consumed_at: null, step_idx: -2, by: 'tool' },
      { id: active, turn_id: null, consumed_at: null, step_idx: -2, by: 'system' },
    ]);

  actors.directory.apply(actors.main, [], { action: 'retire', name: child.name, reference: actorReferenceOf(child) });
  actors.directory.apply(actors.main, [], { action: 'release', name: child.name, reference: actorReferenceOf(child) });
  expect(() => sibling.dismiss(other, 'a retired actor cannot act', 'tool')).toThrow();
  new AgentDeliveries(sql).cancel(child.actorId);
  expect(sql<{ turn_id: string | null; consumed_at: number | null; step_idx: number }>`
    SELECT turn_id, consumed_at, step_idx FROM agent_log WHERE actor_id = ${child.actorId} AND id = ${other}`)
    .toEqual([{ turn_id: null, consumed_at: null, step_idx: -2 }]);
});
