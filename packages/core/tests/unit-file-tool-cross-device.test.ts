// The agent's `file` tool reaches another machine's file through that machine's mount, `/pc/<name>/...`,
import * as v from 'valibot';
// and names what it touched by the machine's reference, `<name>://...`, which a chat surface turns into a link.
import { describe, expect, test } from 'bun:test';
import { present, toolExecute } from '@kinu.run/test-utils';
import { createDeviceTunnelExecutor, type DeviceTransport } from '../src/execution/device-tunnel-executor';
import { DEVICE_ERRORS, DEVICE_UPDATE_REQUIRED, deviceFailure } from '../src/execution/device-protocol';
import { renderThrownChain } from '../src/obs/index';
import type { DeviceFleetEntry, DeviceStatus } from '../src/execution/device-status';
import { DefaultExecutionRouter } from '../src/execution/router';
import { buildBuiltinTools } from '../src/tools/builtins';
import { withApprovalGatedFiles } from '../src/execution/approval';
import { createInlineExecutor } from '../src/tools/inline-executor';
import { executorNamespace } from '../src/tools/executor-operations';
import { createSandboxExecutor } from '../src/execution/sandbox';
import { createParentExecutor, type ParentWorkspaceHandle } from '../src/execution/parent';
import type { ShellApprovalPolicy } from '../src/safety/approval-gate';

type FileToolInput = JsonObject & { readonly op: string };

import { isJsonObject, type JsonValue, type JsonObject } from '../src/utils/json';
import { sha256Hex } from '../src/safety/argument-digest';
import { standardMounts, withMountTable } from '../src/vfs/mounts';
import { createTestRuntime, conversationsFor } from './helpers';
import { cloudPlanes } from '../src/vfs/resolve';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';

const STUDIO: DeviceFleetEntry = { id: 'dev-studio', name: 'ashish@studio', os: 'darwin', hostname: 'studio', connected: true };

const RIG: DeviceFleetEntry = { id: 'dev-rig', name: 'mrwhite@rig', os: 'linux', hostname: 'rig', connected: true };

interface Frame { readonly method: string; readonly path: JsonValue | undefined; readonly deviceId: string | undefined }

/** Two machines holding different bytes at the same path; every frame records the machine it was sent to. */
function fleet(written: JsonValue): DeviceTransport & { readonly frames: Frame[] } {
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

      if (method === 'writeFile') return written;

      // The machine compares the bytes it holds against the digest the write names, and answers the new one.
      if (method === 'writeFileIfDigest') {
        const expected = params[2] ?? null;
        const held = sha256Hex(bytesOn(opts?.deviceId));

        if (expected !== held && expected !== null) return { ok: false, sha256: held };
        const answer: JsonObject = { ok: true, sha256: sha256Hex(Buffer.from(v.parse(v.string(), params[1]), 'base64')) };

        if (isJsonObject(written)) Object.assign(answer, written);

        return answer;
      }

      if (method === 'readRange') {
        const offset = Number(params[1]);

        return { content: bytes.subarray(offset, offset + Number(params[2])).toString('base64'), encoding: 'base64' };
      }

      return { content: bytes.toString('base64'), encoding: 'base64' };
    },
  };
}

/** The owner answers every ask `allow`, as production's toolFiles gate reaches them. */
const OWNER_ALLOWS: ShellApprovalPolicy = { mode: () => 'strict', granted: () => false, requestApproval: async () => 'allow' };

/** No ask is answered yes: a secret-looking read is refused. */
const DENY_ALL: ShellApprovalPolicy = { mode: () => 'deny_all', granted: () => false, requestApproval: async () => 'deny' };

function fileToolOverTheFleet(written: JsonValue = { success: true }, gated = false, policy: ShellApprovalPolicy = OWNER_ALLOWS, transport = fleet(written)) {
  const { rt } = createTestRuntime();
  const router = new DefaultExecutionRouter();

  router.register(createDeviceTunnelExecutor(transport, {
    consentedRoot: async () => '/', deviceHome: async () => '/home', scope: async () => 'unconfined',
  }));

  const plane = withMountTable(rt.storage.vfs, standardMounts((name) => router.getProvider(name)));

  const toolFiles = gated
    ? withApprovalGatedFiles(plane, 'workspace', { planes: cloudPlanes(WORKSPACE_ROOT), resolve: (path, follow) => plane.resolve(path, { follow }), userRoots: () => plane.userRoots(), locate: null, parksWrites: true }, policy)
    : plane;

  const tools = buildBuiltinTools({
    rt: { ...rt, storage: { ...rt.storage, vfs: plane }, toolFiles, executionRouter: router, deviceTransport: transport },
    conversations: conversationsFor(rt),
  });

  if (tools.file === undefined) throw new Error('No file tool');
  const { memory, craftStore } = rt;
  const shell = present(rt.shell, 'the workspace shell');
  const workspace = createInlineExecutor({ vfs: toolFiles, files: plane, memory, craftStore, shell, filesOwner: 'agent' });
  const writeFile = workspace.tools.writeFile;

  if (writeFile === undefined) throw new Error('No workspace.writeFile');

  return {
    transport, file: toolExecute<FileToolInput, JsonValue>(tools.file),
    readFile: (path: string) => workspace.tools.readFile?.execute(path),
    writeFile: (path: string, content: string) => writeFile.execute(path, content),
  };
}

describe('a file on another machine', () => {
  test('is read through its mount from that machine, not from the other one', async () => {
    const { transport, file } = fileToolOverTheFleet();

    expect(await file({ op: 'read', path: '/pc/mrwhite@rig/home/notes.md' })).toContain('notes kept on dev-rig');
    expect(transport.frames.filter((frame) => frame.path === '/home/notes.md').map((frame) => frame.deviceId))
      .toEqual(expect.arrayContaining(['dev-rig']));
    expect(transport.frames.map((frame) => frame.deviceId)).not.toContain('dev-studio');
  });

  test('is written on that machine and named by its reference', async () => {
    const { transport, file } = fileToolOverTheFleet();

    await file({ op: 'read', path: '/pc/ashish@studio/home/notes.md' });

    expect(await file({ op: 'write', path: '/pc/ashish@studio/home/notes.md', content: 'moved here' }))
      .toMatchObject({ reference: 'ashish@studio://home/notes.md' });
    expect(transport.frames.filter((frame) => frame.method.startsWith('writeFile')))
      .toEqual([{ method: 'writeFileIfDigest', path: '/home/notes.md', deviceId: 'dev-studio' }]);
  });

  test('whose daemon predates checked writes, is not written, and the refusal names the update to make', async () => {
    const machine = fleet({ success: true });

    const older: typeof machine = {
      ...machine,
      rpc: async (method, params, opts) => {
        if (method !== 'writeFileIfDigest') return machine.rpc(method, params, opts);
        machine.frames.push({ method, path: params[0], deviceId: opts?.deviceId });

        throw deviceFailure(DEVICE_ERRORS.unknownMethod, `This machine's daemon is older than ${method}: ${DEVICE_UPDATE_REQUIRED}.`);
      },
    };

    const { transport, file } = fileToolOverTheFleet(undefined, false, OWNER_ALLOWS, older);

    await file({ op: 'read', path: '/pc/ashish@studio/home/notes.md' });
    const [refused] = await Promise.allSettled([file({ op: 'write', path: '/pc/ashish@studio/home/notes.md', content: 'moved here' })]);

    if (refused.status !== 'rejected') throw new Error('expected the write to be refused');
    // The chain the agent is shown, as a tool error renders it.
    expect(refused.reason).toMatchObject({ code: 'unsupported' });
    expect(renderThrownChain({ cause: refused.reason })).toContain('update the daemon (kinu update)');
    expect(transport.frames.filter((frame) => frame.method.startsWith('writeFile')).map((frame) => frame.method)).toEqual(['writeFileIfDigest']);
  });

  test('written where no checkpoint covers it, says undo cannot restore the write', async () => {
    const why = 'it is the owner\'s home folder itself, too much to copy before every command';

    const { file } = fileToolOverTheFleet({ success: true, uncheckpointed: { dir: '/home', why } });
    const undo = `No checkpoint covers /home: ${why}, so undo cannot restore what this write changed there.`;

    await file({ op: 'read', path: '/pc/ashish@studio/home/notes.md' });
    expect(await file({ op: 'write', path: '/pc/ashish@studio/home/notes.md', content: 'moved here' }))
      .toMatchObject({ undo });
    // This fleet never keeps a write, so the edit reads the machine's own bytes first.
    await file({ op: 'read', path: '/pc/ashish@studio/home/notes.md' });
    expect(await file({ op: 'edit', path: '/pc/ashish@studio/home/notes.md', edits: [{ old_text: 'kept', new_text: 'moved' }] }))
      .toMatchObject({ undo });
  });

  test('an overwrite the owner approves still says undo cannot restore it, from the file tool and from codemode', async () => {
    const why = 'it is the owner\'s home folder itself, too much to copy before every command';

    const { file, readFile, writeFile } = fileToolOverTheFleet({ success: true, uncheckpointed: { dir: '/home', why } }, true);
    const undo = `No checkpoint covers /home: ${why}, so undo cannot restore what this write changed there.`;

    await file({ op: 'read', path: '/pc/ashish@studio/home/notes.md' });
    expect(await file({ op: 'write', path: '/pc/ashish@studio/home/notes.md', content: 'moved here' }))
      .toMatchObject({ undo });

    await readFile('/pc/ashish@studio/home/notes.md');
    expect(await writeFile('/pc/ashish@studio/home/notes.md', 'moved again')).toContain(undo);
  });
});

// One path for every file plane: the workspace's `file` and `workspace.readFile/writeFile`, over the gated plane where
// each machine and the sandbox are mounted, carry the prior-read ledger and the approval gate. An executor's own
// file members would be a second path past both.
describe('a program reaches another plane\'s files', () => {
  const unused = async (): Promise<never> => { throw new Error('not reached'); };

  const parentHandle: ParentWorkspaceHandle = { read: unused, write: unused, list: unused, stat: unused, delete: unused, exec: unused };

  test('only through the workspace\'s files: the machine, the sandbox and the parent offer no read or write of their own', () => {
    const providers = [
      createDeviceTunnelExecutor(fleet({ success: true }), { consentedRoot: async () => '/', deviceHome: async () => '/home', scope: async () => 'unconfined' }),
      createSandboxExecutor(),
      createParentExecutor({ handle: parentHandle }),
    ];

    const ownFileMembers = providers.map((provider) => {
      const members = Object.keys(executorNamespace(provider).declarations ?? {});

      return [provider.name, members.filter((member) => member === 'readFile' || member === 'writeFile')];
    });

    expect(ownFileMembers).toEqual([['device', []], ['sandbox', []], ['parent', []]]);
  });

  test('and a secret on the machine is refused there as the file tool refuses it', async () => {
    const { readFile } = fileToolOverTheFleet({ success: true }, true, DENY_ALL);

    await expect(readFile('/pc/ashish@studio/home/.env')).rejects.toMatchObject({ code: 'denied' });
  });
});
