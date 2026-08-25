import { describe, expect, test } from 'bun:test';
import { createDeviceTunnelExecutor, type DeviceTransport } from '../src/execution/device-tunnel-executor';
import type { DeviceStatus } from '../src/execution/device-status';
import type { JsonValue } from '../src/utils/json';

function staticTransport(status: DeviceStatus, rpc: DeviceTransport['rpc']): DeviceTransport {
  return { status: () => status, refreshStatus: async () => status, rpc };
}

function transport(resultFor: (method: string, params: JsonValue[]) => JsonValue | undefined): DeviceTransport & {
  calls: Array<{ method: string; params: JsonValue[] }>;
} {
  const calls: Array<{ method: string; params: JsonValue[] }> = [];
  return {
    calls,
    ...staticTransport({ connected: true, registered: true, toolchain: null }, async (method, params) => {
      calls.push({ method, params });
      return resultFor(method, params);
    }),
  };
}

describe('createDeviceTunnelExecutor', () => {
  test('keeps exec as the full shell escape hatch', async () => {
    const t = transport(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const provider = createDeviceTunnelExecutor(t);

    await provider.tools.exec.execute('echo one; echo two');

    expect(t.calls).toEqual([{ method: 'exec', params: ['echo one; echo two'] }]);
  });

  test('base consent cannot escape its subtree through native file tools', async () => {
    const t = transport(() => 'contents');
    const provider = createDeviceTunnelExecutor(t, {
      consentedRoot: () => '/home/dev/project',
      hasFullFilesystem: async () => false,
    });

    const read = await provider.tools.readFile.execute('/etc/passwd');
    const write = await provider.tools.writeFile.execute('/tmp/out', 'x');
    const list = await provider.tools.readdir.execute('/');
    const exists = await provider.tools.exists.execute('/root/.ssh/id_ed25519');

    for (const answer of [read, write, list, exists]) {
      expect(String(answer)).toContain('outside the consented device directory');
    }
    expect(t.calls).toEqual([]);
    expect(await provider.tools.readFile.execute('/home/dev/project/readme.md')).toBe('contents');
    expect(t.calls).toEqual([{
      method: 'readFile',
      params: ['/home/dev/project/readme.md', {
        encoding: 'base64',
        root: '/home/dev/project',
      }],
    }]);
  });

  test('the row carries the machine\'s own name and this agent\'s grant state', () => {
    const named = staticTransport({
      connected: true,
      registered: true,
      toolchain: null,
      devices: [
        { id: 'dev-2', name: 'spare box', os: 'linux', hostname: 'spare', connected: false },
        { id: 'dev-1', name: 'ashish@studio', os: 'darwin', hostname: 'studio', connected: true },
      ],
      workspaceGranted: true,
    }, async () => undefined);

    // The CONNECTED machine names the row, not whichever was registered first.
    expect(createDeviceTunnelExecutor(named).getStatus?.()).toEqual({
      configured: true, available: true, active: true, status: 'active',
      label: 'ashish@studio', granted: true,
    });

    // Offline but registered: still named, so the model can ask for it by name,
    // and still ungranted, so it does not predict a prompt-free call.
    const offline = staticTransport({
      connected: false,
      registered: true,
      toolchain: null,
      devices: [{ id: 'dev-1', name: 'ashish@studio', os: null, hostname: null, connected: false }],
      workspaceGranted: false,
    }, async () => undefined);
    expect(createDeviceTunnelExecutor(offline).getStatus?.()).toMatchObject({
      status: 'disconnected', label: 'ashish@studio', granted: false,
    });

    // A hub that says nothing about names claims nothing: no label, no grant.
    const bare = staticTransport({ connected: true, registered: true, toolchain: null }, async () => undefined);
    expect(createDeviceTunnelExecutor(bare).getStatus?.()).toEqual({
      configured: true, available: true, active: true, status: 'active',
    });
  });

  test('file helpers use structured daemon RPCs instead of shell interpolation', async () => {
    const t = transport((method) => {
      if (method === 'readFile') return 'contents';
      if (method === 'writeFile') return { success: true };
      if (method === 'listFiles') return [{ name: 'a.txt', type: 'file' }];
      if (method === 'exists') return true;
      throw new Error(`unexpected method ${method}`);
    });
    const provider = createDeviceTunnelExecutor(t);
    const path = '/tmp/a; echo PWNED';

    await provider.tools.readFile.execute(path);
    await provider.tools.writeFile.execute(path, 'hello');
    await provider.tools.readdir.execute(path);
    await provider.tools.exists.execute(path);

    expect(t.calls).toEqual([
      { method: 'readFile', params: [path, { encoding: 'base64', root: null }] },
      { method: 'writeFile', params: [path, 'hello', { root: null }] },
      { method: 'listFiles', params: [path, { root: null }] },
      { method: 'exists', params: [path, { root: null }] },
    ]);
  });

  test('writeFile accepts the old daemon ok response and the structured response', async () => {
    const legacy = transport(() => 'ok');
    const structured = transport(() => ({ success: true }));

    const a = await createDeviceTunnelExecutor(legacy).tools.writeFile.execute('/tmp/a', 'x');
    const b = await createDeviceTunnelExecutor(structured).tools.writeFile.execute('/tmp/b', 'yy');

    expect(a).toBe('Written 1 bytes to /tmp/a');
    expect(b).toBe('Written 2 bytes to /tmp/b');
  });

  test('tools reach the hub even when the cached snapshot is stale-false', async () => {
    // Regression: agents whose runtime predated the device connection gated
    // every call on the cached flag, so false could never flip back to true.
    const t = transport(() => ({ stdout: 'hi', stderr: '', exitCode: 0 }));
    t.status = () => ({ connected: false, registered: true, toolchain: null });
    const provider = createDeviceTunnelExecutor(t);

    expect(await provider.tools.exec.execute('echo hi')).toBe('hi');
    expect(t.calls).toEqual([{ method: 'exec', params: ['echo hi'] }]);
    // isAvailable still reports the cached snapshot (sync badge only).
    expect(provider.isAvailable()).toBe(false);
  });

  test('getStatus maps the hub snapshot to the three lifecycle states', () => {
    const rpc: DeviceTransport['rpc'] = async () => 'unused';
    const connected = createDeviceTunnelExecutor(staticTransport({ connected: true, registered: true, toolchain: null }, rpc));
    const offline = createDeviceTunnelExecutor(staticTransport({ connected: false, registered: true, toolchain: null }, rpc));
    const none = createDeviceTunnelExecutor(staticTransport({ connected: false, registered: false, toolchain: null }, rpc));

    expect(connected.getStatus?.()).toMatchObject({ available: true, configured: true, status: 'active' });
    expect(offline.getStatus?.()).toMatchObject({ available: false, configured: true, status: 'disconnected' });
    expect(offline.getStatus?.()?.reason).toContain('kinu connect');
    expect(none.getStatus?.()).toMatchObject({ available: false, configured: false, status: 'not_configured' });
  });

  test('hub/tunnel disconnect errors surface the connect guidance', async () => {
    const hubRejects = staticTransport({ connected: false, registered: true, toolchain: null }, async () => {
      throw new Error('no device connected');
    });
    const tunnelDropped = staticTransport({ connected: true, registered: true, toolchain: null }, async () => {
      throw new Error('device tunnel not connected');
    });

    const fromHub = await createDeviceTunnelExecutor(hubRejects).tools.exec.execute('ls');
    const fromTunnel = await createDeviceTunnelExecutor(tunnelDropped).tools.readFile.execute('/tmp/a');

    // The connect guidance survives, and it now arrives with the CLASS in front of
    // it: `unavailable` is what puts a device that is not attached in the census's
    // platform part instead of counting it against the tool. Asserting the prose
    // alone is what let this ship as a value no reader could see was a failure.
    expect(JSON.parse(String(fromHub))).toMatchObject({ reason: 'unavailable' });
    expect(JSON.parse(String(fromTunnel))).toMatchObject({ reason: 'unavailable' });
    expect(fromHub).toContain('kinu connect');
    expect(fromTunnel).toContain('kinu connect');
    await expect(createDeviceTunnelExecutor(hubRejects).connect()).rejects.toThrow('kinu connect');
  });

  test('a non-connection failure is classified, and keeps its own message', async () => {
    const t = staticTransport({ connected: true, registered: true, toolchain: null }, async () => {
      throw new Error('permission denied');
    });
    // `io`, not `unavailable`: the device answered and its filesystem said no.
    // Pooling the two would read a permission problem as an absent machine.
    expect(JSON.parse(String(await createDeviceTunnelExecutor(t).tools.exec.execute('ls')))).toEqual({
      reason: 'io',
      error: 'laptop exec `ls`: permission denied',
    });
  });

  test('a read that could not reach the device never answers `false`', async () => {
    const t = staticTransport({ connected: true, registered: true, toolchain: null }, async () => {
      throw new Error('permission denied');
    });
    const answer = await createDeviceTunnelExecutor(t).tools.exists.execute('/tmp/a');

    // It used to be `false` — "the path is absent on your machine" — from a catch
    // that dropped its error. An unreachable read and an absent path are different
    // facts and the boolean channel cannot hold both.
    expect(answer).not.toBe(false);
    expect(JSON.parse(String(answer))).toMatchObject({ reason: 'io' });
  });

  test('an unanswered or string-valued exists RPC never asserts absence', async () => {
    for (const wire of [undefined, 'false']) {
      const t = staticTransport(
        { connected: true, registered: true, toolchain: null },
        async () => wire,
      );
      const answer = await createDeviceTunnelExecutor(t).tools.exists.execute('/tmp/a');
      expect(answer).not.toBe(false);
      expect(JSON.parse(String(answer))).toMatchObject({ reason: 'io' });
    }
  });

  test('a malformed base64 frame never becomes an empty file', async () => {
    const t = staticTransport(
      { connected: true, registered: true, toolchain: null },
      async () => ({ encoding: 'base64', content: 42 }),
    );
    const answer = await createDeviceTunnelExecutor(t).tools.readFile.execute('/tmp/a');
    expect(answer).not.toBe('');
    expect(JSON.parse(String(answer))).toMatchObject({ reason: 'io' });
  });
});
