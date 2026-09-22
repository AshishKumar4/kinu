/** A drain turn opens on the actor's conversation, else the delivery's; the rule lives on the actor session. */
import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { createTestRuntime } from '@kinu.run/test-utils';
import { hostedSeatsOver } from './helpers-actor-host';

const BIRTH: readonly ModelMessage[] = [
  { role: 'user', content: 'the parent asked for a report' },
  { role: 'assistant', content: 'I will hire a writer for it' },
];

function textOf(message: ModelMessage): string {
  if (v.is(v.string(), message.content)) return message.content;

  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
}

async function seated(name: string) {
  const { rt, testSql } = createTestRuntime();
  const seats = hostedSeatsOver({ rt, db: testSql.db });
  const { actor } = await seats.seat(name, 'subordinate');
  const asked: string[] = [];

  const open = async (turnId: string, message: string, item: { metadata?: { drainTurnId?: string } }) => {
    const lease = actor.session.beginTurn({ runId: `run-${turnId}`, turnId }, 'build', 0);
    await actor.session.openTurnInput(lease, {
      item, message: { role: 'user', content: message },
      birthContext: async (drainTurnId) => {
        asked.push(drainTurnId);

        return BIRTH;
      },
    });

    return lease;
  };

  return { actor, asked, open, close: () => { seats.host.releaseAll(); testSql.close(); } };
}

test('a delivery reply on an actor with no conversation is born from the delivery it answers', async () => {
  const s = await seated('born');

  try {
    const lease = await s.open('turn-1', 'write the report', { metadata: { drainTurnId: 'parent-turn-7' } });

    expect(s.asked).toEqual(['parent-turn-7']);
    expect(s.actor.session.history.map(textOf)).toEqual([...BIRTH.map(textOf), 'write the report']);
    s.actor.session.finishTurn(lease);
  } finally {
    s.close();
  }
});

test('a delivery reply on an actor with a conversation keeps it and never asks for a birth', async () => {
  const s = await seated('grown');

  try {
    const first = await s.open('turn-1', 'hello', {});
    s.actor.session.finishTurn(first);
    const second = await s.open('turn-2', 'now answer this delivery', { metadata: { drainTurnId: 'parent-turn-7' } });

    expect(s.asked).toEqual([]);
    expect(s.actor.session.history.map(textOf)).toEqual(['hello', 'now answer this delivery']);
    s.actor.session.finishTurn(second);
  } finally {
    s.close();
  }
});

test('a plain turn appends its input and never asks for a birth', async () => {
  const s = await seated('plain');

  try {
    const lease = await s.open('turn-1', 'continue', {});

    expect(s.asked).toEqual([]);
    expect(s.actor.session.history.map(textOf)).toEqual(['continue']);
    s.actor.session.finishTurn(lease);
  } finally {
    s.close();
  }
});
