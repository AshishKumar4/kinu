// DeviceTunnel: JSON-RPC over the user-level device socket.
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import {
  DeviceTunnel, TUNNEL_DISCONNECTED, DEVICE_UNRESPONSIVE, DEVICE_DUPLICATE_REQUEST,
  DEVICE_CANCEL_MISPAIRED, parseDeviceCancelAnswer,
  nextDeviceRequestId, type TunnelSocket,
} from '../src/execution/device-tunnel';
import { JsonValueSchema } from '../src/utils/json';
import { handClock } from '@kinu.run/test-utils';

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

  test('settles the response even when terminal cleanup throws', async () => {
    const sock = fakeSocket();
    const t = new DeviceTunnel(sock);

    const p = t.rpc('exec', ['true'], {
      onTerminal: () => { throw new Error('durable cleanup failed'); },
    });

    expect(() => t.handleMessage(JSON.stringify({ id: sock.sent[0].id, result: 'ok' })))
      .toThrow('durable cleanup failed');
    expect(await p).toBe('ok');
  });

  test('concurrent calls are correlated by id', async () => {
    const sock = fakeSocket();
    const t = new DeviceTunnel(sock);
    const a = t.rpc('exec', ['1']);
    const b = t.rpc('exec', ['2']);
    const [idA, idB] = sock.sent.map((s) => s.id);
    t.handleMessage(JSON.stringify({ id: idB, result: 'B' }));
    t.handleMessage(JSON.stringify({ id: idA, result: 'A' }));
    expect(await a).toBe('A');
    expect(await b).toBe('B');
  });

  test('unrelated / HELLO frames are ignored (no pending match)', async () => {
    const sock = fakeSocket();
    const t = new DeviceTunnel(sock);
    const p = t.rpc('exec', ['x']);
    t.handleMessage(JSON.stringify({ type: 'HELLO', os: 'darwin' }));
    t.handleMessage('not json');
    t.handleMessage(JSON.stringify({ id: 'rpc-999', result: 'stale' }));
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
    const t = new DeviceTunnel(sock, 20);
    await expect(t.rpc('exec', ['slow'])).rejects.toThrow(/timeout/i);
  });

  // Liveness and the work budget are separate deadlines; one shared deadline reads a slow build as a dead device.
  describe('work budget vs liveness', () => {
    test('a call with no deadline outlives the control timeout', async () => {
      const sock = fakeSocket();
      const timers = handClock();
      const t = new DeviceTunnel(sock, 10, 1_000, timers);
      const p = t.rpc('exec', ['make -j8'], { timeoutMs: 0 });
      timers.advance(40);
      t.handleMessage(JSON.stringify({ id: sock.sent[0].id, result: { stdout: 'built', exitCode: 0 } }));
      expect(await p).toEqual({ stdout: 'built', exitCode: 0 });
    });

    test('a deadline-free call still fails when the DEVICE goes away, and says so', async () => {
      const sock = fakeSocket();
      const t = new DeviceTunnel(sock, 10);
      const p = t.rpc('exec', ['sleep 600'], { timeoutMs: 0 });
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
      const timers = handClock();
      const t = new DeviceTunnel(sock, 1_000, 15, timers);
      const p = t.rpc('exec', ['pytest -x'], { timeoutMs: 0 });
      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      // Work is silent but probes answer, which is all liveness asks.
      for (let i = 0; i < 6; i++) {
        timers.advance(15);
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
      // Half-open: the socket reads OPEN, so only the heartbeat tells slow work from a dead machine.
      const sock = fakeSocket();
      const t = new DeviceTunnel(sock, 1_000, 10);
      const p = t.rpc('exec', ['make'], { timeoutMs: 0 });
      await expect(p).rejects.toThrow(DEVICE_UNRESPONSIVE);
      // The message must not imply the work was cancelled on the device.
      await expect(p).rejects.toThrow(/may still be running on the device/);
    });

    test('the heartbeat stops once no open-ended call is left', async () => {
      const sock = fakeSocket();
      const timers = handClock();
      const t = new DeviceTunnel(sock, 1_000, 10, timers);
      const p = t.rpc('exec', ['true'], { timeoutMs: 0 });
      t.handleMessage(JSON.stringify({ id: sock.sent[0].id, result: 'ok' }));
      expect(await p).toBe('ok');
      const after = sock.sent.length;
      timers.advance(35);
      expect(sock.sent.length).toBe(after);
    });

    test('a probe the socket refuses to send ends the calls it guards, carrying why', async () => {
      const sock = fakeSocket();
      const timers = handClock();
      const t = new DeviceTunnel(sock, 1_000, 10, timers);
      const p = t.rpc('exec', ['make'], { timeoutMs: 0 });
      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      const refused = new Error('socket refused the frame');
      sock.send = () => { throw refused; };

      // One tick sends only the probe.
      timers.advance(10);
      await Promise.resolve();

      expect(settled).toBe(true);
      await expect(p).rejects.toMatchObject({ message: expect.stringContaining(TUNNEL_DISCONNECTED), cause: refused });
    });
  });

  /** Request identity pairs responses and names cancellations; the epoch keeps ids unique across a wake. */
  describe('request identity', () => {
    test('a rebuilt tunnel cannot reissue an id a previous one used', async () => {
      // Two tunnels in one isolate stand in for before and after a wake; only the epoch keeps ids apart.
      const before = fakeSocket();
      const after = fakeSocket();
      const first = new DeviceTunnel(before);
      const firstCall = first.rpc('exec', ['make'], { timeoutMs: 0 });
      const second = new DeviceTunnel(after);
      const secondCall = second.rpc('exec', ['ls'], { timeoutMs: 0 });

      expect(after.sent[0].id).not.toBe(before.sent[0].id);

      first.dispose();
      second.dispose();
      await expect(firstCall).rejects.toThrow(TUNNEL_DISCONNECTED);
      await expect(secondCall).rejects.toThrow(TUNNEL_DISCONNECTED);
    });

    test('a stale answer from before the wake resolves nothing after it', async () => {
      const before = fakeSocket();
      const first = new DeviceTunnel(before);
      const abandoned = first.rpc('exec', ['make'], { timeoutMs: 0 });
      const staleId = before.sent[0].id;
      first.dispose();
      await expect(abandoned).rejects.toThrow(TUNNEL_DISCONNECTED);

      const after = fakeSocket();
      const second = new DeviceTunnel(after);
      const live = second.rpc('exec', ['git status'], { timeoutMs: 0 });
      let settled = false;
      void live.then(() => { settled = true; }, () => { settled = true; });

      second.handleMessage(JSON.stringify({ id: staleId, result: { stdout: 'STALE', exitCode: 0 } }));
      await Promise.resolve();
      expect(settled).toBe(false);

      second.handleMessage(JSON.stringify({ id: after.sent[0].id, result: { stdout: 'clean', exitCode: 0 } }));
      expect(await live).toEqual({ stdout: 'clean', exitCode: 0 });
    });

    test('a caller that must be able to cancel issues the call under its own id', async () => {
      // The id must exist before the frame goes out: the daemon registers the process group under it.
      const sock = fakeSocket();
      const t = new DeviceTunnel(sock);
      const requestId = nextDeviceRequestId();
      const p = t.rpc('exec', ['sleep 600'], { timeoutMs: 0, requestId });

      expect(sock.sent[0].id).toBe(requestId);
      t.handleMessage(JSON.stringify({ id: requestId, result: { stdout: '', exitCode: 137 } }));
      expect(await p).toEqual({ stdout: '', exitCode: 137 });
    });

    test('an id already in flight is refused rather than correlated twice', async () => {
      const sock = fakeSocket();
      const t = new DeviceTunnel(sock);
      const requestId = nextDeviceRequestId();
      const first = t.rpc('exec', ['make'], { timeoutMs: 0, requestId });

      await expect(t.rpc('exec', ['make again'], { timeoutMs: 0, requestId }))
        .rejects.toThrow(DEVICE_DUPLICATE_REQUEST);
      expect(sock.sent).toHaveLength(1);
      t.handleMessage(JSON.stringify({ id: requestId, result: { stdout: 'built', exitCode: 0 } }));
      expect(await first).toEqual({ stdout: 'built', exitCode: 0 });
    });

    test('a cancellation answer speaks only for the request it names', () => {
      // Verb and id are one claim: `terminated` about another command confirms nothing.
      const requestId = nextDeviceRequestId();
      const answer = { requestId, cancelled: 'terminated' } as const;
      expect(parseDeviceCancelAnswer(requestId, answer)).toEqual(answer);
      expect(() => parseDeviceCancelAnswer(nextDeviceRequestId(), answer))
        .toThrow(DEVICE_CANCEL_MISPAIRED);
      expect(() => parseDeviceCancelAnswer(requestId, { requestId, cancelled: 'probably' }))
        .toThrow('Invalid type: Expected ("terminated" | "unknown") but received "probably"');
      expect(() => parseDeviceCancelAnswer(requestId, undefined))
        .toThrow('Invalid type: Expected Object but received undefined');
    });
  });
});
