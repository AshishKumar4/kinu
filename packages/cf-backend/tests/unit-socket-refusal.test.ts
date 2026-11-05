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

async function gate(user: TestUserDO, onMessage: ClientHandlers['onMessage']) {
  const owner = await testOwner();
  const unreached = async (): Promise<never> => { throw new Error('a refused frame reaches nothing past the gate'); };

  const base: ClientHandlers = { onMessage, onConnect: unreached, onClose: unreached, onRequest: unreached };

  return gatedClientHandlers({
    storageRefusal: () => undefined,
    runtimeRefusal: () => null,
    terminalFor: async () => null,
    hostedWindowName: () => null,
    chatRoomFor: () => null,
    seed: async () => undefined,
    media: async () => undefined,
    overviewChanged: () => {},
    connectionOpened: () => {},
    lastConnectionClosed: () => {},
    turnClaimFrame: () => '',
    connections: () => [],
    ownerHub: () => user.userDO,
    caller: async () => owner,
    workspace: () => 'refused-together',
  }, base);
}

const rpc = (id: string) => JSON.stringify({ type: 'rpc', id, method: 'awaitSend', args: ['m1'] });

test('two frames refused together: one answer, one close, and nothing thrown', async () => {
  const user = createTestUserDO();
  const asking = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<void>();

  users.push(user);
  // The check waits until both frames are in: they are refused together, as a deleted workspace's were.
  user.userDO.verifySocketSession = async () => {
    asking.resolve();
    await answer.promise;

    return { live: false };
  };

  const handlers = await gate(user, async () => { throw new Error('a refused frame reaches nothing past the gate'); });
  const { socket, sent, closed } = closingSocket();
  const handled = [handlers.onMessage(socket, rpc('first')), handlers.onMessage(socket, rpc('second'))];

  await asking.promise;
  answer.resolve();

  expect(await Promise.allSettled(handled)).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
  expect({ answered: sent.length, closed: closed.length }).toEqual({ answered: 1, closed: 1 });
});

test("a burst of frames asks the account once whether its session is live, and a revocation refuses the next frame", async () => {
  const user = createTestUserDO();
  let live = true;
  let asked = 0;
  const answer = Promise.withResolvers<void>();

  users.push(user);

  user.userDO.verifySocketSession = async () => {
    asked += 1;
    await answer.promise;

    return { live };
  };

  let passed = 0;
  const handlers = await gate(user, async () => { passed += 1; });
  const { socket, closed } = closingSocket();
  // Binary frames, as a shell's keystrokes come: the gate passes them straight to the actor once their check holds.
  const burst = ['a', 'b', 'c', 'd', 'e'].map((id) => handlers.onMessage(socket, new TextEncoder().encode(id)));

  answer.resolve();
  await Promise.all(burst);
  const burstAsked = asked;

  // Revoked once the burst's check settled: the next frame's check is asked afresh, and refuses it.
  live = false;
  await handlers.onMessage(socket, new TextEncoder().encode('after'));

  expect({ burstAsked, passed, asked, closed: closed.length }).toEqual({ burstAsked: 1, passed: 5, asked: 2, closed: 1 });
});
