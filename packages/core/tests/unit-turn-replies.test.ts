import { expect, test } from 'bun:test';
import { TurnReplies } from '../src/orchestrator/turn-replies';

/** Everything a reply holds until it ends: its pieces, and why it ended when it did not end cleanly. */
async function readAll(reply: ReadableStream<Uint8Array>): Promise<{ pieces: string[]; failure: string | null }> {
  const reader = reply.getReader();
  const decoder = new TextDecoder();
  const pieces: string[] = [];

  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) pieces.push(decoder.decode(read.value));

    return { pieces, failure: null };
  } catch (cause) {
    return { pieces, failure: cause instanceof Error ? cause.message : String(cause) };
  }
}

const shown = (id: string) => ({ type: 'signal_card', id, state: 'shown' } as const);

test('a reply is its turn\'s text from where the message landed, in order, and ends with the turn', async () => {
  const replies = new TurnReplies();
  const reply = replies.open('sig:a');

  // Written before the message landed: the turn's own words to someone else.
  replies.feed('turn-1', 'Looking. ');
  replies.card(shown('sig:a'), 'turn-1');
  replies.feed('turn-1', 'Three ');
  replies.feed('turn-2', 'not this turn ');
  replies.feed('turn-1', 'cards.');
  replies.ended('turn-1', null);

  expect(await readAll(reply)).toEqual({ pieces: ['Three ', 'cards.'], failure: null });
});

test('a reply ends with why when its turn is stopped or fails, or when its message never lands', async () => {
  const replies = new TurnReplies();
  const stopped = replies.open('sig:stopped');
  const lost = replies.open('sig:lost');

  replies.card(shown('sig:stopped'), 'turn-1');
  replies.feed('turn-1', 'Half');
  replies.ended('turn-1', 'The turn was interrupted before it finished.');
  replies.card({ type: 'signal_card', id: 'sig:lost', state: 'undelivered' }, null);
  // A later end of the same turn changes nothing: the reply already ended.
  replies.ended('turn-1', null);

  expect(await readAll(stopped)).toEqual({ pieces: ['Half'], failure: 'The turn was interrupted before it finished.' });
  expect(await readAll(lost)).toEqual({ pieces: [], failure: 'The message was not delivered to the agent, so no turn answers it' });
});

test('a reader that lets its reply go is fed nothing more', async () => {
  const replies = new TurnReplies();
  const reply = replies.open('sig:a');

  replies.card(shown('sig:a'), 'turn-1');
  await reply.cancel();

  expect(() => { replies.feed('turn-1', 'after'); replies.ended('turn-1', null); }).not.toThrow();
});
