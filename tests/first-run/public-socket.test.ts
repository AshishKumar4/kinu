import { expect, test } from 'bun:test';
import { openPublicSocket } from './public-socket';

test('after the socket closes, every send and wait settles at once, naming the close', async () => {
  // THE DROPPED FRAME, 2026-09-23 on the deployed build: the runtime replaced a
  // workspace's object mid-case and closed its socket (1006, "this Durable
  // Object instance is no longer active") while nothing was in flight. The next
  // frame went to the CLOSED socket, whose `send` drops it without a word, and
  // the case waited on its answer until the tier's deadline.
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, host) => (host.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 })),
    websocket: {
      open(ws) { ws.close(1012, 'instance replaced'); },
      message() {},
    },
  });

  try {
    const socket = openPublicSocket(`http://127.0.0.1:${String(server.port)}`, { kind: 'loopback' },
      '/agents/orchestrator-agent/room', new AbortController().signal);

    expect(await socket.opened).toBe(true);
    // A wait that was pending when the socket closed ends on the close.
    expect(await socket.broadcast('cf_agent_state')).toBe(false);

    await expect(socket.rpc('getActivitySnapshot', [])).rejects.toThrow('closed (1012: instance replaced)');
    await expect(socket.chat('hello')).rejects.toThrow('closed (1012: instance replaced)');
    expect(await socket.turnClosed()).toBe(false);
  } finally {
    await server.stop(true);
  }
});
