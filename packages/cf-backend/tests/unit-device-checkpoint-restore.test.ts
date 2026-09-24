/**
 * Reverting a turn restores the device files it changed, and the checkpoint store says apart "this turn
 * changed nothing" and "no history here". The hub's checkpoint client (`deviceFileCheckpoints`) drives
 * the real daemon (`packages/pc-agent/src/index.js`) with the frames the hub sends.
 */
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  CHECKPOINTS_UNAVAILABLE_NO_GIT, deviceFileCheckpoints, fileCheckpointListing, JsonValueSchema,
  type JsonValue, type UserCaller,
} from '@kinu.run/core';

const require_ = createRequire(import.meta.url);

const pcAgent = v.parse(
  v.object({ handle: v.function(), createCheckpoints: v.function() }),
  require_(join(import.meta.dir, '../../pc-agent/src/index.js')),
);

const WORKSPACE = 'workspace-a';

const CALLER: UserCaller = { workspaceToken: 'workspace-a-token' };

const ReplySchema = v.object({ id: v.string(), result: v.optional(JsonValueSchema), error: v.optional(v.string()) });

/** One machine: the daemon with its own checkpoint store, reached as the hub reaches it. */
function machine(gitBin?: string) {
  const ctx = { checkpoints: pcAgent.createCheckpoints({ base: join(scratchDir('device-checkpoint-store'), 'store'), gitBin }) };
  let next = 0;

  const send = (frame: Record<string, JsonValue>) => new Promise<JsonValue | undefined>((resolve, reject) => {
    const id = `rpc-ckptrevert-${String(next += 1)}`;

    pcAgent.handle({ id, ...frame, sandbox: { tier: 'raw', agentHome: '', roots: [] } }, {
      readyState: 1,
      send(data: string) {
        const reply = v.parse(ReplySchema, JSON.parse(data));

        if (reply.error !== undefined) reject(new Error(reply.error));
        else resolve(reply.result);
      },
    }, ctx);
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
