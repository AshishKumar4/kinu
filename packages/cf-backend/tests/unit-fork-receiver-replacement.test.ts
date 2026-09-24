/**
 * A replacement transfer through the fork receiver's activation cache: the cached receiver must follow a fresh transferId,
 * or bytes land in the predecessor's `.fork-T1.tmp` while the staging row says T2 and every resume fails.
 */
import { describe, expect, test } from 'bun:test';
import {
  FORK_STREAM_SEED, FORK_TRANSFER_VERSION, foldForkStream, sealForkFrame,
  type ForkFrame,
} from '@kinu.run/core';
import { orchestratorHarness, reactivateOrchestratorHarness, workspaceFiles } from './helpers/actor-harness';

const OWNER = 'harness-owner';

const FORK = 'forked-replacement';

const CONTENT = new TextEncoder().encode('replacement transfer bytes!');

const DIGEST = new Bun.CryptoHasher('sha256').update(CONTENT).digest('hex');

function begin(transferId: string): ForkFrame {
  return sealForkFrame({
    version: FORK_TRANSFER_VERSION, transferId, seq: 0, kind: 'begin',
    head: { source: { workspaceId: 'S', workspaceName: 'source' }, cut: { messageId: 'm1', createdAtMs: 1 } },
    counts: {
      agentConfig: 0, craftedTools: 0, memoryChunks: 0,
      sessionMessages: 0, conversationEntries: 1, conversationEntryParts: 0, contextMembers: 0,
      files: 1,
    },
  });
}

/** The cut entry the head names: a transfer carries it, and publication refuses one that does not. */
function cut(transferId: string, seq: number): ForkFrame {
  return sealForkFrame({
    version: FORK_TRANSFER_VERSION, transferId, seq, kind: 'conversationEntries',
    rows: [{ id: 'm1', parent_id: null, role: 'user', turn_id: null, run_id: null, metadata_json: null, metadata_path: null, metadata_digest: null, recorded_at: 1 }],
  });
}

interface RangeFrame {
  readonly transferId: string;
  readonly seq: number;
  readonly offset: number;
  readonly end: number;
  readonly last: boolean;
}

function range({ transferId, seq, offset, end, last }: RangeFrame): ForkFrame {
  return sealForkFrame({
    version: FORK_TRANSFER_VERSION, transferId, seq, kind: 'file',
    path: 'memory/replaced.md', offset, bytes: CONTENT.subarray(offset, end), last,
    artifact: false, fileDigest: last ? DIGEST : undefined,
  });
}

describe('a replacement transfer stages under its OWN suffix', () => {
  test('T2 replaces T1 mid-activation, survives the reset, and publishes', async () => {
    // The harness is the fork target: publication fences actor handles on `this.name === forkName`, so a
    // differently named harness is not this receiver.
    const first = orchestratorHarness(undefined, { workspace: FORK });

    expect((await first.agent.rawCopyFromFork(FORK, begin('tx-one'), OWNER)).ok).toBe(true);
    expect((await first.agent.rawCopyFromFork(FORK, cut('tx-one', 1), OWNER)).ok).toBe(true);
    expect((await first.agent.rawCopyFromFork(FORK, range({ transferId: 'tx-one', seq: 2, offset: 0, end: 10, last: false }), OWNER)).ok).toBe(true);

    // A fresh transfer id through the same activation; the receiver must follow the reset staging row.
    const beginTwo = begin('tx-two');
    const cutTwo = cut('tx-two', 1);
    const rangeTwo = range({ transferId: 'tx-two', seq: 2, offset: 0, end: 10, last: false });
    expect((await first.agent.rawCopyFromFork(FORK, beginTwo, OWNER)).ok).toBe(true);
    expect((await first.agent.rawCopyFromFork(FORK, cutTwo, OWNER)).ok).toBe(true);
    expect((await first.agent.rawCopyFromFork(FORK, rangeTwo, OWNER)).ok).toBe(true);

    const second = await reactivateOrchestratorHarness(first.db, undefined, {
      world: { workspace: FORK },
    });

    const rangeEnd = range({ transferId: 'tx-two', seq: 3, offset: 10, end: CONTENT.byteLength, last: true });
    expect((await second.agent.rawCopyFromFork(FORK, rangeEnd, OWNER)).ok).toBe(true);

    const stream = [beginTwo, cutTwo, rangeTwo, rangeEnd]
      .reduce((held, frame) => foldForkStream(held, frame.digest), FORK_STREAM_SEED);

    const commit = sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-two', seq: 4, kind: 'commit', stream,
    });

    const outcome = await second.agent.rawCopyFromFork(FORK, commit, OWNER);

    if (!outcome.ok) throw new Error(`commit refused: ${outcome.reason}`);
    expect(outcome.status).toBe('published');

    const landed = await workspaceFiles(second.agent)
      .readFile('memory/replaced.md', { encoding: 'utf8' });

    expect(landed).toBe('replacement transfer bytes!');
  });
});
