import { describe, expect, test } from 'bun:test';
import { createSSHTunnelExecutor, type DeviceTransport } from '../src/execution/ssh.js';

function transport(resultFor: (method: string, params: unknown[]) => unknown): DeviceTransport & {
  calls: Array<{ method: string; params: unknown[] }>;
} {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  return {
    calls,
    isConnected: () => true,
    async rpc(method, params) {
      calls.push({ method, params });
      return resultFor(method, params);
    },
  };
}

describe('createSSHTunnelExecutor', () => {
  test('keeps exec as the full shell escape hatch', async () => {
    const t = transport(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const provider = createSSHTunnelExecutor(t);

    await provider.tools.exec.execute('echo one; echo two');

    expect(t.calls).toEqual([{ method: 'exec', params: ['echo one; echo two'] }]);
  });

  test('file helpers use structured daemon RPCs instead of shell interpolation', async () => {
    const t = transport((method) => {
      if (method === 'readFile') return 'contents';
      if (method === 'writeFile') return { success: true };
      if (method === 'listFiles') return [{ name: 'a.txt', type: 'file' }];
      if (method === 'exists') return true;
      throw new Error(`unexpected method ${method}`);
    });
    const provider = createSSHTunnelExecutor(t);
    const path = '/tmp/a; echo PWNED';

    await provider.tools.readFile.execute(path);
    await provider.tools.writeFile.execute(path, 'hello');
    await provider.tools.readdir.execute(path);
    await provider.tools.exists.execute(path);

    expect(t.calls).toEqual([
      { method: 'readFile', params: [path] },
      { method: 'writeFile', params: [path, 'hello'] },
      { method: 'listFiles', params: [path] },
      { method: 'exists', params: [path] },
    ]);
  });

  test('writeFile accepts the old daemon ok response and the structured response', async () => {
    const legacy = transport(() => 'ok');
    const structured = transport(() => ({ success: true }));

    const a = await createSSHTunnelExecutor(legacy).tools.writeFile.execute('/tmp/a', 'x');
    const b = await createSSHTunnelExecutor(structured).tools.writeFile.execute('/tmp/b', 'yy');

    expect(a).toBe('Written 1 bytes to /tmp/a');
    expect(b).toBe('Written 2 bytes to /tmp/b');
  });

  test('tools reach the hub even when the cached flag is stale-false', async () => {
    // Regression: agents whose runtime predated the device connection gated
    // every call on the cached flag, so false could never flip back to true.
    const t = transport(() => ({ stdout: 'hi', stderr: '', exitCode: 0 }));
    t.isConnected = () => false;
    const provider = createSSHTunnelExecutor(t);

    expect(await provider.tools.exec.execute('echo hi')).toBe('hi');
    expect(t.calls).toEqual([{ method: 'exec', params: ['echo hi'] }]);
    // isAvailable still reports the cached flag (sync badge only).
    expect(provider.isAvailable()).toBe(false);
  });

  test('hub/tunnel disconnect errors surface the connect guidance', async () => {
    const hubRejects: DeviceTransport = {
      isConnected: () => false,
      rpc: async () => { throw new Error('no device connected'); },
    };
    const tunnelDropped: DeviceTransport = {
      isConnected: () => true,
      rpc: async () => { throw new Error('device tunnel not connected'); },
    };

    const fromHub = await createSSHTunnelExecutor(hubRejects).tools.exec.execute('ls');
    const fromTunnel = await createSSHTunnelExecutor(tunnelDropped).tools.readFile.execute('/tmp/a');

    expect(fromHub).toContain('proteus connect');
    expect(fromTunnel).toContain('proteus connect');
    await expect(createSSHTunnelExecutor(hubRejects).connect()).rejects.toThrow('proteus connect');
  });

  test('non-connection errors keep their own message', async () => {
    const t: DeviceTransport = {
      isConnected: () => true,
      rpc: async () => { throw new Error('permission denied'); },
    };
    expect(await createSSHTunnelExecutor(t).tools.exec.execute('ls')).toBe('exec error: permission denied');
  });
});
