// DeviceTunnel — JSON-RPC over the user-level device socket (P1 of the CLI work).
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import {
  DeviceTunnel, TUNNEL_DISCONNECTED, DEVICE_UNRESPONSIVE, type TunnelSocket,
} from '../src/execution/device-tunnel';
import { JsonValueSchema } from '../src/utils/json';

const SentFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.array(JsonValueSchema),
  checkpoint: v.optional(JsonValueSchema),
});

type SentFrame = v.InferOutput<typeof SentFrameSchema>;

/** A fake socket that records sent frames and lets the test inject responses. */
function fakeSocket(open = true) {
  const sent: SentFrame[] = [];
  const sock: TunnelSocket & { sent: typeof sent; readyState: number } = {
    readyState: open ? 1 : 3,
    sent,
    send(data: string) { sent.push(v.parse(SentFrameSchema, JSON.parse(data))); },
  };
  return sock;
}

describe('DeviceTunnel', () => {
  test('rpc sends {id,method,params} and resolves on the matching response', async () => {
    const sock = fakeSocket();
    const t = new DeviceTunnel(sock);
    const p = t.rpc('exec', ['ls']);
    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0].method).toBe('exec');
    expect(sock.sent[0].params).toEqual(['ls']);
    t.handleMessage(JSON.stringify({ id: sock.sent[0].id, result: { stdout: 'a.ts', exitCode: 0 } }));
    expect(await p).toEqual({ stdout: 'a.ts', exitCode: 0 });
  });

  test('extra frame fields (the checkpoint hint) ride next to id/method/params', async () => {
    const sock = fakeSocket();
    const t = new DeviceTunnel(sock);
    const hint = { agent: 'a1', turnId: 't1', sessionId: 'default', dir: '/home/u/proj' };
    const p = t.rpc('exec', ['make'], { extra: { checkpoint: hint } });
    const frame = sock.sent[0];
    expect(frame.method).toBe('exec');
    expect(frame.checkpoint).toEqual(hint);
    t.handleMessage(JSON.stringify({ id: frame.id, result: 'ok' }));
    expect(await p).toBe('ok');
  });

  test('an {id,error} response rejects', async () => {
    const sock = fakeSocket();
    const t = new DeviceTunnel(sock);
    const p = t.rpc('exec', ['boom']);
    t.handleMessage(JSON.stringify({ id: sock.sent[0].id, error: 'command failed' }));
    await expect(p).rejects.toThrow('command failed');
  });

  test('concurrent calls are correlated by id', async () => {
    const sock = fakeSocket();
    const t = new DeviceTunnel(sock);
    const a = t.rpc('exec', ['1']);
    const b = t.rpc('exec', ['2']);
    const [idA, idB] = sock.sent.map((s) => s.id);
    // Respond out of order.
    t.handleMessage(JSON.stringify({ id: idB, result: 'B' }));
    t.handleMessage(JSON.stringify({ id: idA, result: 'A' }));
    expect(await a).toBe('A');
    expect(await b).toBe('B');
  });

  test('unrelated / HELLO frames are ignored (no pending match)', async () => {
    const sock = fakeSocket();
    const t = new DeviceTunnel(sock);
    const p = t.rpc('exec', ['x']);
    t.handleMessage(JSON.stringify({ type: 'HELLO', os: 'darwin' })); // no id
    t.handleMessage('not json');
    t.handleMessage(JSON.stringify({ id: 'rpc-999', result: 'stale' })); // unknown id
    t.handleMessage(JSON.stringify({ id: sock.sent[0].id, result: 'real' }));
    expect(await p).toBe('real');
  });

  test('rpc on a closed socket rejects immediately', async () => {
    const t = new DeviceTunnel(fakeSocket(false));
    await expect(t.rpc('exec', ['x'])).rejects.toThrow(TUNNEL_DISCONNECTED);
  });

  test('dispose rejects all in-flight calls', async () => {
    const sock = fakeSocket();
    const t = new DeviceTunnel(sock);
    const p = t.rpc('exec', ['hang']);
    t.dispose();
    await expect(p).rejects.toThrow(TUNNEL_DISCONNECTED);
  });

  test('rpc times out if no response arrives', async () => {
    const sock = fakeSocket();
    const t = new DeviceTunnel(sock, 20); // 20ms timeout
    await expect(t.rpc('exec', ['slow'])).rejects.toThrow(/timeout/i);
  });

  // The transport used to put ONE 30s deadline on every call, so a laptop
  // build or test suite failed as "device RPC timeout" — a message
  // indistinguishable from a dead device. Liveness was welded onto the work
  // budget; these pin them apart.
  describe('work budget vs liveness', () => {
    test('a call with no deadline outlives the control timeout', async () => {
      const sock = fakeSocket();
      const t = new DeviceTunnel(sock, 10);
      const p = t.rpc('exec', ['make -j8'], { timeoutMs: 0 });
      await new Promise((r) => setTimeout(r, 40));
      // Well past the control deadline, and still waiting for the device.
      t.handleMessage(JSON.stringify({ id: sock.sent[0].id, result: { stdout: 'built', exitCode: 0 } }));
      expect(await p).toEqual({ stdout: 'built', exitCode: 0 });
    });

    test('a deadline-free call still fails when the DEVICE goes away, and says so', async () => {
      const sock = fakeSocket();
      const t = new DeviceTunnel(sock, 10);
      const p = t.rpc('exec', ['sleep 600'], { timeoutMs: 0 });
      // A socket close rejects in-flight calls through the tunnel's own
      // teardown — the case where no close event ever fires is what the
      // liveness probe covers, and both name the disconnect.
      sock.readyState = 3;
      t.dispose();
      await expect(p).rejects.toThrow(TUNNEL_DISCONNECTED);
    });

    test('a timed-out control call says the work may still be running', async () => {
      const sock = fakeSocket();
      const t = new DeviceTunnel(sock, 10);
      await expect(t.rpc('readFile', ['/etc/hosts'])).rejects.toThrow(
        /may still be running on the device/,
      );
    });

    test('a device that keeps speaking keeps its open-ended call alive', async () => {
      const sock = fakeSocket();
      const t = new DeviceTunnel(sock, 1_000, 15);
      const p = t.rpc('exec', ['pytest -x'], { timeoutMs: 0 });
      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });
      // Several heartbeat periods of silence from the WORK, but the device is
      // answering the probes — which is the only question liveness asks.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 15));
        const probe = sock.sent.find((f) => f.method === 'ping');
        if (probe) t.handleMessage(JSON.stringify({ id: probe.id, error: 'unknown method: ping' }));
      }
      expect(settled).toBe(false);
      t.handleMessage(JSON.stringify({
        id: sock.sent[0].id, result: { stdout: '42 passed', exitCode: 0 },
      }));
      expect(await p).toEqual({ stdout: '42 passed', exitCode: 0 });
    });

    test('a device that stops answering fails the call as unresponsive, not as a timeout', async () => {
      // The half-open case: the socket still reads OPEN, so nothing closes and
      // no work deadline applies — the heartbeat is the only thing that can
      // tell the difference between slow work and a dead machine.
      const sock = fakeSocket();
      const t = new DeviceTunnel(sock, 1_000, 10);
      const p = t.rpc('exec', ['make'], { timeoutMs: 0 });
      await expect(p).rejects.toThrow(DEVICE_UNRESPONSIVE);
      // And it says what happened to the work rather than implying it was
      // cancelled on the device.
      await expect(p).rejects.toThrow(/may still be running on the device/);
    });

    test('the heartbeat stops once no open-ended call is left', async () => {
      const sock = fakeSocket();
      const t = new DeviceTunnel(sock, 1_000, 10);
      const p = t.rpc('exec', ['true'], { timeoutMs: 0 });
      t.handleMessage(JSON.stringify({ id: sock.sent[0].id, result: 'ok' }));
      expect(await p).toBe('ok');
      const after = sock.sent.length;
      await new Promise((r) => setTimeout(r, 35));
      expect(sock.sent.length).toBe(after);
    });
  });
});
