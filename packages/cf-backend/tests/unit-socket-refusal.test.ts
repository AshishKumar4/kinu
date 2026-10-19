/**
 * A frame refused for its authority is answered and its socket closed; a frame refused beside it, whose answer is due
 * on the socket that refusal closed, is sent nothing and throws nothing. Staging rc20 (2026-10-19): a workspace deleted
 * under an open tab refused two of its frames together, and the second's answer threw out of `webSocketMessage`.
 */
import { afterEach, expect, test } from 'bun:test';
import type { Connection } from 'agents';
import { gatedClientHandlers, type ClientHandlers } from '../src/client-socket-gate';
import { sessionBearerConnectionTag } from '../src/cli/rpc-gate';
import { socketConnection } from './helpers/bindings';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';

const users: TestUserDO[] = [];

afterEach(() => {
  for (const user of users.splice(0)) user.close();
});

/** A tab's socket as workerd keeps it: closed once, and any send or close after that throws. */
function closingSocket() {
  const sent: string[] = [];
  const closed: number[] = [];
  let open = true;

  const socket: Connection = socketConnection({
    id: 'tab-1',
    tags: [sessionBearerConnectionTag('a'.repeat(64)) ?? ''],
    send: (frame: string) => {
      if (!open) throw new TypeError('WebSocket send() after close');
      sent.push(frame);
    },
    close: (code?: number) => {
      if (!open) throw new TypeError('WebSocket close() after close');
      open = false;
      closed.push(code ?? 0);
    },
  });

  Object.defineProperty(socket, 'readyState', { get: () => (open ? WebSocket.OPEN : WebSocket.CLOSED) });

  return { socket, sent, closed };
}

test('two frames refused together: one answer, one close, and nothing thrown', async () => {
  const user = createTestUserDO();
  const asked: (() => void)[] = [];
  const bothAsked = Promise.withResolvers<void>();

  users.push(user);
  // Each frame's check waits until both are asked: they are refused together, as a deleted workspace's were.
  user.userDO.verifySocketSession = async () => {
    const { promise, resolve } = Promise.withResolvers<void>();

    asked.push(resolve);

    if (asked.length === 2) bothAsked.resolve();
    await promise;

    return { live: false };
  };

  const owner = await testOwner();
  const unreached = async (): Promise<never> => { throw new Error('a refused frame reaches nothing past the gate'); };

  const base: ClientHandlers = { onMessage: unreached, onConnect: unreached, onClose: unreached, onRequest: unreached };

  const handlers = gatedClientHandlers({
    storageRefusal: () => undefined,
    runtimeRefusal: () => null,
    terminalFor: async () => null,
    hostedWindowName: () => null,
    chatRoomFor: () => null,
    history: async () => undefined,
    overviewChanged: () => {},
    connectionOpened: () => {},
    lastConnectionClosed: () => {},
    turnClaimFrame: () => '',
    connections: () => [],
    ownerHub: () => user.userDO,
    caller: async () => owner,
    workspace: () => 'refused-together',
  }, base);

  const { socket, sent, closed } = closingSocket();
  const rpc = (id: string) => JSON.stringify({ type: 'rpc', id, method: 'awaitSend', args: ['m1'] });
  const handled = [handlers.onMessage(socket, rpc('first')), handlers.onMessage(socket, rpc('second'))];

  await bothAsked.promise;

  for (const answer of asked) answer();

  expect(await Promise.allSettled(handled)).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
  expect({ answered: sent.length, closed: closed.length }).toEqual({ answered: 1, closed: 1 });
});
