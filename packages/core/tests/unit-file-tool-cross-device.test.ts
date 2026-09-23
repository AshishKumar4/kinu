// The agent's `file` tool reaches another machine's file through that machine's mount, `/pc/<name>/...`,
// and names what it touched by the machine's reference, `<name>://...`, which a chat surface turns into a link.
import { describe, expect, test } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { createDeviceTunnelExecutor, type DeviceTransport } from '../src/execution/device-tunnel-executor';
import type { DeviceFleetEntry, DeviceStatus } from '../src/execution/device-status';
import { DefaultExecutionRouter } from '../src/execution/router';
import { buildBuiltinTools } from '../src/tools/builtins';
import type { FileToolInput } from '../src/tools/file-tool';
import type { JsonValue } from '../src/utils/json';
import { standardMounts, withMountTable } from '../src/vfs/mounts';
import { createTestRuntime, storesFor } from './helpers';

const STUDIO: DeviceFleetEntry = { id: 'dev-studio', name: 'ashish@studio', os: 'darwin', hostname: 'studio', connected: true };

const RIG: DeviceFleetEntry = { id: 'dev-rig', name: 'mrwhite@rig', os: 'linux', hostname: 'rig', connected: true };

interface Frame { readonly method: string; readonly path: JsonValue | undefined; readonly deviceId: string | undefined }

/** Two machines holding different bytes at the same path; every frame records the machine it was sent to. */
function fleet(): DeviceTransport & { readonly frames: Frame[] } {
  const frames: Frame[] = [];
  const status = (): DeviceStatus => ({ connected: true, registered: true, toolchain: null, devices: [STUDIO, RIG] });
  const bytesOn = (deviceId: string | undefined) => Buffer.from(`notes kept on ${deviceId ?? 'no machine'}`);

  return {
    frames,
    status,
    refreshStatus: async () => status(),
    rpc: async (method, params, opts): Promise<JsonValue> => {
      frames.push({ method, path: params[0], deviceId: opts?.deviceId });
      const bytes = bytesOn(opts?.deviceId);

      if (method === 'exists') return true;

      if (method === 'statPath') return { size: bytes.length, mtimeMs: 0, isDir: false };

      if (method === 'writeFile') return { success: true };

      if (method === 'readRange') {
        const offset = Number(params[1]);

        return { content: bytes.subarray(offset, offset + Number(params[2])).toString('base64'), encoding: 'base64' };
      }

      return { content: bytes.toString('base64'), encoding: 'base64' };
    },
  };
}

function fileToolOverTheFleet() {
  const transport = fleet();
  const { rt } = createTestRuntime();
  const router = new DefaultExecutionRouter();

  router.register(createDeviceTunnelExecutor(transport, {
    consentedRoot: async () => '/', deviceHome: async () => '/home', unconfined: async () => true,
  }));

  const plane = withMountTable(rt.storage.vfs, standardMounts((name) => router.getProvider(name)));

  const tools = buildBuiltinTools({
    rt: { ...rt, storage: { ...rt.storage, vfs: plane }, executionRouter: router, deviceTransport: transport },
    history: storesFor(rt).history,
  });

  if (tools.file === undefined) throw new Error('No file tool');

  return { transport, file: toolExecute<FileToolInput, JsonValue>(tools.file) };
}

describe('a file on another machine', () => {
  test('is read through its mount from that machine, not from the other one', async () => {
    const { transport, file } = fileToolOverTheFleet();

    expect(await file({ action: 'read', path: '/pc/mrwhite@rig/home/notes.md' })).toContain('notes kept on dev-rig');
    expect(transport.frames.filter((frame) => frame.path === '/home/notes.md').map((frame) => frame.deviceId))
      .toEqual(expect.arrayContaining(['dev-rig']));
    expect(transport.frames.map((frame) => frame.deviceId)).not.toContain('dev-studio');
  });

  test('is written on that machine and named by its reference', async () => {
    const { transport, file } = fileToolOverTheFleet();

    await file({ action: 'read', path: '/pc/ashish@studio/home/notes.md' });

    expect(await file({ action: 'write', path: '/pc/ashish@studio/home/notes.md', content: 'moved here' }))
      .toMatchObject({ ok: true, reference: 'ashish@studio://home/notes.md' });
    expect(transport.frames.filter((frame) => frame.method === 'writeFile'))
      .toEqual([{ method: 'writeFile', path: '/home/notes.md', deviceId: 'dev-studio' }]);
  });
});
