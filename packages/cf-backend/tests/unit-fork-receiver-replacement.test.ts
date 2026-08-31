/**
 * A REPLACEMENT transfer through the fork receiver's activation cache.
 *
 * The receiver is cached per activation, and it used to be built from the
 * FIRST frame's transferId for as long as the activation lived: a failed fork
 * retried under a fresh transferId streamed through a receiver whose sink
 * still carried the predecessor's temp suffix. The durable staging row said
 * T2, the bytes sat in `.fork-T1.tmp`, and the next activation — building its
 * sink honestly from T2 — resumed into a temp that never existed. Every retry
 * failed identically; the fork was destroyed as unresumable.
 *
 * This drives that exact interleaving: T1 begins and stages, T2 replaces it
 * mid-file, the activation dies, and the resumed activation finishes T2.
 */
import { describe, expect, test } from 'bun:test';
import {
  FORK_STREAM_SEED, FORK_TRANSFER_VERSION, foldForkStream, sealForkFrame,
  type ForkFrame,
} from '@kinu.run/core';
import { orchestratorHarness, reactivateOrchestratorHarness } from './helpers/actor-harness';

const OWNER = 'harness-owner';
const FORK = 'forked-replacement';

const CONTENT = new TextEncoder().encode('replacement transfer bytes!');
const DIGEST = new Bun.CryptoHasher('sha256').update(CONTENT).digest('hex');

function begin(transferId: string): ForkFrame {
  return sealForkFrame({
    version: FORK_TRANSFER_VERSION, transferId, seq: 0, kind: 'begin',
    head: { source: { workspaceId: 'S', workspaceName: 'source' }, cut: { messageId: 'm1', createdAtMs: 1 } },
    targetAuthority: 'plain',
    counts: { agentConfig: 0, craftedTools: 0, memoryChunks: 0, assistantMessages: 0, messages: 0, files: 1 },
  });
}

function range(transferId: string, seq: number, offset: number, end: number, last: boolean): ForkFrame {
  let body: Parameters<typeof sealForkFrame>[0] = {
    version: FORK_TRANSFER_VERSION, transferId, seq, kind: 'file',
    path: 'memory/replaced.md', offset, bytes: CONTENT.subarray(offset, end), last,
  };
  if (last) body = { ...body, fileDigest: DIGEST };
  return sealForkFrame(body);
}

describe('a replacement transfer stages under its OWN suffix', () => {
  test('T2 replaces T1 mid-activation, survives the reset, and publishes', async () => {
    const first = orchestratorHarness();

    // T1 begins and stages half a file, then its source gives up.
    expect((await first.agent.rawCopyFromFork(FORK, begin('tx-one'), OWNER)).ok).toBe(true);
    expect((await first.agent.rawCopyFromFork(FORK, range('tx-one', 1, 0, 10, false), OWNER)).ok).toBe(true);

    // The retry: a FRESH transfer id through the SAME activation. The begin
    // resets the durable staging row to tx-two; the receiver must follow it.
    const beginTwo = begin('tx-two');
    const rangeTwo = range('tx-two', 1, 0, 10, false);
    expect((await first.agent.rawCopyFromFork(FORK, beginTwo, OWNER)).ok).toBe(true);
    expect((await first.agent.rawCopyFromFork(FORK, rangeTwo, OWNER)).ok).toBe(true);

    // The eviction: same durable rows, fresh activation, no cached receiver.
    const second = await reactivateOrchestratorHarness(first.db);
    const rangeEnd = range('tx-two', 2, 10, CONTENT.byteLength, true);
    expect((await second.agent.rawCopyFromFork(FORK, rangeEnd, OWNER)).ok).toBe(true);

    const stream = [beginTwo, rangeTwo, rangeEnd]
      .reduce((held, frame) => foldForkStream(held, frame.digest), FORK_STREAM_SEED);
    const commit = sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-two', seq: 3, kind: 'commit', stream,
    });
    const outcome = await second.agent.rawCopyFromFork(FORK, commit, OWNER);
    if (!outcome.ok) throw new Error(`commit refused: ${outcome.reason}`);
    expect(outcome.status).toBe('published');

    const landed = await second.agent.observeRuntime().storage.vfs
      .readFile('memory/replaced.md', { encoding: 'utf8' });
    expect(landed).toBe('replacement transfer bytes!');
  });
});
