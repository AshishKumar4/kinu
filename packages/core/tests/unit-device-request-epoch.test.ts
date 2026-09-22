/**
 * KINU-N004: a device RPC id belongs to one isolate lifetime. A woken hub restarts its counter while an
 * abandoned command still runs, so ids are `rpc-<epoch>-<n>`. Each lifetime is a fresh module evaluation.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JsonValueSchema } from '../src/utils/json';
import type * as DeviceTunnelModule from '../src/execution/device-tunnel';
import type { TunnelSocket } from '../src/execution/device-tunnel';

type TunnelModule = typeof DeviceTunnelModule;

/** One isolate lifetime of the tunnel module; the runtime specifier gives each its own registry entry and epoch. */
async function isolateLifetime(tag: string): Promise<TunnelModule> {
  const specifier = `../src/execution/device-tunnel.ts?lifetime=${tag}`;

  return await import(specifier);
}

const SentFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.array(JsonValueSchema),
});

/** The hibernatable socket that survives eviction, so a late answer still lands. */
function fakeSocket() {
  const sent: v.InferOutput<typeof SentFrameSchema>[] = [];

  const socket: TunnelSocket & { sent: typeof sent; readyState: number } = {
    readyState: 1,
    sent,
    send(data: string) { sent.push(v.parse(SentFrameSchema, JSON.parse(data))); },
  };

  return socket;
}

describe('a device request id outlives the counter that numbered it', () => {
  test('two lifetimes both start their counter at 1 and still share no id', async () => {
    const before = await isolateLifetime('evicted');
    const after = await isolateLifetime('woken');

    const spent = Array.from({ length: 64 }, () => before.nextDeviceRequestId());
    const minted = Array.from({ length: 64 }, () => after.nextDeviceRequestId());

    // The counter did restart: this is the wake being modelled.
    expect(spent[0]?.endsWith('-1')).toBe(true);
    expect(minted[0]?.endsWith('-1')).toBe(true);

    const overlap = minted.filter((id) => spent.includes(id));
    expect(overlap).toEqual([]);
  });

  test('ids stay unique within one lifetime too', async () => {
    // Negative control: an epoch that never advanced its counter would also pass the test above.
    const life = await isolateLifetime('single');
    const ids = Array.from({ length: 256 }, () => life.nextDeviceRequestId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a woken hub's call is not settled by the previous life's late answer", async () => {
    const before = await isolateLifetime('before-wake');
    const after = await isolateLifetime('after-wake');

    // Issued before eviction; the machine keeps running it.
    const abandoned = before.nextDeviceRequestId();

    // The first call of the new life, which a restarted counter would number like the abandoned one.
    const socket = fakeSocket();
    const tunnel = new after.DeviceTunnel(socket);
    const fresh = tunnel.rpc('exec', ['echo mine'], { timeoutMs: 0 });
    let settled = false;
    void fresh.then(() => { settled = true; }, () => { settled = true; });

    tunnel.handleMessage(JSON.stringify({
      id: abandoned, result: { stdout: 'from the previous life', exitCode: 0 },
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    tunnel.handleMessage(JSON.stringify({
      id: socket.sent[0]?.id, result: { stdout: 'mine', exitCode: 0 },
    }));
    expect(await fresh).toEqual({ stdout: 'mine', exitCode: 0 });
  });

  test('the cancellation handle is bound to the same identity', async () => {
    // The daemon registers the process group under the id, so a reused id would aim a stop at the wrong command.
    const before = await isolateLifetime('stop-before');
    const after = await isolateLifetime('stop-after');
    const abandoned = before.nextDeviceRequestId();
    const reissued = after.nextDeviceRequestId();

    expect(() => after.parseDeviceCancelAnswer(reissued, {
      requestId: abandoned, cancelled: 'terminated',
    })).toThrow(after.DEVICE_CANCEL_MISPAIRED);
  });
});
