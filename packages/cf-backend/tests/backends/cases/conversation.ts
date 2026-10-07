import { seedTranscriptEntry } from '@kinu.run/test-utils';
/** The conversation itself: what the owner sends, and taking it back. */
import { expect } from 'bun:test';
import { Effect } from 'effect';
import { CHAT_SESSION_ID, CLEAR_NEEDS_IDLE, type ActorHandle, type SessionHistory, type SqlExecutor } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { SharedCase } from '../cases';

/** One question and its answer, as a settled turn records them. */
async function exchange(history: SessionHistory, id: string, question: string, answer: string): Promise<void> {
  await seedTranscriptEntry(history, CHAT_SESSION_ID, {
    id, origin: 'input', message: { role: 'user', content: question },
  });
  await seedTranscriptEntry(history, CHAT_SESSION_ID, {
    id: `${id}-answer`, origin: 'output', message: { role: 'assistant', content: answer },
  });
}

async function spoken(history: SessionHistory): Promise<string[][]> {
  return (await history.transcript(CHAT_SESSION_ID).history()).map((message) => [
    message.role, message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
  ]);
}

/** Every context and revision row the actor holds: a revert forks a context before its last fence. */
function contextRows(sql: SqlExecutor, actor: ActorHandle): number[] {
  return [
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_contexts WHERE actor_id=${actor.actorId}`[0]?.n ?? 0,
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM context_revisions WHERE actor_id=${actor.actorId}`[0]?.n ?? 0,
  ];
}

export const CONVERSATION_CASES: readonly SharedCase[] = [
  {
    title: 'an empty message is refused at the door and records nothing',
    covers: ['send'],
    async run({ surface, history }) {
      await expect(surface.send('   ')).rejects.toThrow('send requires the message text');
      expect(await spoken(history)).toEqual([]);
    },
  },
  {
    title: 'a message id already sent is refused, and the words are not sent twice',
    covers: ['send'],
    async run({ surface, history }) {
      await exchange(history, 'q-1', 'Name the release.', 'Aurora.');

      await expect(surface.send('Name it again.', 'q-1')).rejects.toThrow('message q-1 was already sent');
      expect(await spoken(history)).toEqual([['user', 'Name the release.'], ['assistant', 'Aurora.']]);
    },
  },
  {
    title: 'a send reads settled under the turn that took it once answered; an id never sent reads none',
    covers: ['sendState', 'awaitSend'],
    async run({ surface }) {
      await surface.send('Name the release.', 'q-1');
      const settled = { status: 'settled', turnId: 'q-1', landed: 'turn', outcome: 'completed' } as const;

      expect(await surface.awaitSend('q-1')).toEqual(settled);
      expect(await surface.sendState('q-1')).toEqual(settled);
      expect(await surface.sendState('never-sent')).toEqual({ status: 'none' });
    },
  },
  {
    title: 'reverting to a message drops it and everything after; an unknown entry is refused',
    covers: ['revertConversation'],
    async run({ surface, history }) {
      await exchange(history, 'q-1', 'Name the release.', 'Aurora.');
      await exchange(history, 'q-2', 'Shorter.', 'Aur.');

      await surface.revertConversation('q-2');
      expect(await spoken(history)).toEqual([['user', 'Name the release.'], ['assistant', 'Aurora.']]);
      await expect(surface.revertConversation('q-9')).rejects.toThrow('conversation entry does not exist');
    },
  },
  {
    title: 'a clear while a turn runs is refused and keeps the conversation; once idle it empties it',
    covers: ['clearConversation'],
    async run({ surface, history, holdTurn }) {
      await exchange(history, 'q-1', 'Name the release.', 'Aurora.');
      const running = await holdTurn('Shorter.', 'build');

      try {
        await expect(surface.clearConversation()).rejects.toThrow(CLEAR_NEEDS_IDLE);
        expect((await spoken(history)).slice(0, 2)).toEqual([['user', 'Name the release.'], ['assistant', 'Aurora.']]);
      } finally {
        await running.release();
      }

      await surface.clearConversation();
      expect(await spoken(history)).toEqual([]);
    },
  },
  {
    title: 'a fence refusing after the revert has forked rolls the whole transaction back',
    covers: ['revertConversation'],
    async run({ history, sql, actor }) {
      await exchange(history, 'q-1', 'Name the release.', 'Aurora.');
      await exchange(history, 'q-2', 'Shorter.', 'Aur.');
      const before = contextRows(sql, actor);
      let checks = 0;

      const idle = () => Effect.suspend(() => {
        checks += 1;

        return checks > 1 ? Effect.fail(new KinuError('denied', 'a turn started mid-revert')) : Effect.void;
      });

      expect(() => history.revertTo(CHAT_SESSION_ID, 'q-2', idle)).toThrow('a turn started mid-revert');
      expect(checks).toBe(2);
      expect(contextRows(sql, actor)).toEqual(before);
      expect(await spoken(history)).toEqual([['user', 'Name the release.'], ['assistant', 'Aurora.'], ['user', 'Shorter.'], ['assistant', 'Aur.']]);
    },
  },
  {
    title: 'a redirect branches only a running Build turn: a Plan turn refuses it before any head runs',
    covers: ['branchTurn'],
    async run({ surface, holdTurn }) {
      await expect(surface.branchTurn('   ')).rejects.toThrow('branchTurn requires the redirect text');
      expect(await surface.branchTurn('Try the other route.'))
        .toEqual({ accepted: false, reason: 'No turn is running: send it as a normal message instead.' });

      const planning = await holdTurn('Plan the migration.', 'plan');

      try {
        expect(await surface.branchTurn('Just do it in parallel.'))
          .toEqual({ accepted: false, reason: 'Plan turns cannot start mutating branches. Review or finish the plan first.' });
      } finally {
        await planning.release();
      }

      expect(await surface.latestAlternateTakes()).toBeNull();
    },
  },
  {
    title: 'an optimisation with no low-rated turns has nothing to learn from, and no model runs',
    covers: ['runOptimization'],
    async run({ surface }) {
      expect(await surface.runOptimization()).toEqual({ kind: 'idle' });
    },
  },
];
