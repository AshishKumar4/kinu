/**
 * A socket call that fails is logged with its code and message as fields. Found on prod 2026-09-29
 * (ironwood-cairn-6dbcb8de): the SDK's own line for a refused revert read "RPC error:     at index.js:100627:29", the
 * refusal's words and class nowhere in it.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { PROBE_REFUSAL } from './socket-call-probe';

const RpcFrameSchema = v.object({ type: v.literal('rpc'), id: v.string(), success: v.boolean(), error: v.optional(v.string()) });

/** Kept referenced: workerd closes a socket whose unreferenced client end is collected. */
const clients = new Set<WebSocket>();

async function socketTo(name: string): Promise<{ call(id: string, method: string): Promise<v.InferOutput<typeof RpcFrameSchema>> }> {
  const response = await env.SOCKET_CALL_PROBE.get(env.SOCKET_CALL_PROBE.idFromName(name)).fetch('https://probe/', {
    headers: { Upgrade: 'websocket' },
  });

  const socket = response.webSocket;

  expect(response.status).toBe(101);

  if (socket === null) throw new Error('the probe answered the upgrade with no socket');
  clients.add(socket);
  socket.accept();

  const answers = new Map<string, (frame: v.InferOutput<typeof RpcFrameSchema>) => void>();

  socket.addEventListener('message', (message) => {
    const frame = v.safeParse(RpcFrameSchema, JSON.parse(String(message.data)));

    if (frame.success) answers.get(frame.output.id)?.(frame.output);
  });

  return {
    call: (id, method) => new Promise((resolve) => {
      answers.set(id, resolve);
      socket.send(JSON.stringify({ type: 'rpc', id, method, args: [] }));
    }),
  };
}

describe('a socket call that fails', () => {
  it('is logged with its code and message, and the caller gets the refusal in its own words', async () => {
    const probe = env.SOCKET_CALL_PROBE.get(env.SOCKET_CALL_PROBE.idFromName('refused'));
    await probe.record();

    const socket = await socketTo('refused');

    expect(await socket.call('ok', 'answer')).toMatchObject({ success: true });
    expect(await socket.call('no', 'refuse')).toMatchObject({ success: false, error: PROBE_REFUSAL });
    // Outside a socket call the failure goes to its caller, which reports it.
    expect(await probe.refuseWithoutASocket()).toBe(PROBE_REFUSAL);

    expect((await probe.logged()).filter((line) => line.event === 'rpc.socket_call_failed')).toEqual([
      { event: 'rpc.socket_call_failed', code: 'denied', cause: expect.stringContaining(PROBE_REFUSAL), fields: { method: 'refuse' } },
    ]);
  });
});
