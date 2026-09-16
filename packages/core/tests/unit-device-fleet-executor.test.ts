// The device fleet at the executor surface: a command NAMES its machine, a
// fleet of several refuses an unnamed call with the classified ask, and the
// composite file plane serves one machine at `/pc` and several under
// `/pc/<name>`. Every test here drives the real provider over a transport
// double whose snapshot is the fleet the hub would serve.
import { describe, expect, test } from 'bun:test';
import {
  createDeviceTunnelExecutor, deviceMountSegment,
  type DeviceTransport,
} from '../src/execution/device-tunnel-executor';
import { deviceFleetAsk, type DeviceFleetEntry, type DeviceStatus } from '../src/execution/device-status';
import { answeredRefusal } from '../src/execution/exec-result';
import { parseJsonValue } from '../src/utils/json';
import { getExecutorFiles } from '../src/read-models/files';
import { withMountTable, standardMounts } from '../src/vfs/mounts';
import { setDiagnosticsSink } from '../src/obs/log';
import { DefaultExecutionRouter } from '../src/execution/router';
import { buildBuiltinTools } from '../src/tools/builtins';
import { toolExecute } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import type { JsonValue } from '../src/utils/json';

const STUDIO: DeviceFleetEntry = {
  id: 'dev-studio', name: 'ashish@studio', os: 'darwin', hostname: 'studio', connected: true,
};

const RIG: DeviceFleetEntry = {
  id: 'dev-rig', name: 'mrwhite@rig', os: 'linux', hostname: 'rig', connected: true,
};

const SPARE: DeviceFleetEntry = {
  id: 'dev-spare', name: 'spare box', os: 'linux', hostname: 'spare', connected: false,
};

interface Sent { method: string; params: JsonValue[]; deviceId: string | undefined }

/** A transport whose fleet is exactly `devices`, recording which machine each
 *  frame was addressed to — the observable the routing proof reads. */
function fleetTransport(devices: readonly DeviceFleetEntry[]): DeviceTransport & { sent: Sent[]; setFleet(next: readonly DeviceFleetEntry[]): void } {
  const sent: Sent[] = [];
  let fleet = devices;

  const status = (): DeviceStatus => ({
    connected: fleet.some((d) => d.connected),
    registered: fleet.length > 0,
    toolchain: null,
    devices: fleet,
  });

  return {
    sent,
    setFleet(next) { fleet = next; },
    status,
    refreshStatus: async () => status(),
    rpc: async (method, params, opts): Promise<JsonValue> => {
      sent.push({ method, params, deviceId: opts?.deviceId });

      if (method === 'exec') return { stdout: `ran on ${opts?.deviceId ?? 'unnamed'}`, stderr: '', exitCode: 0 };

      if (method === 'listFiles') return [{ name: `entry-of-${opts?.deviceId}`, type: 'file' }];

      if (method === 'exists') return true;

      if (method === 'statPath') return { size: 3, mtimeMs: 0, isDir: false };

      if (method === 'writeFile') return { success: true };

      return { content: Buffer.from(`bytes of ${opts?.deviceId}`).toString('base64'), encoding: 'base64' };
    },
  };
}

describe('the device fleet at the executor surface', () => {
  test('a command addressed to one machine reaches THAT machine and no other', async () => {
    const t = fleetTransport([STUDIO, RIG]);
    const provider = createDeviceTunnelExecutor(t);

    expect(await provider.tools.exec.execute('uname -a', { device: 'mrwhite@rig' })).toBe('ran on dev-rig');
    expect(await provider.tools.exec.execute('uname -a', { device: 'ashish@studio' })).toBe('ran on dev-studio');
    // The codemode spelling — a bare name as the trailing argument — is the
    // same call.
    expect(await provider.tools.exec.execute('uname -a', 'mrwhite@rig')).toBe('ran on dev-rig');

    expect(t.sent.map((frame) => frame.deviceId)).toEqual(['dev-rig', 'dev-studio', 'dev-rig']);
  });

  test('an unnamed command on a fleet of several is refused with the classified ask', async () => {
    const t = fleetTransport([STUDIO, RIG, SPARE]);
    const provider = createDeviceTunnelExecutor(t);

    const refusal = answeredRefusal(await provider.tools.exec.execute('make') ?? null);

    expect(refusal?.reason).toBe('bad_input');
    // The ask names every LIVE machine with its platform, and nothing else:
    // the offline spare is not an answer, and no id or internal leaks.
    expect(refusal?.error).toBe(deviceFleetAsk([STUDIO, RIG, SPARE]));
    expect(refusal?.error).toContain('ashish@studio (darwin)');
    expect(refusal?.error).toContain('mrwhite@rig (linux)');
    expect(refusal?.error).not.toContain('spare box');
    expect(refusal?.error).not.toContain('dev-');
    // Nothing crossed to any machine.
    expect(t.sent).toEqual([]);
  });

  test('a name no live machine holds is refused naming the ones that are', async () => {
    const t = fleetTransport([STUDIO, RIG, SPARE]);
    const provider = createDeviceTunnelExecutor(t);

    const offline = answeredRefusal(await provider.tools.exec.execute('ls', { device: 'spare box' }) ?? null);
    const unknown = parseJsonValue(String(await provider.tools.readFile.execute('/etc/hosts', { device: 'toaster' })));

    expect(offline?.reason).toBe('unavailable');
    expect(offline?.error).toContain('"spare box"');
    expect(offline?.error).toContain('ashish@studio, mrwhite@rig');
    expect(unknown).toMatchObject({ reason: 'unavailable', error: expect.stringContaining('"toaster"') });
    expect(t.sent).toEqual([]);
  });

  test('one live machine needs no name, and a second connecting does not move it', async () => {
    const t = fleetTransport([STUDIO, SPARE]);
    const provider = createDeviceTunnelExecutor(t);

    // Sole live machine: unnamed calls are unambiguous and carry its id.
    expect(await provider.tools.exec.execute('pwd')).toBe('ran on dev-studio');

    // The rig connects. A call that still names the studio lands on the
    // studio — nothing about a second machine changes where the first is.
    t.setFleet([STUDIO, RIG, SPARE]);
    expect(await provider.tools.exec.execute('pwd', { device: 'ashish@studio' })).toBe('ran on dev-studio');

    // The rig leaves again. The studio keeps working, and unnamed calls
    // resolve to it again without a flap in between.
    t.setFleet([STUDIO, SPARE]);
    expect(await provider.tools.exec.execute('pwd')).toBe('ran on dev-studio');

    expect(t.sent.map((frame) => frame.deviceId)).toEqual(['dev-studio', 'dev-studio', 'dev-studio']);
  });

  test('every file tool rides the named machine, not the first live one', async () => {
    const t = fleetTransport([STUDIO, RIG]);
    const provider = createDeviceTunnelExecutor(t);

    expect(await provider.tools.readFile.execute('/etc/hosts', { device: 'mrwhite@rig' })).toBe('bytes of dev-rig');
    expect(await provider.tools.readdir.execute('/home', { device: 'mrwhite@rig' })).toEqual(['entry-of-dev-rig']);
    expect(await provider.tools.exists.execute('/home', { device: 'ashish@studio' })).toBe(true);
    expect(await provider.tools.writeFile.execute('/tmp/x', 'y', { device: 'ashish@studio' })).toBe('Written 1 bytes to /tmp/x');

    expect(t.sent.map((frame) => [frame.method, frame.deviceId])).toEqual([
      ['readFile', 'dev-rig'], ['listFiles', 'dev-rig'], ['exists', 'dev-studio'], ['writeFile', 'dev-studio'],
    ]);
  });

  test('a snapshot that has not described the fleet gates nothing, exactly as before', async () => {
    // No `devices` at all: the hub answers authoritatively for a one-machine
    // account, and the executor must not invent a refusal from ignorance.
    const bare: DeviceTransport & { sent: Sent[] } = {
      sent: [],
      status: () => ({ connected: false, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: false, registered: true, toolchain: null }),
      rpc: async (method, params, opts): Promise<JsonValue> => {
        bare.sent.push({ method, params, deviceId: opts?.deviceId });

        return { stdout: 'hi', stderr: '', exitCode: 0 };
      },
    };

    const provider = createDeviceTunnelExecutor(bare);

    expect(await provider.tools.exec.execute('echo hi')).toBe('hi');
    expect(bare.sent).toEqual([{ method: 'exec', params: ['echo hi'], deviceId: undefined }]);
    // A NAME cannot be matched without the fleet, and that is said rather
    // than sent to whichever machine the hub would pick.
    const named = answeredRefusal(await provider.tools.exec.execute('echo hi', { device: 'ashish@studio' }) ?? null);
    expect(named?.reason).toBe('unavailable');
    expect(named?.error).toContain('not known here yet');
  });
});

describe('the composite file plane', () => {
  test('one live machine still serves under /pc/<name>, so a second machine never moves paths', async () => {
    const t = fleetTransport([STUDIO, SPARE]);

    const provider = createDeviceTunnelExecutor(t, {
      consentedRoot: async () => '/home/dev', deviceHome: async () => '/home/dev', unconfined: async () => true,
    });

    // The composite plane is the provider's own public `files`; the test
    // reaches it the way the mount table does, never a private builder.
    const plane = provider.files;

    if (plane === undefined) throw new Error('the device executor exposes no file plane');

    expect(await plane.readFile('/ashish@studio/home/dev/notes.md', { encoding: 'utf8' })).toBe('bytes of dev-studio');
    expect(await plane.readdir('/ashish@studio/home/dev')).toEqual(['entry-of-dev-studio']);
    expect(await plane.readdir('/')).toEqual(['ashish@studio']);
    // The provider opens on the roster, and on ONE machine's own opening dir
    // when asked by segment — never on a machine picked for the fleet.
    expect(await provider.homeDir()).toBe('/');
    expect(await provider.homeDir('ashish@studio')).toBe('/home/dev');
    await expect(provider.homeDir('toaster')).rejects.toMatchObject({ code: 'ENXIO' });
    expect(t.sent.map((frame) => [frame.params[0], frame.deviceId])).toEqual([
      ['/home/dev/notes.md', 'dev-studio'], ['/home/dev', 'dev-studio'],
    ]);
  });

  test('a fleet serves each machine under /pc/<name>, and its root lists them', async () => {
    const t = fleetTransport([STUDIO, RIG, SPARE]);

    const provider = createDeviceTunnelExecutor(t, {
      consentedRoot: async () => '/', deviceHome: async () => '/', unconfined: async () => true,
    });

    // The composite plane is the provider's own public `files`; the test
    // reaches it the way the mount table does, never a private builder.
    const plane = provider.files;

    if (plane === undefined) throw new Error('the device executor exposes no file plane');

    expect(await plane.readdir('/')).toEqual(['ashish@studio', 'mrwhite@rig']);
    expect(await plane.stat('/')).toMatchObject({ isDir: true });
    expect(await plane.readFile('/mrwhite@rig/etc/hosts', { encoding: 'utf8' })).toBe('bytes of dev-rig');
    expect(await plane.readdir('/ashish@studio/home')).toEqual(['entry-of-dev-studio']);
    expect(await provider.homeDir()).toBe('/');
    // The segment is stripped: the machine sees its own native path.
    expect(t.sent.map((frame) => [frame.params[0], frame.deviceId])).toEqual([
      ['/etc/hosts', 'dev-rig'], ['/home', 'dev-studio'],
    ]);
  });

  test('a path under no live machine is a stated absence naming the fleet', async () => {
    const t = fleetTransport([STUDIO, RIG]);

    const provider = createDeviceTunnelExecutor(t, {
      consentedRoot: async () => '/', deviceHome: async () => '/', unconfined: async () => true,
    });

    // The composite plane is the provider's own public `files`; the test
    // reaches it the way the mount table does, never a private builder.
    const plane = provider.files;

    if (plane === undefined) throw new Error('the device executor exposes no file plane');

    await expect(plane.readFile('/home/dev/a.txt')).rejects.toMatchObject({ code: 'ENXIO' });
    await expect(plane.readFile('/home/dev/a.txt')).rejects.toThrow('no connected machine is named "home"');
    await expect(plane.readFile('/home/dev/a.txt')).rejects.toThrow('ashish@studio, mrwhite@rig');
    expect(await plane.exists('/toaster/x')).toBe(false);
    expect(await plane.stat('/toaster')).toBeNull();
    expect(t.sent).toEqual([]);
  });

  test('a shared or unusable name falls back to the id, so two machines never collide', () => {
    const twin: DeviceFleetEntry = { ...RIG, id: 'dev-twin', name: 'ashish@studio' };
    const slashed: DeviceFleetEntry = { ...RIG, id: 'dev-slashed', name: 'work/device' };
    const fleet = [STUDIO, twin, slashed];

    expect(deviceMountSegment(STUDIO, fleet)).toBe('dev-studio');
    expect(deviceMountSegment(twin, fleet)).toBe('dev-twin');
    expect(deviceMountSegment(slashed, fleet)).toBe('dev-slashed');
    expect(deviceMountSegment(RIG, [STUDIO, RIG])).toBe('mrwhite@rig');
  });
});

describe('where the file browser lands on a mount', () => {
  /** The browser's own path: `getExecutorFiles` over the workspace plane
   *  carrying the standard mount table, with the REAL device provider behind
   *  `/pc` — the composition the product runs, never a stubbed plane. Each
   *  machine consents to its own directory, so a landing that picked the
   *  wrong machine reads as the wrong home. */
  function browser(fleet: readonly DeviceFleetEntry[], opts: { consented?: Record<string, string | null>; unconfined?: boolean } = {}) {
    const t = fleetTransport(fleet);
    const consented = opts.consented ?? { 'dev-studio': '/home/studio', 'dev-rig': '/home/rig' };

    const provider = createDeviceTunnelExecutor(t, {
      consentedRoot: async (id) => consented[id ?? ''] ?? null,
      deviceHome: async (id) => consented[id ?? ''] ?? null,
      unconfined: async () => opts.unconfined ?? false,
    });

    const router = new DefaultExecutionRouter();
    router.register(provider);
    const workspace = withMountTable(createTestRuntime().rt.storage.vfs, standardMounts((name) => router.getProvider(name)));

    const lookup = {
      getProvider: (name: string) => name === 'workspace'
        ? { files: workspace, homeDir: async () => '/home/user' }
        : router.getProvider(name),
    };

    return { t, list: (path: string) => getExecutorFiles(lookup, 'workspace', path) };
  }

  test('bare /pc is the roster: it lists the machines and lands on itself', async () => {
    const { t, list } = browser([STUDIO, RIG, SPARE]);
    const out = await list('/pc');
    expect(out.error).toBeUndefined();
    expect(out.path).toBe('/pc');
    expect(out.entries?.map((e) => e.name)).toEqual(['ashish@studio', 'mrwhite@rig']);
    expect(t.sent).toEqual([]);
  });

  test('/pc/<name> lands in THAT machine\'s consented directory, whichever machine it is', async () => {
    const { t, list } = browser([STUDIO, RIG]);
    const rig = await list('/pc/mrwhite@rig');
    expect(rig.error).toBeUndefined();
    expect(rig.path).toBe('/pc/mrwhite@rig/home/rig');
    const studio = await list('/pc/ashish@studio/');
    expect(studio.path).toBe('/pc/ashish@studio/home/studio');
    // Every frame the landing sent went to the machine the path named.
    expect(t.sent.map((frame) => frame.deviceId)).toEqual(t.sent.map((frame) => frame.params[0] === '/home/rig' || String(frame.params[0]).startsWith('/home/rig/') ? 'dev-rig' : 'dev-studio'));
    expect(new Set(t.sent.map((frame) => frame.deviceId))).toEqual(new Set(['dev-rig', 'dev-studio']));
  });

  test('one machine lands the same way: the roster at /pc, its home under /pc/<name>', async () => {
    const { list } = browser([STUDIO]);
    expect((await list('/pc')).entries?.map((e) => e.name)).toEqual(['ashish@studio']);
    expect((await list('/pc/ashish@studio')).path).toBe('/pc/ashish@studio/home/studio');
  });

  test('the consent boundary still refuses what it refused before', async () => {
    // Nothing widened: the landing moved, the boundary did not.
    const out = await list0([STUDIO], '/pc/ashish@studio/etc');
    expect(out.entries).toBeUndefined();
    expect(out.error).toContain("outside the consented device directory '/home/studio'");
  });

  test('a path already inside the mount is passed through untouched', async () => {
    const { list } = browser([STUDIO, RIG]);
    const out = await list('/pc/mrwhite@rig/home/rig/src');
    expect(out.path).toBe('/pc/mrwhite@rig/home/rig/src');
    expect(out.entries?.map((e) => e.name)).toEqual(['entry-of-dev-rig']);
  });

  test('a machine consenting to its whole filesystem keeps the bare machine root', async () => {
    const { list } = browser([STUDIO], { consented: { 'dev-studio': '/' }, unconfined: true });
    const out = await list('/pc/ashish@studio');
    expect(out.path).toBe('/pc/ashish@studio');
    expect(out.entries?.map((e) => e.name)).toEqual(['entry-of-dev-studio']);
  });

  test('a machine that cannot say where it starts surfaces ITS refusal, and the asking is recorded', async () => {
    // The two assertions on the error cannot tell "the fallback was taken"
    // from "the resolution never ran": both read as the plane's own refusal.
    // The diagnostic is the discriminator — it fires ONLY on the caught path.
    const events: string[] = [];

    const restore = setDiagnosticsSink({
      event: (name) => { events.push(name); },
      failure: (name) => { events.push(name); },
    });

    try {
      const { list } = browser([STUDIO], { consented: { 'dev-studio': null } });
      const out = await list('/pc/ashish@studio');
      expect(out.error).toContain('reported no consented directory');
      expect(events).toContain('files.mount_home_unavailable');
    } finally {
      restore();
    }
  });

  test('a machine that CAN say where it starts absorbs nothing, and says nothing', async () => {
    const events: string[] = [];

    const restore = setDiagnosticsSink({
      event: (name) => { events.push(name); },
      failure: (name) => { events.push(name); },
    });

    try {
      const { list } = browser([STUDIO]);
      expect((await list('/pc/ashish@studio')).path).toBe('/pc/ashish@studio/home/studio');
      expect(events).not.toContain('files.mount_home_unavailable');
    } finally {
      restore();
    }
  });

  test('a name no live machine holds lands nowhere and lists the stated absence', async () => {
    const { list } = browser([STUDIO, RIG]);
    const out = await list('/pc/toaster');
    expect(out.entries).toBeUndefined();
    expect(out.error).toContain('no connected machine is named "toaster"');
    expect(out.error).toContain('ashish@studio, mrwhite@rig');
  });

  function list0(fleet: readonly DeviceFleetEntry[], path: string) {
    return browser(fleet).list(path);
  }
});

describe('the shell tool names the machine', () => {
  /** `shell` over the real router and the real provider — the path a model's
   *  `shell { runtime: "<nickname>" }` actually takes. */
  function runTool(fleet: readonly DeviceFleetEntry[]) {
    const t = fleetTransport(fleet);
    const { rt } = createTestRuntime();
    const router = new DefaultExecutionRouter();
    router.register(createDeviceTunnelExecutor(t));
    // The tool reads the fleet off the transport the backend hands it, so the
    // harness hands the same transport through the runtime.
    const tools = buildBuiltinTools({ rt: { ...rt, executionRouter: router, deviceTransport: t } });

    return {
      t,
      run: toolExecute<{ command: string; runtime: string; why?: string }, string>(tools.shell),
    };
  }

  test('the nickname rides the call to the named machine, and its absence on a fleet is the ask', async () => {
    const { t, run } = runTool([STUDIO, RIG]);

    expect(await run({ command: 'uname', runtime: 'mrwhite@rig', why: 'their GPU' })).toBe('ran on dev-rig');
    expect(t.sent.map((frame) => frame.deviceId)).toEqual(['dev-rig']);

    const unknown = run({ command: 'uname', runtime: 'toaster', why: 'their GPU' });
    await expect(unknown).rejects.toMatchObject({ code: 'unavailable' });
    await expect(unknown).rejects.toThrow('no connected machine is named "toaster"');

    expect(t.sent).toHaveLength(1);
  });

  test('one machine needs no name; the class name still reaches the sole machine', async () => {
    const { run } = runTool([STUDIO]);
    expect(await run({ command: 'uname', runtime: 'ashish@studio', why: 'their files' })).toBe('ran on dev-studio');
    expect(await run({ command: 'uname', runtime: 'device', why: 'their files' })).toBe('ran on dev-studio');
  });

  test('a nickname before the fleet is described is refused by the executor, never as an unregistered runtime', async () => {
    // The executor is the one resolver: the tool hands it every non-executor
    // name, so a nickname the transport cannot match yet gets the executor's
    // own refusal (the list is not known, retry), not the router's vocabulary.
    const t = fleetTransport([]);

    const undescribed: DeviceTransport = {
      ...t, status: () => ({ ...t.status(), devices: undefined }),
    };

    const { rt } = createTestRuntime();
    const router = new DefaultExecutionRouter();
    router.register(createDeviceTunnelExecutor(undescribed));
    const tools = buildBuiltinTools({ rt: { ...rt, executionRouter: router, deviceTransport: undescribed } });
    const run = toolExecute<{ command: string; runtime: string; why?: string }, string>(tools.shell);

    const early = run({ command: 'uname', runtime: 'spare box', why: 'their files' });
    await expect(early).rejects.toMatchObject({ code: 'unavailable' });
    await expect(early).rejects.toThrow('"spare box" cannot be matched');
    await expect(early).rejects.not.toThrow('not registered');
    expect(t.sent).toEqual([]);
  });
});
