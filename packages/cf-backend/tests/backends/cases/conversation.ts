/** The conversation itself: what the owner sends, and taking it back. */
import { expect } from 'bun:test';
import { CHAT_SESSION_ID, type SessionHistory } from '@kinu.run/core';
import type { SharedCase } from '../cases';

/** One question and its answer, as a settled turn records them. */
async function exchange(history: SessionHistory, id: string, question: string, answer: string): Promise<void> {
  const transcript = history.transcript(CHAT_SESSION_ID);
  await history.record(CHAT_SESSION_ID, {
    id, parentId: transcript.newestId(), origin: 'input', message: { role: 'user', content: question },
  });
  await history.record(CHAT_SESSION_ID, {
    id: `${id}-answer`, parentId: id, origin: 'output', message: { role: 'assistant', content: answer },
  });
}

async function spoken(history: SessionHistory): Promise<string[][]> {
  return (await history.transcript(CHAT_SESSION_ID).history()).map((message) => [
    message.role, message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
  ]);
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
    title: 'a scaffold optimisation with no labelled turns is refused before any model runs',
    covers: ['runScaffoldGepaOptimization'],
    async run({ surface }) {
      expect(await surface.runScaffoldGepaOptimization({ maxIterations: 1 })).toEqual({
        ok: false, error: 'no outcome-labeled turns yet — chat with the agent first',
      });
    },
  },
];
