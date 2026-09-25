/**
 * Reverting a turn restores the device files it changed, and the checkpoint store says apart "this turn
 * changed nothing" and "no history here". The hub's checkpoint client (`deviceFileCheckpoints`) drives
 * the real daemon (`packages/pc-agent/src/index.js`) with the frames the hub sends.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECKPOINTS_UNAVAILABLE_NO_GIT, deviceFileCheckpoints, fileCheckpointListing,
  type JsonValue, type UserCaller,
} from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { pcAgentDaemon } from './helpers/pc-agent-daemon';

const WORKSPACE = 'workspace-a';

const CALLER: UserCaller = { workspaceToken: 'workspace-a-token' };

/** One machine: the daemon with its own checkpoint store, reached as the hub reaches it. */
function machine(gitBin?: string) {
  const daemon = pcAgentDaemon({ gitBin });
  let next = 0;

  const send = (frame: { method: string; params: JsonValue[]; checkpoint?: JsonValue }) => daemon.answer({
    id: `rpc-ckptrevert-${String(next += 1)}`, ...frame, sandbox: { tier: 'raw', agentHome: '', roots: [] },
  });

  const checkpoints = deviceFileCheckpoints({
    hub: async () => ({
      stub: { deviceRpc: async (_caller, method, params) => JSON.stringify(await send({ method, params }) ?? null) },
      caller: CALLER,
    }),
    hasOwner: () => true,
    workspace: WORKSPACE,
  });

  return { send, checkpoints };
}

describe('reverting a turn restores what it changed on the device', () => {
  test('the files a turn wrote come back as they were before it', async () => {
    const project = scratchDir('device-revert-project');
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'notes.txt'), 'before the turn');
    const { send, checkpoints } = machine();
    const turn = { agent: WORKSPACE, turnId: 'turn-1', sessionId: 'session-1', dir: null };

    // The hub hints every mutating frame of a turn; the daemon snapshots before the first.
    await send({ method: 'writeFile', params: [join(project, 'notes.txt'), 'rewritten by the turn'], checkpoint: turn });
    await send({ method: 'writeFile', params: [join(project, 'created.txt'), 'new in the turn'], checkpoint: turn });

    const [taken, ...others] = await checkpoints.list({ turnId: 'turn-1' });
    expect(others).toEqual([]);
    const plan = await checkpoints.plan(taken.dir, taken.id);
    expect([...plan.files].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { path: 'created.txt', kind: 'delete' }, { path: 'notes.txt', kind: 'modify' },
    ]);

    await checkpoints.restore(taken.dir, taken.id);

    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('before the turn');
    expect(existsSync(join(project, 'created.txt'))).toBe(false);
  });
});

describe('the checkpoint store answers "changed nothing" and "no history" differently', () => {
  test('a turn that wrote nothing is an empty answer from a store that answers', async () => {
    const { checkpoints } = machine();

    expect(await fileCheckpointListing(checkpoints, { turnId: 'turn-quiet' }))
      .toEqual({ availability: { available: true }, entries: [] });
  });

  test('a machine without git has no store, and says why instead of answering empty', async () => {
    const { checkpoints } = machine(join(scratchDir('device-no-git'), 'git'));

    expect(await fileCheckpointListing(checkpoints, { turnId: 'turn-quiet' }))
      .toEqual({ availability: { available: false, reason: CHECKPOINTS_UNAVAILABLE_NO_GIT }, entries: [] });
  });
});
