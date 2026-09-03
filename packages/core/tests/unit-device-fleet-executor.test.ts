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
import { parseRefusal } from '../src/execution/exec-result';
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

    const answer = String(await provider.tools.exec.execute('make'));
    const refusal = parseRefusal(answer);

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

    const offline = parseRefusal(String(await provider.tools.exec.execute('ls', { device: 'spare box' })));
    const unknown = parseRefusal(String(await provider.tools.readFile.execute('/etc/hosts', { device: 'toaster' })));

    expect(offline?.reason).toBe('unavailable');
    expect(offline?.error).toContain('"spare box"');
    expect(offline?.error).toContain('ashish@studio, mrwhite@rig');
    expect(unknown?.reason).toBe('unavailable');
    expect(unknown?.error).toContain('"toaster"');
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
    const named = parseRefusal(String(await provider.tools.exec.execute('echo hi', { device: 'ashish@studio' })));
    expect(named?.reason).toBe('unavailable');
    expect(named?.error).toContain('not known here yet');
  });
});

describe('the composite file plane', () => {
  test('one live machine keeps /pc as its own root, byte for byte', async () => {
    const t = fleetTransport([STUDIO, SPARE]);
    const provider = createDeviceTunnelExecutor(t, {
      consentedRoot: async () => '/home/dev', deviceHome: async () => '/home/dev', unconfined: async () => true,
    });
    // The composite plane is the provider's own public `files`; the test
    // reaches it the way the mount table does, never a private builder.
    const plane = provider.files;
    if (plane === undefined) throw new Error('the device executor exposes no file plane');

    expect(await plane.readFile('/home/dev/notes.md', { encoding: 'utf8' })).toBe('bytes of dev-studio');
    expect(await plane.readdir('/home/dev')).toEqual(['entry-of-dev-studio']);
    expect(await provider.homeDir()).toBe('/home/dev');
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
    const slashed: DeviceFleetEntry = { ...RIG, id: 'dev-slashed', name: 'work/laptop' };
    const fleet = [STUDIO, twin, slashed];

    expect(deviceMountSegment(STUDIO, fleet)).toBe('dev-studio');
    expect(deviceMountSegment(twin, fleet)).toBe('dev-twin');
    expect(deviceMountSegment(slashed, fleet)).toBe('dev-slashed');
    expect(deviceMountSegment(RIG, [STUDIO, RIG])).toBe('mrwhite@rig');
  });
});

describe('the run tool names the machine', () => {
  /** `run` over the real router and the real provider — the path a model's
   *  `run { runtime: "laptop", device }` actually takes. */
  function runTool(fleet: readonly DeviceFleetEntry[]) {
    const t = fleetTransport(fleet);
    const { rt } = createTestRuntime();
    const router = new DefaultExecutionRouter();
    router.register(createDeviceTunnelExecutor(t));
    const tools = buildBuiltinTools({ rt: { ...rt, executionRouter: router } });
    return {
      t,
      run: toolExecute<{ command: string; runtime: string; device?: string; why?: string }, string>(tools.run),
    };
  }

  test('device rides the call to the named machine, and its absence on a fleet is the ask', async () => {
    const { t, run } = runTool([STUDIO, RIG]);

    expect(await run({ command: 'uname', runtime: 'laptop', device: 'mrwhite@rig', why: 'their GPU' })).toBe('ran on dev-rig');
    expect(t.sent.map((frame) => frame.deviceId)).toEqual(['dev-rig']);

    const refusal = parseRefusal(await run({ command: 'uname', runtime: 'laptop', why: 'their GPU' }));
    expect(refusal?.reason).toBe('bad_input');
    expect(refusal?.error).toContain('name the machine this command runs on');
    expect(t.sent).toHaveLength(1);
  });

  test('the field exists on the schema the model reads, and only laptop needs it', async () => {
    const { run } = runTool([STUDIO]);
    // One machine: no device needed, exactly as before the fleet.
    expect(await run({ command: 'uname', runtime: 'laptop', why: 'their files' })).toBe('ran on dev-studio');
  });
});
