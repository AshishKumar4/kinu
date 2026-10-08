// Measured 2026-10-04, workerd 2026-09-30: resetting the source rejects its RPC stream as disconnected prematurely.
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import * as v from 'valibot';
import { DEVICE_METHOD, DEVICE_RELAY, JsonValueSchema } from '@kinu.run/core';
import { deviceRouteFetch } from '../../src/egress/model-relay-route';

it('a UserDO reset mid-relay reaches its caller as an interrupted device relay', async () => {
  const stub = env.DEVICE_LEDGER_PROBE.get(env.DEVICE_LEDGER_PROBE.idFromName('relay-eviction'));
  const upgraded = await stub.fetch('https://probe/device', { headers: { Upgrade: 'websocket' } });
  const machine = upgraded.webSocket;

  if (machine === null) throw new Error('the probe did not accept its machine');
  machine.accept();
  machine.addEventListener('message', (event) => {
    const frame = v.parse(v.object({ id: v.string(), method: v.string(), params: v.array(JsonValueSchema) }), JSON.parse(String(event.data)));

    if (frame.method === DEVICE_METHOD.codexRelay) {
      machine.send(JSON.stringify({ type: DEVICE_RELAY.head, relay: frame.id, status: 200, headers: [] }));
    } else if (frame.method === DEVICE_METHOD.ping) {
      machine.send(JSON.stringify({ id: frame.id, result: 'pong' }));
    }
  });

  const routed = deviceRouteFetch({
    provider: 'codex',
    caller: async () => ({ workspaceToken: 'probe' }),
    hub: {
      relayDevice: async () => ({ id: 'dev-probe', label: 'test machine' }),
      relayModelCall: (_caller, _device, id) => stub.relayFor(id),
      cancelModelRelay: async (_caller, id) => { await stub.cancelRelayFor(id); },
    },
  });

  try {
    const response = await routed('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: '{}' });
    const reader = response.body?.getReader();

    if (reader === undefined) throw new Error('the relay returned no stream');
    const reading = reader.read();
    await abortAllDurableObjects();
    await expect(reading).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('device relay was interrupted') });
  } finally {
    machine.close();
  }
});
