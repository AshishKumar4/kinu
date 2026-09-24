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

  test('each exec reports its own durable identity to that call only', async () => {
    const issued: Array<{ reported: string; sent: string | undefined }> = [];
    const observed: string[] = [];

    const t: DeviceTransport = {
      status: () => ({ connected: true, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
      rpc: async (_method, _params, opts) => {
        issued.push({ reported: observed[observed.length - 1] ?? '', sent: opts?.requestId });

        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    };

    const provider = createDeviceTunnelExecutor(t);

    await provider.tools.exec.execute('first', { onDeviceRequest: (id: string) => observed.push(id) });
    await provider.tools.exec.execute('second', { onDeviceRequest: (id: string) => observed.push(id) });

    // Two parallel calls, two identities, each reported to its caller: the handover unit is one request.
    expect(observed).toHaveLength(2);
    expect(observed[0]).not.toBe(observed[1]);
    expect(issued.map((call) => call.sent)).toEqual(observed);
  });

  test('each exec carries the owner that held the scope at the moment it was issued', async () => {
    const issued: Array<{ requestId: string; backgroundJobId: string | undefined }> = [];
    const reported: string[] = [];

    const t: DeviceTransport = {
      status: () => ({ connected: true, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
      rpc: async (_method, _params, opts) => {
        if (opts?.requestId === undefined) throw new Error('exec reached the device with no identity');
        issued.push({ requestId: opts.requestId, backgroundJobId: opts.backgroundJobId });

        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    };

    const provider = createDeviceTunnelExecutor(t);
    // One scope whose owner changes under it, as a detach does.
    let owner: string | null = null;

    const context = {
      onDeviceRequest: (id: string) => reported.push(id),
      deviceRequestOwner: () => owner,
    };

    await provider.tools.exec.execute('before detach', context);
    owner = 'job-1';
    await provider.tools.exec.execute('after detach', context);

    // Before detach the request is the turn's and a transfer moves it; after, it is the job's from issue.
    expect(issued.map((call) => call.backgroundJobId)).toEqual([undefined, 'job-1']);
    // The identity is announced for every call; the holder decides what a report means.
    expect(reported).toEqual(issued.map((call) => call.requestId));
  });

  test('base consent cannot escape its subtree through native file tools', async () => {
    const t = transport(() => ({ encoding: 'base64', content: Buffer.from('contents').toString('base64') }));

    const provider = createDeviceTunnelExecutor(t, {
      consentedRoot: async () => '/home/dev/project',
      deviceHome: async () => '/home/dev',
      scope: async () => 'root',
    });

    const read = await provider.tools.readFile.execute('/etc/passwd');
    const write = await provider.tools.writeFile.execute('/tmp/out', 'x');
    const list = await provider.tools.readdir.execute('/');
    const exists = await provider.tools.exists.execute('/root/.ssh/id_ed25519');

    for (const answer of [read, write, list, exists]) {
      expect(answer).toMatchObject({ error: expect.stringContaining('outside the consented device directory') });
    }

    expect(t.calls).toEqual([]);
    expect(await provider.tools.readFile.execute('/home/dev/project/readme.md')).toBe('contents');
    expect(t.calls).toEqual([{
      method: 'readRange',
      params: ['/home/dev/project/readme.md', 0, 8 * 1024 * 1024, { root: '/home/dev/project' }],
    }]);
  });

  /**
   * F2. The base tier reaches nothing the device did not name. Defaulting to `$HOME` would need an exec
   * (full tier) to learn it and would expose `~/.kinu/config.json`, `~/.ssh`, `~/.aws`.
   */
  test('a device that named no directory has no base-tier reach, and asks for none', async () => {
    const t = transport(() => 'contents');

    const provider = createDeviceTunnelExecutor(t, {
      consentedRoot: async () => null,
      deviceHome: async () => '/home/dev',
      scope: async () => 'root',
    });

    // Every file tool refuses without asking the machine anything, above all no `exec`.
    for (const answer of [
      await provider.tools.readFile.execute('/home/dev/notes.md'),
      await provider.tools.readdir.execute('/home/dev'),
      await provider.tools.exists.execute('/home/dev/.kinu/config.json'),
      await provider.tools.writeFile.execute('/home/dev/x', 'y'),
    ]) {
      expect(answer).toMatchObject({ error: expect.stringContaining('reported no consented directory') });
    }

    expect(t.calls).toEqual([]);

    // The full tier opens from the home reported on HELLO, not from a command run on the machine.
    const calls: Array<{ method: string; params: JsonValue[] }> = [];

    const described = staticTransport({
      connected: true, registered: true, toolchain: null,
      devices: [{ id: 'dev-1', name: 'box', os: 'linux', hostname: 'box', connected: true }],
    }, async (method, params) => {
      calls.push({ method, params });

      return undefined;
    });

    const full = createDeviceTunnelExecutor(described, {
      consentedRoot: async () => null,
      deviceHome: async () => '/home/dev',
      scope: async () => 'unconfined',
    });

    expect(await full.homeDir()).toBe('/');
    expect(await full.homeDir('box')).toBe('/home/dev');
    expect(calls).toEqual([]);
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

    // The connected machine names the row, not whichever registered first.
    expect(createDeviceTunnelExecutor(named).getStatus?.()).toEqual({
      configured: true, available: true, active: true, status: 'active',
      label: 'ashish@studio', granted: true,
    });

    // Offline but registered: still named, still ungranted.
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

    const bare = staticTransport({ connected: true, registered: true, toolchain: null }, async () => undefined);
    expect(createDeviceTunnelExecutor(bare).getStatus?.()).toEqual({
      configured: true, available: true, active: true, status: 'active',
    });
  });

  test('file helpers use structured daemon RPCs instead of shell interpolation', async () => {
    const t = transport((method): JsonValue => {
      if (method === 'readRange') return { encoding: 'base64', content: Buffer.from('contents').toString('base64') };

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
      { method: 'readRange', params: [path, 0, 8 * 1024 * 1024, { root: null }] },
      { method: 'writeFile', params: [path, 'hello', { root: null }] },
      { method: 'listFiles', params: [path, { root: null, offset: 0, limit: 10_000 }] },
      { method: 'exists', params: [path, { root: null }] },
    ]);
  });

  test('writeFile answers from the bytes it sent, whatever the daemon replies', async () => {
    const bareOk = transport(() => 'ok');
    const structured = transport(() => ({ success: true }));

    const a = await createDeviceTunnelExecutor(bareOk).tools.writeFile.execute('/tmp/a', 'x');
    const b = await createDeviceTunnelExecutor(structured).tools.writeFile.execute('/tmp/b', 'yy');

    expect(a).toBe('Written 1 bytes to /tmp/a');
    expect(b).toBe('Written 2 bytes to /tmp/b');
  });

  test('tools reach the hub even when the cached snapshot is stale-false', async () => {
    // A cached false could never flip back to true, so the tools ask the hub rather than the snapshot.
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

  test('a connected machine this workspace cannot use reads as reach, not liveness', () => {
    const rpc: DeviceTransport['rpc'] = async () => 'unused';

    const ungranted = staticTransport({
      connected: true, registered: true, toolchain: null, workspaceGranted: false,
    }, rpc);

    const granted = staticTransport({
      connected: true, registered: true, toolchain: null, workspaceGranted: true,
    }, rpc);

    // The ungranted row says the machine exists and the first call raises a card.
    expect(createDeviceTunnelExecutor(ungranted).getStatus?.()).toMatchObject({
      available: false, active: false, granted: false, status: 'idle',
    });
    expect(createDeviceTunnelExecutor(granted).getStatus?.()).toMatchObject({
      available: true, active: true, granted: true, status: 'active',
    });
  });

  test('a caller with no workspace identity keeps the liveness reading', () => {
    const rpc: DeviceTransport['rpc'] = async () => 'unused';

    // `workspaceGranted` absent: a non-workspace caller or an older snapshot; row unchanged.
    const status = createDeviceTunnelExecutor(staticTransport({
      connected: true, registered: true, toolchain: null,
    }, rpc)).getStatus?.();

    expect(status).toMatchObject({ available: true, active: true, status: 'active' });
    expect(status?.granted).toBeUndefined();
  });

  test('a fleet entry answers reach for the machine it names, not the first one', () => {
    const rpc: DeviceTransport['rpc'] = async () => 'unused';

    // Reach comes from the live machine's own entry.
    const single = staticTransport({
      connected: true, registered: true, toolchain: null,
      devices: [{ id: 'dev-1', name: 'studio', os: 'linux', hostname: 's', connected: true, granted: false }],
    }, rpc);

    expect(createDeviceTunnelExecutor(single).getStatus?.()).toMatchObject({
      label: 'studio', granted: false, available: false, status: 'idle',
    });
  });

  test('two live machines have no "the" machine, so the row keeps liveness', () => {
    const rpc: DeviceTransport['rpc'] = async () => 'unused';

    // With several live machines the top-level reach fields are absent; the row lists both and the model names one.
    const status = createDeviceTunnelExecutor(staticTransport({
      connected: true, registered: true, toolchain: null,
      devices: [
        { id: 'dev-1', name: 'studio', os: 'linux', hostname: 's', connected: true, granted: false },
        { id: 'dev-2', name: 'rig', os: 'linux', hostname: 'r', connected: true, granted: true },
      ],
    }, rpc)).getStatus?.();

    expect(status).toMatchObject({ available: true, active: true, status: 'active' });
    expect(status?.granted).toBeUndefined();
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

    // `unavailable` classifies an unattached device as platform, not a tool failure.
    expect(fromHub).toMatchObject({ reason: 'unavailable', error: expect.stringContaining('kinu connect') });
    expect(fromTunnel).toMatchObject({ reason: 'unavailable', error: expect.stringContaining('kinu connect') });
    await expect(createDeviceTunnelExecutor(hubRejects).connect()).rejects.toThrow('kinu connect');
  });

  test('a non-connection failure is classified, and keeps its own message', async () => {
    const t = staticTransport({ connected: true, registered: true, toolchain: null }, async () => {
      throw new Error('permission denied');
    });

    // `io`, not `unavailable`: the device answered and its filesystem refused.
    expect(await createDeviceTunnelExecutor(t).tools.exec.execute('ls')).toEqual({
      reason: 'io',
      error: 'device exec `ls`: permission denied',
    });
  });

  test('a read that could not reach the device never answers `false`', async () => {
    const t = staticTransport({ connected: true, registered: true, toolchain: null }, async () => {
      throw new Error('permission denied');
    });

    const answer = await createDeviceTunnelExecutor(t).tools.exists.execute('/tmp/a');

    // `false` would claim the path is absent; an unreachable read is a different fact.
    expect(answer).not.toBe(false);
    expect(answer).toMatchObject({ reason: 'io' });
  });

  test('an unanswered or string-valued exists RPC never asserts absence', async () => {
    for (const wire of [undefined, 'false']) {
      const t = staticTransport(
        { connected: true, registered: true, toolchain: null },
        async () => wire,
      );

      const answer = await createDeviceTunnelExecutor(t).tools.exists.execute('/tmp/a');
      expect(answer).not.toBe(false);
      expect(answer).toMatchObject({ reason: 'io' });
    }
  });

  test('a malformed base64 frame never becomes an empty file', async () => {
    const t = staticTransport(
      { connected: true, registered: true, toolchain: null },
      async () => ({ encoding: 'base64', content: 42 }),
    );

    const answer = await createDeviceTunnelExecutor(t).tools.readFile.execute('/tmp/a');
    expect(answer).not.toBe('');
    expect(answer).toMatchObject({ reason: 'io' });
  });
});
