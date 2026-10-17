/**
 * A socket's frames reach the actor in the order they were sent. Each frame's authority is asked of the owner's user
 * object first, and those answers come back in any order: on staging rc12 (titled-chat, 2026-10-16) a Continue sent
 * 42 ms after its Stop was let in first, and the Stop then handed it back.
 */
import { afterEach, expect, test } from 'bun:test';
import type { Connection, WSMessage } from 'agents';
import { gatedClientHandlers, type ClientHandlers } from '../src/client-socket-gate';
import { sessionBearerConnectionTag } from '../src/cli/rpc-gate';
import { socketConnection } from './helpers/bindings';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';

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

/**
 * A gate over a browser session whose authority the owner's user object answers when the test says, frame by frame,
 * and a base that records what reached it. `handle` is what the base does with each frame once it arrives.
 */
async function gated(handle: (name: string) => Promise<void> = async () => {}) {
  const user = createTestUserDO();
  const asked: (() => void)[] = [];
  const reached: string[] = [];
  const { promise: bothAsked, resolve: secondAsked } = Promise.withResolvers<void>();

  users.push(user);
  // Each check waits for the test's word, so the test decides which frame's authority answers first.
  user.userDO.verifySocketSession = async () => {
    const { promise, resolve } = Promise.withResolvers<void>();

    asked.push(resolve);

    if (asked.length === 2) secondAsked();
    await promise;

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
    chatRoomFor: () => null,
    history: async () => undefined,
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

  return { handlers, socket, asked, bothAsked, reached };
}

test("a socket's frames go on in the order they came, though the second's authority answers first", async () => {
  const { handlers, socket, asked, bothAsked, reached } = await gated();
  const stop = handlers.onMessage(socket, frame('stop'));
  const send = handlers.onMessage(socket, frame('send'));

  await bothAsked;
  // The Continue's check answers first, the Stop's on the same turn after it.
  asked[1]?.();
  asked[0]?.();
  await Promise.all([stop, send]);

  expect(reached).toEqual(['stop', 'send']);
});

test("a frame whose handler takes steps to its place keeps it ahead of the shallower frame sent after it", async () => {
  // As the Stop's RPC reaches the chat room through the Agent base's dispatch, a send's chat frame by fewer steps.
  const steps = async (left: number): Promise<void> => {
    if (left > 0) await steps(left - 1);
  };

  const placed: string[] = [];

  const { handlers, socket, asked, bothAsked } = await gated(async (name) => {
    if (name === 'stop') await steps(12);
    placed.push(name);
  });

  const stop = handlers.onMessage(socket, frame('stop'));
  const send = handlers.onMessage(socket, frame('send'));

  await bothAsked;
  asked[1]?.();
  asked[0]?.();
  await Promise.all([stop, send]);

  expect(placed).toEqual(['stop', 'send']);
});

test("a frame whose handler waits on a long turn does not hold the next frame back", async () => {
  const { promise: turnEnds, resolve: endTurn } = Promise.withResolvers<void>();

  // The first frame's handler waits until the second has reached the base: a gate that held the second behind the
  // first's whole handling would never let it.
  const { handlers, socket, asked, bothAsked, reached } = await gated(async (name) => {
    if (name === 'stop') {
      endTurn();

      return;
    }

    await turnEnds;
  });

  const send = handlers.onMessage(socket, frame('send'));
  const stop = handlers.onMessage(socket, frame('stop'));

  await bothAsked;
  asked[0]?.();
  asked[1]?.();
  await Promise.all([send, stop]);

  expect(reached).toEqual(['send', 'stop']);
});
