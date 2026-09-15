/**
 * Where a turn's conversation comes from — one rule, on every backend.
 *
 * A turn queued to answer a delivery (`metadata.drainTurnId`) opens on the
 * actor's own conversation when it has one, and is born from the delivery's
 * conversation when it has none; every other turn appends its input to what
 * is there. The rule lives on the actor session so the hosted root and the
 * local session cannot answer it differently, and it is read back here
 * through the session's own history.
 */
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

  const open = (turnId: string, message: string, item: { metadata?: { drainTurnId?: string }; priorOutput?: readonly ModelMessage[] }) => {
    const lease = actor.session.beginTurn({ runId: `run-${turnId}`, turnId }, 'build', 0);
    actor.session.openTurnInput(lease, {
      item, message: { role: 'user', content: message },
      birthContext: (drainTurnId) => {
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
    const lease = s.open('turn-1', 'write the report', { metadata: { drainTurnId: 'parent-turn-7' } });

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
    const first = s.open('turn-1', 'hello', {});
    s.actor.session.finishTurn(first);
    const second = s.open('turn-2', 'now answer this delivery', { metadata: { drainTurnId: 'parent-turn-7' } });

    expect(s.asked).toEqual([]);
    expect(s.actor.session.history.map(textOf)).toEqual(['hello', 'now answer this delivery']);
    s.actor.session.finishTurn(second);
  } finally {
    s.close();
  }
});

test('a plain turn appends, and a re-opened turn carries its prior output after the input', async () => {
  const s = await seated('plain');

  try {
    const lease = s.open('turn-1', 'continue', { priorOutput: [{ role: 'assistant', content: 'half an answer' }] });

    expect(s.asked).toEqual([]);
    expect(s.actor.session.history.map(textOf)).toEqual(['continue', 'half an answer']);
    s.actor.session.finishTurn(lease);
  } finally {
    s.close();
  }
});
