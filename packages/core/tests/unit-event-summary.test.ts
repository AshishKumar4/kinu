/** What a card says of an event: from the fields its producer keeps beside the text the agent is handed. */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { cardWords, keptAdvisorNote, sayAdvisorNote, type AdvisorNote } from '../src/index';
import type { AgentSignal } from '../src/types/signals';
import { makeSql } from './helpers';
import { testActorHandle } from '@kinu.run/test-utils';

const BLOCKER: AdvisorNote = {
  note: 'The migration drops coupons.kind while the old worker is still deployed.',
  severity: 'blocker',
  class: 'wrong-work',
};

test('an advisor note said before it was kept reads back out of its text, the actor\'s copy and the parent\'s', async () => {
  const said: AgentSignal[] = [];

  await sayAdvisorNote(BLOCKER, {
    turnId: 'turn-1',
    send: async (signal) => {
      said.push(signal);

      return 'queued';
    },
    actor: testActorHandle(makeSql(new Database(':memory:')), { actorId: 'actor-1' }),
    parent: async (signal) => {
      said.push(signal);

      return 'queued';
    },
  });

  expect(said).toHaveLength(2);

  for (const signal of said) expect(keptAdvisorNote(signal.text, BLOCKER.severity)).toBe(BLOCKER.note);
  expect(keptAdvisorNote(BLOCKER.note, BLOCKER.severity)).toBeNull();
});

test('a card keeps a bounded copy of words its turn carries whole', () => {
  const words = 'Split the backfill from the migration. '.repeat(200);

  expect(cardWords('Split the backfill.')).toBe('Split the backfill.');
  expect(cardWords(words).length).toBeLessThan(words.length / 10);
  expect(words.startsWith(cardWords(words).replace(/\.\.\.$/u, ''))).toBeTrue();
});
