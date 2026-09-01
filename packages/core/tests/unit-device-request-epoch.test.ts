/**
 * KINU-N004: a device RPC id belongs to one isolate lifetime, not to a counter.
 *
 * The hub keeps one reverse socket per device, wrapped in one `DeviceTunnel`,
 * and the tunnel correlates a response purely by the id it carries. The id used
 * to be a bare instance-local counter — so a hub that was evicted and woken
 * rebuilt its tunnel with that counter back at zero WHILE a command it had
 * already given up waiting for was still running on the user's machine. When
 * that command finally answered, its id matched a pending call of the new
 * life, and one workspace read another's result.
 *
 * `nextDeviceRequestId` therefore mints `rpc-<epoch>-<n>`, where the epoch is a
 * random value the woken isolate cannot reproduce. This file is the guard for
 * that epoch, which nothing else covers: the existing tunnel tests feed a
 * hand-written `rpc-999` (an id this system never mints) and would pass just as
 * well against a bare counter.
 *
 * The two lifetimes here are two evaluations of the module. Bun keys its module
 * registry on the whole specifier, so the query suffix is what gives the second
 * import its own epoch slot — the same fresh-slot-on-wake the header of
 * `device-tunnel.ts` describes. Nothing else about the module differs, which is
 * the point: the id space has to survive a restart that changes nothing else.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JsonValueSchema } from '../src/utils/json';
import type * as DeviceTunnelModule from '../src/execution/device-tunnel';
import type { TunnelSocket } from '../src/execution/device-tunnel';

type TunnelModule = typeof DeviceTunnelModule;

/**
 * One isolate lifetime of the tunnel module — its own epoch, its own counter.
 *
 * A static import cannot express this: the module loading boundary IS the
 * subject here, and a static import binds exactly one evaluation, which is the
 * single lifetime that cannot show the defect. The specifier is therefore
 * built at runtime, because that is what gives each lifetime its own registry
 * entry and so its own epoch slot.
 */
async function isolateLifetime(tag: string): Promise<TunnelModule> {
  const specifier = `../src/execution/device-tunnel.ts?lifetime=${tag}`;
  return await import(specifier);
}

const SentFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.array(JsonValueSchema),
});

/** The surviving hibernatable socket: it outlives the eviction, which is why a
 *  woken hub can be handed one and why a late answer still has somewhere to
 *  land. */
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

    // The counter DID restart — this is the wake being modelled, not avoided.
    expect(spent[0]?.endsWith('-1')).toBe(true);
    expect(minted[0]?.endsWith('-1')).toBe(true);

    // And no id is reused, because the counter is not the identity.
    const overlap = minted.filter((id) => spent.includes(id));
    expect(overlap).toEqual([]);
  });

  test('ids stay unique within one lifetime too', async () => {
    // The negative control for the epoch: an epoch that never advanced its
    // counter would also pass the test above, and would be worse.
    const life = await isolateLifetime('single');
    const ids = Array.from({ length: 256 }, () => life.nextDeviceRequestId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a woken hub's call is not settled by the previous life's late answer", async () => {
    // The mispairing itself, through the tunnel's own public surface.
    const before = await isolateLifetime('before-wake');
    const after = await isolateLifetime('after-wake');

    // A command issued before the eviction. The hub stopped waiting; the
    // machine did not stop running it.
    const abandoned = before.nextDeviceRequestId();

    // The hub wakes and rebuilds the tunnel over the surviving socket, then
    // issues the first call of its new life — the call a restarted counter
    // would have numbered exactly like the abandoned one.
    const socket = fakeSocket();
    const tunnel = new after.DeviceTunnel(socket);
    const fresh = tunnel.rpc('exec', ['echo mine'], { timeoutMs: 0 });
    // Settled-or-not is the whole question; the value is asserted below, so
    // neither handler needs to take the reason apart.
    let settled = false;
    void fresh.then(() => { settled = true; }, () => { settled = true; });

    // The machine finally answers the ABANDONED command.
    tunnel.handleMessage(JSON.stringify({
      id: abandoned, result: { stdout: 'from the previous life', exitCode: 0 },
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // The new call is still waiting for its own answer, and still gets it.
    tunnel.handleMessage(JSON.stringify({
      id: socket.sent[0]?.id, result: { stdout: 'mine', exitCode: 0 },
    }));
    expect(await fresh).toEqual({ stdout: 'mine', exitCode: 0 });
  });

  test('the cancellation handle is bound to the same identity', async () => {
    // The id is also what the daemon registers the process group under, so a
    // reused id would aim a stop at the wrong command. Same disjointness, read
    // through the answer-pairing check that stop path uses.
    const before = await isolateLifetime('stop-before');
    const after = await isolateLifetime('stop-after');
    const abandoned = before.nextDeviceRequestId();
    const reissued = after.nextDeviceRequestId();

    expect(() => after.parseDeviceCancelAnswer(reissued, {
      requestId: abandoned, cancelled: 'terminated',
    })).toThrow(after.DEVICE_CANCEL_MISPAIRED);
  });
});
