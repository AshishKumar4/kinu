/**
 * A replacement transfer through the fork receiver's activation cache: the cached receiver must follow a fresh
 * transferId, the replacement's begin must take away what the first one imported, and a reset between a frame of
 * chunks and its page must be survived (the page wants them again).
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import {
  FORK_STREAM_SEED, FORK_TRANSFER_VERSION, foldForkStream, sealForkFrame,
  type ForkFrame, type UnsealedForkFrame,
} from '@kinu.run/core';
import { inlineWorkspaceStorage } from '@kinu.run/core/identity';
import type { ForkFrameAck } from '../src/user/workspace-fork';
import { orchestratorHarness, reactivateOrchestratorHarness, workspaceFiles } from './helpers/actor-harness';

const OWNER = 'harness-owner';

const FORK = 'forked-replacement';

type FrameBody = UnsealedForkFrame extends infer Frame
  ? Frame extends { version: number; transferId: string; seq: number }
    ? Omit<Frame, 'version' | 'transferId' | 'seq'>
    : never
  : never;

/** A source store holding `memory/replaced.md`, exported from a pin as a fork's source exports it. */
async function exported(content: string) {
  const store = (await NimbusWorkspace.create({ ...inlineWorkspaceStorage(new Database(':memory:')), generation: 1 })).vfs;
  const kernel = store.as(CRED_KERNEL);
  kernel.mkdir('/home/main/memory', { recursive: true });
  kernel.chown('/home/main', 1000, 1000);
  kernel.chown('/home/main/memory', 1000, 1000);
  store.as(CRED_SESSION_USER).writeFile('/home/main/memory/replaced.md', content);
  store.snapshot('pin');
  const page = store.exportPage({ at: 'pin', root: '/home/main/memory' });

  return { page, chunks: store.exportChunks(page.rows.flatMap((row) => row.pieces.map(([hash]) => hash))).chunks };
}

/** Frames sealed as they are sent: the sequence and the rolling digest move only past a frame the target took. */
function transferTo(to: (frame: ForkFrame) => Promise<ForkFrameAck>, transferId: string) {
  let seq = 0;
  let stream = FORK_STREAM_SEED;
  let send = to;

  return {
    async frame(body: FrameBody): Promise<ForkFrameAck> {
      const frame = sealForkFrame({ version: FORK_TRANSFER_VERSION, transferId, seq, ...body });
      const ack = await send(frame);

      if (!ack.ok) throw new Error(`refused: ${ack.reason}`);

      if (ack.status !== 'want') {
        seq += 1;
        stream = foldForkStream(stream, frame.digest);
      }

      return ack;
    },
    commit: (): FrameBody => ({ kind: 'commit', stream }),
    retarget(next: (frame: ForkFrame) => Promise<ForkFrameAck>) { send = next; },
  };
}

const HEAD = { source: { workspaceId: 'S', workspaceName: 'source' }, cut: { messageId: 'm1', createdAtMs: 1 } };

const CUT: FrameBody = {
  kind: 'conversationEntries',
  rows: [{ id: 'm1', position: 0, role: 'user', turn_id: null, run_id: null, metadata_json: null, metadata_path: null, metadata_digest: null, recorded_at: 1 }],
};

const COUNTS = {
  agentConfig: 0, craftedTools: 0, memoryChunks: 0,
  sessionMessages: 0, conversationEntries: 1, conversationEntryParts: 0, contextMembers: 0,
  files: 1,
};

describe('a replacement transfer', () => {
  test('replaces the first mid-activation, survives a reset between its chunks and its page, and publishes', async () => {
    // The harness is the fork target: publication fences actor handles on `this.name === forkName`, so a
    // differently named harness is not this receiver.
    const first = orchestratorHarness(undefined, { workspace: FORK });
    const toFirst = (frame: ForkFrame) => first.agent.rawCopyFromFork(FORK, frame, OWNER);
    const memory = { in: 'home', name: 'memory' } as const;

    const one = await exported('the first transfer\'s bytes');
    const tx1 = transferTo(toFirst, 'tx-one');
    await tx1.frame({ kind: 'begin', head: HEAD, counts: COUNTS });
    await tx1.frame(CUT);
    expect(await tx1.frame({ kind: 'page', target: memory, page: one.page })).toMatchObject({ status: 'want' });
    await tx1.frame({ kind: 'chunks', target: memory, chunks: one.chunks });
    expect(await tx1.frame({ kind: 'page', target: memory, page: one.page })).toEqual({ ok: true, status: 'staged' });
    expect(await workspaceFiles(first.agent).readFile('memory/replaced.md', { encoding: 'utf8' })).toBe('the first transfer\'s bytes');

    // A fresh transfer id through the same activation; the receiver must follow the reset staging row.
    const two = await exported('replacement transfer bytes!');
    const tx2 = transferTo(toFirst, 'tx-two');
    await tx2.frame({ kind: 'begin', head: HEAD, counts: COUNTS });
    expect(await workspaceFiles(first.agent).exists('memory/replaced.md')).toBe(false);
    await tx2.frame(CUT);
    expect(await tx2.frame({ kind: 'page', target: memory, page: two.page })).toMatchObject({ status: 'want' });
    await tx2.frame({ kind: 'chunks', target: memory, chunks: two.chunks });

    // A Durable Object reset between the chunks and their page: staged chunks may be collected.
    const second = await reactivateOrchestratorHarness(first.db, undefined, { world: { workspace: FORK } });
    tx2.retarget((frame) => second.agent.rawCopyFromFork(FORK, frame, OWNER));
    const page = await tx2.frame({ kind: 'page', target: memory, page: two.page });

    if (page.ok && page.status === 'want') {
      await tx2.frame({ kind: 'chunks', target: memory, chunks: two.chunks });
      expect(await tx2.frame({ kind: 'page', target: memory, page: two.page })).toEqual({ ok: true, status: 'staged' });
    }

    const outcome = await tx2.frame(tx2.commit());

    expect(outcome).toMatchObject({ ok: true, status: 'published' });
    expect(await workspaceFiles(second.agent).readFile('memory/replaced.md', { encoding: 'utf8' })).toBe('replacement transfer bytes!');
  });
});
