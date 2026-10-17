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

/** An RPC frame its test names, as the gate passes it on: binary, so it goes to the Agent base and no chat room. */
function frame(name: string): WSMessage {
  return new TextEncoder().encode(name);
}

/** A chat frame: a send, which the gate hands to the chat room. */
const CHAT_SEND = JSON.stringify({ type: 'cf_agent_use_chat_request', id: 'send', init: {} });

function nameOf(message: WSMessage): string {
  return typeof message === 'string' ? message : new TextDecoder().decode(message);
}

/** Microtask turns only, no timer: what a frame does before the next task turn has happened by the end of these. */
async function microtasks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

/**
 * A gate over a browser session whose authority the owner's user object answers when the test says, frame by frame.
 * `reached` records each frame as it arrives: an RPC at the Agent base, a chat frame at the room, which here is the
 * gate's answer that no room is hosted (the room is a class the test does not build). `handle` is what the base then
 * does with an RPC frame.
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

  const socket: Connection = socketConnection({
    id: 'tab-1', tags: [sessionBearerConnectionTag('a'.repeat(64)) ?? ''], send: () => { reached.push('send'); },
  });

  return { handlers, socket, asked, bothAsked, reached };
}

test("a socket's frames go on in the order they came, though the second's authority answers first", async () => {
  const { handlers, socket, asked, bothAsked, reached } = await gated();
  const stop = handlers.onMessage(socket, frame('stop'));
  const send = handlers.onMessage(socket, CHAT_SEND);

  await bothAsked;
  // The Continue's check answers first, the Stop's on the same turn after it.
  asked[1]?.();
  asked[0]?.();
  await Promise.all([stop, send]);

  expect(reached).toEqual(['stop', 'send']);
});

test("an RPC that takes steps to reach the room stays ahead of the chat frame sent after it", async () => {
  // As the Stop's RPC reaches the chat room through the Agent base's dispatch, a send's chat frame by fewer steps.
  const { handlers, socket, asked, bothAsked, reached } = await gated(async (name) => {
    if (name === 'stop') await microtasks(60);
  });

  const reachedRoom: string[] = [];
  const stop = Promise.resolve(handlers.onMessage(socket, frame('stop'))).then(() => { reachedRoom.push('stop'); });
  const send = Promise.resolve(handlers.onMessage(socket, CHAT_SEND)).then(() => { reachedRoom.push('send'); });

  await bothAsked;
  asked[1]?.();
  asked[0]?.();
  await Promise.all([stop, send]);

  expect({ reached, reachedRoom }).toEqual({ reached: ['stop', 'send'], reachedRoom: ['stop', 'send'] });
});

test('a read is not held a task turn behind the read before it', async () => {
  // Queued a turn apiece, a burst of reads took three times as long and a page dropped each answer as stale (rc15).
  const { handlers, socket, asked, bothAsked, reached } = await gated();
  const first = handlers.onMessage(socket, frame('read-1'));
  const second = handlers.onMessage(socket, frame('read-2'));

  await bothAsked;
  asked[0]?.();
  asked[1]?.();
  await microtasks(200);

  expect(reached).toEqual(['read-1', 'read-2']);
  await Promise.all([first, second]);
});

test("a frame whose handler waits on a long turn does not hold the next frame back", async () => {
  const { promise: turnEnds, resolve: endTurn } = Promise.withResolvers<void>();

  // The first frame's handler waits until the second has reached the base: a gate that held the second behind the
  // first's whole handling would never let it.
  const { handlers, socket, asked, bothAsked, reached } = await gated(async (name) => {
    if (name === 'read') {
      endTurn();

      return;
    }

    await turnEnds;
  });

  const send = handlers.onMessage(socket, frame('turn'));
  const read = handlers.onMessage(socket, frame('read'));

  await bothAsked;
  asked[0]?.();
  asked[1]?.();
  await Promise.all([send, read]);

  expect(reached).toEqual(['turn', 'read']);
});
