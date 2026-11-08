/**
 * A socket's frames reach the actor in the order they were sent. Each frame's authority is asked of the owner's user
 * object first: on staging rc12 (titled-chat, 2026-10-16) a Continue sent 42 ms after its Stop was let in first, and
 * the Stop then handed it back. Frames that arrive together join one check, which answers them all on one turn.
 */
import { afterEach, expect, test } from 'bun:test';
import type { Connection, WSMessage } from 'agents';
import { ChatWireTransport } from '../src/chat-transport';
import { gatedClientHandlers, type ClientHandlers } from '../src/client-socket-gate';
import { sessionBearerConnectionTag } from '../src/cli/rpc-gate';
import { socketConnection } from './helpers/bindings';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';
import { chatRequest } from './helpers/chat-frames';

const users: TestUserDO[] = [];

afterEach(() => {
  for (const user of users.splice(0)) user.close();
});

/** A frame its test names, as the gate passes it on: binary, so no chat room is asked for it. */
function frame(name: string): WSMessage {
  return new TextEncoder().encode(name);
}

function nameOf(message: WSMessage): string {
  return typeof message === 'string' ? message : new TextDecoder().decode(message);
}

/** A send from the chat's composer, as the SDK's transport frames it. */

/**
 * A gate over a browser session whose authority the owner's user object answers when the test says, frame by frame,
 * and a base that records what reached it. `handle` is what the base does with each frame once it arrives; `room`
 * takes the chat frames.
 */
async function gated(handle: (name: string) => Promise<void> = async () => {}, room: ChatWireTransport | null = null) {
  const user = createTestUserDO();
  const reached: string[] = [];
  const { promise: checkAsked, resolve: asking } = Promise.withResolvers<void>();
  const { promise: answered, resolve: answer } = Promise.withResolvers<void>();

  users.push(user);
  // The check waits for the test's word, so both frames are in before it answers.
  user.userDO.verifySocketSession = async () => {
    asking();
    await answered;

    return { live: true };
  };

  const owner = await testOwner();
  const unused = async (): Promise<never> => { throw new Error('not reached in this test'); };

  const base: ClientHandlers = {
    onMessage: async (_connection, message) => {
      reached.push(nameOf(message));
      await handle(nameOf(message));
    },
    onConnect: unused, onClose: unused, onRequest: unused,
  };

  const handlers = gatedClientHandlers({
    storageRefusal: () => undefined,
    runtimeRefusal: () => null,
    terminalFor: async () => null,
    hostedWindowName: () => null,
    chatRoomFor: () => room,
    seed: async () => undefined,
    media: async () => undefined,
    overviewChanged: () => {},
    connectionOpened: () => {},
    lastConnectionClosed: () => {},
    turnClaimFrame: () => '',
    connections: () => [],
    ownerHub: () => user.userDO,
    caller: async () => owner,
    workspace: () => 'frame-order',
  }, base);

  const socket: Connection = socketConnection({ id: 'tab-1', tags: [sessionBearerConnectionTag('a'.repeat(64)) ?? ''] });

  return { handlers, socket, answer, checkAsked, reached };
}

test("a socket's frames go on in the order they came, though one check answers both at once", async () => {
  const { handlers, socket, answer, checkAsked, reached } = await gated();
  const stop = handlers.onMessage(socket, frame('stop'));
  const send = handlers.onMessage(socket, frame('send'));

  await checkAsked;
  answer();
  await Promise.all([stop, send]);

  expect(reached).toEqual(['stop', 'send']);
});

test("the Stop's RPC keeps its place in the room's order ahead of the send that follows it", async () => {
  // The room's order as the agent meets it: the Stop reaches the wire's interrupt, the send its send.
  const order: string[] = [];
  const { promise: sent, resolve: sendReached } = Promise.withResolvers<void>();

  const room = new ChatWireTransport({
    turnOwed: async () => false,
    steps: async function* () { yield* []; },
    broadcast: () => {},
    getConnection: () => undefined,
    seed: async () => ({ messages: [], older: null }),
    media: async () => null,
    unseen: async (ids) => ids,
    send: async (_input, admitted) => {
      order.push('send');
      sendReached();
      admitted();

      return 'turn';
    },
    retry: () => Promise.reject(new Error('not reached in this test')),
    interrupt: async () => { order.push('stop'); },
    sendState: async () => ({ status: 'none' }),
    awaitSend: async () => ({ status: 'none' }),
  });

  // The Stop's method reaches the room some steps into the Agent base's dispatch; the send's chat frame by fewer.
  const steps = async (left: number): Promise<void> => {
    if (left > 0) await steps(left - 1);
  };

  // Its handling goes on past the room (the Stop's device sweep) until the send has reached the agent: a gate that held
  // the send behind the Stop's whole handling would never let it.
  const { handlers, socket, answer, checkAsked } = await gated(async () => {
    await steps(12);
    await room.interrupt();
    await sent;
  }, room);

  const stop = handlers.onMessage(socket, JSON.stringify({ type: 'rpc', id: 'stop', method: 'cancelCurrentWork', args: [] }));
  const send = handlers.onMessage(socket, chatRequest('send', 'send'));

  await checkAsked;
  answer();
  await Promise.all([stop, send]);

  expect(order).toEqual(['stop', 'send']);
});

test("a frame whose handler waits on a long turn does not hold the next frame back", async () => {
  const { promise: turnEnds, resolve: endTurn } = Promise.withResolvers<void>();

  // The first frame's handler waits until the second has reached the base: a gate that held the second behind the
  // first's whole handling would never let it.
  const { handlers, socket, answer, checkAsked, reached } = await gated(async (name) => {
    if (name === 'stop') {
      endTurn();

      return;
    }

    await turnEnds;
  });

  const send = handlers.onMessage(socket, frame('send'));
  const stop = handlers.onMessage(socket, frame('stop'));

  await checkAsked;
  answer();
  await Promise.all([send, stop]);

  expect(reached).toEqual(['send', 'stop']);
});
