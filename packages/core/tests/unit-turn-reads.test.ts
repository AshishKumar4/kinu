/**
 * What a turn reads once for every step's dynamic context: its agent's unread mail beside the account's facts
 * (docs/MAIL.md §8), so the block's bytes change only when the box does, never between a turn's steps.
 */
import { expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { assembleActorTurn, type TurnReads } from '../src/orchestrator/turn-assembly';
import { mailInContext } from '../src/prompting/volatile-context';
import { hostedSeatsOver } from './helpers-actor-host';

const DANA = mailInContext({ unread: 1, threads: [{
  id: 't-dana', path: '', subject: 'Webhook deliveries to /hooks/v2 failing with 500', from: [{ name: 'Dana Whitfield', address: 'dana@northwind.io' }],
  snippet: 'Every delivery to /hooks/v2 gets a 500.', at: Date.UTC(2026, 9, 20, 14, 12), count: 1, unread: true, verified: false,
  attachments: false, important: null, trashedAt: null, draft: false, outgoing: false,
}] });

test('a turn reads its agent\'s unread mail once, and hands the read to its steps\' context', async () => {
  const { rt, testSql } = createTestRuntime();
  const { sources } = await hostedSeatsOver({ rt, db: testSql.db, model: (spec) => spec }).seat('scout', 'agent');
  const read: TurnReads[] = [];
  let asked = 0;

  await assembleActorTurn({
    ...sources,
    mail: async () => {
      asked += 1;

      return DANA;
    },
    dynamic: (reads) => {
      read.push(reads);

      return () => ({});
    },
    toolset: () => ({ tools: {}, stores: null }),
    externalTools: async () => ({}),
    wiredToolNames: () => [],
    codemodeCapabilities: () => [],
  }, { userText: '', workMode: 'build' });

  expect(asked).toBe(1);
  expect(read.map((reads) => reads.mail)).toEqual([DANA]);
});
