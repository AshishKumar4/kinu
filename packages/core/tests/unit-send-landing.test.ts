/**
 * Where a message a tab sent to the running turn ended, as the composer is told: from the workspace's record, asked
 * again across sockets that close, never from a broadcast the tab may have missed.
 */
import { describe, expect, test } from 'bun:test';
import { sendLanding, type SendState } from '../src/index';
import { KinuError } from '../src/obs/index';

/** A socket whose `awaitSend` answers in turn from `answers`: a state, or a rejection with the socket open or closed. */
function record(answers: ReadonlyArray<SendState | { readonly rejects: string; readonly open: boolean }>) {
  let open = true;
  const asked: string[] = [];

  return {
    asked,
    record: {
      open: () => open,
      awaitSend: async (id: string): Promise<SendState> => {
        const answer = answers[asked.length];

        asked.push(id);

        if (answer === undefined) throw new Error('asked once too often');

        if ('rejects' in answer) {
          open = answer.open;
          throw new Error(answer.rejects);
        }

        open = true;

        return answer;
      },
    },
  };
}

const read = { status: 'settled', turnId: 'running', landed: 'mid-turn', outcome: 'completed' } as const;

describe('a message sent to the running turn', () => {
  test('lands where the record says, asked again on the next socket when the one it waited on closed', async () => {
    const { asked, record: socket } = record([{ rejects: 'Connection closed', open: false }, read]);

    expect(await sendLanding(socket, Promise.resolve(), 'm-1')).toBe('mid-turn');
    expect(asked).toEqual(['m-1', 'm-1']);
  });

  test('a send whose socket closed before its answer is asked about by name: the record knows it landed', async () => {
    let open = false;

    const socket = {
      open: () => open,
      awaitSend: async (): Promise<SendState> => {
        open = true;

        return { status: 'settled', turnId: 'm-1', landed: 'turn', outcome: 'completed' };
      },
    };

    expect(await sendLanding(socket, Promise.reject(new Error('Connection closed')), 'm-1')).toBe('turn');
  });

  test('a send refused on a socket that held is the refusal, and the record is never asked', async () => {
    const { asked, record: socket } = record([]);

    await expect(sendLanding(socket, Promise.reject(new Error('message m-1 was already sent')), 'm-1'))
      .rejects.toMatchObject({ message: 'sending to the running turn', cause: new Error('message m-1 was already sent') });
    expect(asked).toEqual([]);
  });

  test('one no turn took goes back to the composer', async () => {
    const { record: socket } = record([{ status: 'none' }]);
    const failed = await sendLanding(socket, Promise.resolve(), 'm-1').then(() => null, (...rejected: [unknown]) => rejected[0]);

    expect(failed instanceof KinuError ? failed.code : failed).toBe('cancelled');
  });
});
