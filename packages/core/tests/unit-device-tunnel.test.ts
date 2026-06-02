// DeviceTunnel — JSON-RPC over the user-level device socket (P1 of the CLI work).
import { describe, test, expect } from 'bun:test';
import { DeviceTunnel, TUNNEL_DISCONNECTED, type TunnelSocket } from '../src/execution/device-tunnel.js';

/** A fake socket that records sent frames and lets the test inject responses. */
function fakeSocket(open = true) {
  const sent: Array<{ id: string; method: string; params: unknown[] }> = [];
  const sock: TunnelSocket & { sent: typeof sent; readyState: number } = {
    readyState: open ? 1 : 3,
    sent,
    send(data: string) { sent.push(JSON.parse(data)); },
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
});
