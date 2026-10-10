/**
 * A write over a file on the user's machine parks on its bytes while nobody answers, and the owner's answer performs
 * exactly that write. Driven through the hosted main actor's real file tool and device executor, the orchestrator's
 * needs-you queue and a daemon-shaped device socket; a new file on the machine is the agent's to make.
 */
import { afterEach, expect, test } from 'bun:test';
import * as v from 'valibot';
import { buildBuiltinTools, type JsonValue } from '@kinu.run/core';
import { present, toolExecute } from '@kinu.run/test-utils';
import { createTestUserDO, provisionTestWorkspace, testOwner, type DeviceFrame, type TestUserDO } from './helpers/user-do';
import { CAPABLE_HELLO } from './helpers/device-harness';
import { chatSessionTurns, hostedMainActor, orchestratorHarness } from './helpers/actor-harness';

// Dynamic: the helpers above install the agents-SDK mock at load, and `agents` imports workerd-only modules.
const { deriveUserId } = await import('../src/auth/store');

const DEVICE_HOME = '/home/dev';

const NOTES = `${DEVICE_HOME}/notes.md`;

/** The machine as the agent's plane mounts it. */
const PC = '/pc/ashish@studio';

const OWNERS = 'the owner\u2019s notes\n';

const RangeParamsSchema = v.tuple([v.string(), v.number(), v.number()]);

/** The machine's files, answered as the daemon does: a missing file is Node's ENOENT error frame. */
function daemon(files: Map<string, string>) {
  return (frame: DeviceFrame): JsonValue => {
    const path = v.parse(v.string(), frame.params[0] ?? '');
    const body = files.get(path);

    switch (frame.method) {
      case 'which': return { present: [] };
      case 'exists': return files.has(path);
      case 'statPath': return body === undefined ? null : { size: Buffer.byteLength(body), mtimeMs: 1, isDir: false };
      case 'readRange': {
        const [, offset, length] = v.parse(RangeParamsSchema, frame.params.slice(0, 3));

        if (body === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });

        return { encoding: 'base64', content: Buffer.from(body).subarray(offset, offset + length).toString('base64') };
      }

      case 'writeFile':
        files.set(path, v.parse(v.string(), frame.params[1] ?? ''));

        return { success: true };
      default: return { stdout: DEVICE_HOME, stderr: '', exitCode: 0 };
    }
  };
}

const opened: TestUserDO[] = [];

afterEach(async () => {
  for (const user of opened.splice(0)) {
    await user.joinFibers();
    user.close();
  }
});

/** The hosted main actor of a workspace whose owner's machine holds {@link NOTES}. */
async function workspaceWithMachine() {
  const machine = new Map([[NOTES, OWNERS]]);
  const ownerUserId = await deriveUserId('owner@kinu.example.com');
  const user = createTestUserDO({ deviceResponder: daemon(machine), durableObjectId: ownerUserId });
  opened.push(user);
  // The owner let this workspace use the machine: device consent is not what these tests are about.
  user.consentDecision = 'always';
  const { deviceId } = await user.userDO.registerDevice(await testOwner(), 'ashish@studio');
  user.attachDevice(deviceId);
  await user.sendDeviceHello({ ...CAPABLE_HELLO, root: DEVICE_HOME, home: DEVICE_HOME });
  const token = await provisionTestWorkspace(user, 'files', 'files');
  const workspace = orchestratorHarness(undefined, { userDO: user.userDO, workspace: 'files', ownerUserId });
  workspace.agent.harnessHoldsCapability(token);
  // A turn's start reads the device hub, which puts the machine in the mount table.
  await chatSessionTurns(workspace.agent).prepare({ messages: [{ role: 'user', content: 'list my files' }] });
  const main = await hostedMainActor(workspace);
  const runtime = main.actor.runtime;
  await present(runtime.deviceTransport, 'the device transport').refreshStatus();
  const file = toolExecute(present(buildBuiltinTools({ rt: runtime, workMode: 'build', conversations: main.actor.stores.conversationSearch }).file, 'the file tool'));
  const device = present(runtime.executionRouter?.getProvider('device'), 'the device executor').tools;

  const parked = async () => {
    const rows = await workspace.agent.listDeferredApprovals();

    return rows.map((row) => row.command);
  };

  const decide = async (answer: 'approved' | 'always') => {
    const ids = (await workspace.agent.listDeferredApprovals()).map((row) => row.id);

    return (await workspace.agent.decideDeferredApprovals(ids, answer)).decided;
  };

  const review = async () => {
    const [row] = await workspace.agent.listDeferredApprovals();

    return workspace.agent.reviewParkedWrite(present(row, 'a parked row').id);
  };

  return { machine, file, device, parked, decide, review, agent: workspace.agent };
}

const QUEUED = { code: 'unavailable', message: expect.stringContaining('queued for owner approval') };

const digest = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

test('a new file on the user\u2019s machine needs no approval', async () => {
  const { machine, file, device, parked } = await workspaceWithMachine();

  expect(await file({ op: 'write', path: `${PC}${DEVICE_HOME}/new.md`, content: 'from the file tool\n' })).toMatchObject({ action: 'created' });
  expect(await device.writeFile?.execute(`${DEVICE_HOME}/other.md`, 'from codemode\n')).toBe(`Written 14 bytes to ${DEVICE_HOME}/other.md`);

  expect(machine.get(`${DEVICE_HOME}/new.md`)).toBe('from the file tool\n');
  expect(machine.get(`${DEVICE_HOME}/other.md`)).toBe('from codemode\n');
  expect(await parked()).toEqual([]);
});

test('overwriting the user\u2019s file parks on its bytes, and approving writes exactly those bytes', async () => {
  const { machine, file, parked, decide } = await workspaceWithMachine();
  const replacement = 'the agent\u2019s rewrite\n';

  await file({ op: 'read', path: `${PC}${NOTES}` });
  await expect(file({ op: 'write', path: `${PC}${NOTES}`, content: replacement })).rejects.toMatchObject(QUEUED);

  expect(await parked()).toEqual([`file write ${PC}${NOTES} sha256:${digest(replacement)} over sha256:${digest(OWNERS)}`]);
  expect(machine.get(NOTES)).toBe(OWNERS);

  expect(await decide('approved')).toHaveLength(1);
  expect(machine.get(NOTES)).toBe(replacement);
  expect(await parked()).toEqual([]);
});

test('an approval of a file the owner changed since the ask writes nothing', async () => {
  const { machine, file, parked, decide } = await workspaceWithMachine();

  await file({ op: 'read', path: `${PC}${NOTES}` });
  await expect(file({ op: 'write', path: `${PC}${NOTES}`, content: 'stale rewrite\n' })).rejects.toMatchObject(QUEUED);
  machine.set(NOTES, 'the owner edited it meanwhile\n');

  expect(await decide('approved')).toHaveLength(1);
  expect(machine.get(NOTES)).toBe('the owner edited it meanwhile\n');
  expect(await parked()).toEqual([]);
});

test('"always" writes the parked bytes and lets the next overwrite run unasked', async () => {
  const { machine, file, parked, decide } = await workspaceWithMachine();

  await file({ op: 'read', path: `${PC}${NOTES}` });
  await expect(file({ op: 'write', path: `${PC}${NOTES}`, content: 'first\n' })).rejects.toMatchObject(QUEUED);
  await decide('always');
  expect(machine.get(NOTES)).toBe('first\n');

  await file({ op: 'read', path: `${PC}${NOTES}` });
  expect(await file({ op: 'write', path: `${PC}${NOTES}`, content: 'second\n' })).toMatchObject({ action: 'replaced' });
  expect(machine.get(NOTES)).toBe('second\n');
  expect(await parked()).toEqual([]);
});

test('codemode\u2019s device.writeFile over the user\u2019s file parks as the /pc write does', async () => {
  const { machine, device, parked, decide } = await workspaceWithMachine();

  expect(await device.writeFile?.execute(NOTES, 'from codemode\n')).toMatchObject({ error: expect.stringContaining('queued for owner approval') });
  expect(await parked()).toEqual([`file write ${PC}${NOTES} sha256:${digest('from codemode\n')} over sha256:${digest(OWNERS)}`]);
  expect(machine.get(NOTES)).toBe(OWNERS);

  await decide('approved');
  expect(machine.get(NOTES)).toBe('from codemode\n');
});

test('the owner sees a parked overwrite as the lines it changes, before approving it', async () => {
  const { file, review } = await workspaceWithMachine();

  await file({ op: 'read', path: `${PC}${NOTES}` });
  await expect(file({ op: 'write', path: `${PC}${NOTES}`, content: 'the agent\u2019s rewrite\n' })).rejects.toMatchObject(QUEUED);

  expect(await review()).toMatchObject({
    path: `${PC}${NOTES}`, currentBytes: Buffer.byteLength(OWNERS), changedSinceAsked: false,
    diff: { status: 'changed', added: 1, removed: 1 },
  });
  expect(present(await review(), 'the review').diff.lines.filter((line) => line.kind === 'add' || line.kind === 'del')).toEqual([
    { kind: 'del', text: 'the owner\u2019s notes' }, { kind: 'add', text: 'the agent\u2019s rewrite' },
  ]);
});

test('a review says when the file changed since the ask, and a binary rewrite shows sizes, not lines', async () => {
  const { machine, file, review } = await workspaceWithMachine();
  const binary = 'PK\u0000\u0003 packed';

  await file({ op: 'read', path: `${PC}${NOTES}` });
  await expect(file({ op: 'write', path: `${PC}${NOTES}`, content: binary })).rejects.toMatchObject(QUEUED);
  machine.set(NOTES, 'the owner edited it meanwhile\n');

  expect(await review()).toMatchObject({
    changedSinceAsked: true, nextBytes: Buffer.byteLength(binary), diff: { omitted: 'binary', lines: [] },
  });
});

test('an id that names no parked write is refused as missing, not answered as nothing', async () => {
  const { agent } = await workspaceWithMachine();

  expect(agent.reviewParkedWrite('defer-none')).rejects.toThrow('no longer waiting');
});
