/**
 * The fork transfer protocol, driven over its receiver.
 *
 * The frames here are hand-built rather than taken from the source streamer, on
 * purpose: this file's subject is what a RECEIVER does with a stream, including
 * streams a correct sender would never produce. The streamer has its own
 * equivalence tests.
 *
 * The central property is that nothing partial is ever visible. A workspace mid
 * transfer holds staged rows and staged files, and is still not a fork: no
 * lineage, no marker, no mission, no display name. Every refusal case below
 * asserts that as well as asserting the refusal, because a refusal that left a
 * half-fork behind would pass a test that only checked the throw.
 */

import { describe, test, expect } from 'bun:test';
import {
  snapshotWorkspaceForFork, writeForkSnapshot, readForkLineage, writeSoul, summarizeSoul, SOUL_PATH,
  ForkTargetWriter, ForkTransferReceiver, NativeSinkPlan, forkTransferFrames, sealForkFrame,
  FORK_TRANSFER_VERSION, FORK_ROW_SECTIONS, FORK_STREAM_SEED, FORK_FRAME_BYTES, foldForkStream,
  type ForkFileSink, type ForkNativeFilePort,
  type ForkFileSource,
  type ForkSnapshot, type ForkFrame, type ForkWriteTarget, type UnsealedForkFrame,
} from '../src/index';
import { createTestWorkspace as fresh, type TestWorkspace } from './helpers';

const OWNER: ForkWriteTarget = { workspaceId: 'FORK-ID', workspaceName: 'my-fork', now: 4242 };

/** The one big-file fixture both 256 MiB arms stream, and the digest of the
 *  bytes its generator produces. Never materialized: the digest is folded a
 *  frame at a time, exactly as the sender folds it. */
const HUGE_PATH = 'memory/huge.bin';
const HUGE_SIZE = 256 * 1024 * 1024;
const HUGE_FRAME = 1024 * 1024;

/** The 256 MiB file's bytes, by position rather than from storage — the fixture
 *  that carries it must not hold it either. */
function hugeForkBytes(offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at += 1) out[at] = (offset + at) % 251;
  return out;
}

function hugeForkDigest(): string {
  const hash = new Bun.CryptoHasher('sha256');
  for (let offset = 0; offset < HUGE_SIZE; offset += HUGE_FRAME) {
    hash.update(hugeForkBytes(offset, HUGE_FRAME));
  }
  return hash.digest('hex');
}

type FrameBody = UnsealedForkFrame extends infer Frame
  ? Frame extends { version: number; transferId: string; seq: number }
    ? Omit<Frame, 'version' | 'transferId' | 'seq'>
    : never
  : never;

async function source(opts: { files?: Array<{ path: string; content: string }> } = {}) {
  const src = fresh();
  void src.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'SRC'}, ${'origin'}, ${100})`;
  await writeSoul(src.vfs, src.sql, 'help with testing');
  const chain = [
    { id: 'm1', parent: null, role: 'user', text: 'first' },
    { id: 'm2', parent: 'm1', role: 'assistant', text: 'second' },
    { id: 'm3', parent: 'm2', role: 'user', text: 'third' },
  ] as const;
  for (const [i, m] of chain.entries()) {
    void src.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${m.id}, ${'default'}, ${m.parent}, ${m.role}, ${m.text}, ${1000 + i})`;
  }
  void src.sql`INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at)
    VALUES (${'helper'}, ${'utility'}, ${null}, ${'async (x) => x'}, ${'local'}, ${500}, ${500})`;
  void src.sql`INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
    VALUES (${'c1'}, ${'memory/MEMORY.md'}, ${1}, ${2}, ${'h'}, ${'key insight'}, ${700})`;
  void src.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'model'}, ${'m'})`;
  await src.vfs.mkdir('memory', { recursive: true });
  await src.vfs.writeFile('memory/MEMORY.md', 'key insight');
  for (const f of opts.files ?? []) await src.vfs.writeFile(f.path, f.content);
  return src;
}

/**
 * Hand-build the frame stream for a snapshot, at a chosen payload budget.
 *
 * Row batches are cut by row COUNT here rather than by measured bytes — this
 * file is testing the receiver, and a fixed cut is what makes "drop frame 4"
 * and "reorder two sections" expressible. The source streamer is what owes a
 * byte-measured cut.
 */
function framesFor(snapshot: ForkSnapshot, opts: {
  transferId?: string; rowsPerFrame?: number; fileBytes?: number;
} = {}): ForkFrame[] {
  const transferId = opts.transferId ?? 'tx-1';
  const rowsPerFrame = opts.rowsPerFrame ?? 2;
  const fileBytes = opts.fileBytes ?? 8;
  const out: ForkFrame[] = [];
  let seq = 0;
  let stream = FORK_STREAM_SEED;
  const push = (body: FrameBody): void => {
    const frame = sealForkFrame({ version: FORK_TRANSFER_VERSION, transferId, seq, ...body });
    out.push(frame);
    seq += 1;
    stream = foldForkStream(stream, frame.digest);
  };

  push({
    kind: 'begin',
    head: { source: snapshot.source, cut: snapshot.cut },
    targetAuthority: 'plain',
    counts: {
      agentConfig: snapshot.agentConfig.length,
      craftedTools: snapshot.craftedTools.length,
      memoryChunks: snapshot.memoryChunks.length,
      assistantMessages: snapshot.assistantMessages.length,
      messages: snapshot.messages.length,
      files: snapshot.files.length,
    },
  });
  for (const section of FORK_ROW_SECTIONS) {
    if (section === 'agentConfig') {
      for (let at = 0; at < snapshot.agentConfig.length; at += rowsPerFrame) {
        push({ kind: section, rows: snapshot.agentConfig.slice(at, at + rowsPerFrame) });
      }
    } else if (section === 'craftedTools') {
      for (let at = 0; at < snapshot.craftedTools.length; at += rowsPerFrame) {
        push({ kind: section, rows: snapshot.craftedTools.slice(at, at + rowsPerFrame) });
      }
    } else if (section === 'memoryChunks') {
      for (let at = 0; at < snapshot.memoryChunks.length; at += rowsPerFrame) {
        push({ kind: section, rows: snapshot.memoryChunks.slice(at, at + rowsPerFrame) });
      }
    } else if (section === 'assistantMessages') {
      for (let at = 0; at < snapshot.assistantMessages.length; at += rowsPerFrame) {
        push({ kind: section, rows: snapshot.assistantMessages.slice(at, at + rowsPerFrame) });
      }
    } else {
      for (let at = 0; at < snapshot.messages.length; at += rowsPerFrame) {
        push({ kind: section, rows: snapshot.messages.slice(at, at + rowsPerFrame) });
      }
    }
  }
  const encoder = new TextEncoder();
  for (const file of snapshot.files) {
    const bytes = encoder.encode(file.content);
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (bytes.byteLength === 0) {
      push({ kind: 'file', path: file.path, offset: 0, bytes, last: true, fileDigest: digest });
      continue;
    }
    for (let at = 0; at < bytes.byteLength; at += fileBytes) {
      const last = at + fileBytes >= bytes.byteLength;
      push({
        kind: 'file', path: file.path, offset: at,
        bytes: bytes.slice(at, at + fileBytes), last,
        fileDigest: last ? digest : undefined,
      });
    }
  }
  push({ kind: 'commit', stream });
  return out;
}

function receiverFor(tgt: TestWorkspace, opts: Partial<ForkWriteTarget> = {}) {
  const writer = new ForkTargetWriter(tgt.sql, tgt.vfs, { ...OWNER, targetAuthority: 'plain', ...opts });
  const ranges = new Map<string, Uint8Array[]>();
  const sink: ForkFileSink = {
    async beginFile(path, staged) {
      // A fixture with no persistence cannot adopt a staging it never kept, and
      // nothing here evicts, so an adopting call would be a defect in the test.
      if (staged !== 0) throw new Error(`test sink cannot adopt ${staged} staged bytes of ${path}`);
      ranges.set(path, []);
    },
    async writeRange(path, _offset, bytes) { ranges.get(path)?.push(bytes.slice()); },
    async stagedDigest(path, bytes) {
      const parts = ranges.get(path) ?? [];
      const size = parts.reduce((n, part) => n + part.byteLength, 0);
      if (size !== bytes) throw new Error(`test sink staged ${size} bytes of ${path}, not ${bytes}`);
      const hash = new Bun.CryptoHasher('sha256');
      for (const part of parts) hash.update(part);
      return hash.digest('hex');
    },
    async commitFile(path) {
      const parts = ranges.get(path) ?? [];
      const size = parts.reduce((n, part) => n + part.byteLength, 0);
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
      const content = new TextDecoder().decode(bytes);
      await tgt.vfs.writeFile(path, content);
      ranges.delete(path);
      return path === SOUL_PATH ? { mission: summarizeSoul(content) } : {};
    },
    async abortFile(path) { ranges.delete(path); },
  };
  return new ForkTransferReceiver(writer, sink);
}

/** Everything that only exists once a transfer has published. A workspace that
 *  answers "no" to all of these is staged, not forked. */
function isFork(tgt: TestWorkspace): boolean {
  const lineage = readForkLineage(tgt.sql);
  const named = tgt.sql<{ value: string }>`
    SELECT value FROM agent_config WHERE key = 'display_name'`[0]?.value;
  return lineage !== null || named === OWNER.workspaceName;
}

async function drain(receiver: ForkTransferReceiver, frames: readonly ForkFrame[]) {
  const outcomes = [];
  for (const frame of frames) outcomes.push(await receiver.accept(frame));
  return outcomes;
}

describe('fork transfer receiver', () => {
  test('a streamed transfer lands exactly what the in-process write lands', async () => {
    const src = await source();
    const streamed = fresh();
    const direct = fresh();
    const snapshot = await snapshotWorkspaceForFork(src.sql, src.vfs, 'm2');

    const outcomes = await drain(receiverFor(streamed), framesFor(snapshot));
    const final = outcomes[outcomes.length - 1]!;
    if (final.status !== 'published') throw new Error(`expected published, got ${final.status}`);
    // Only the commit publishes. Everything before it staged.
    expect(outcomes.slice(0, -1).every((o) => o.status === 'staged')).toBe(true);

    await writeForkSnapshot(direct.sql, direct.vfs, snapshot, { ...OWNER, targetAuthority: 'plain' });

    const rowsOf = (ws: TestWorkspace) => ({
      messages: ws.sql<{ id: string; parent_id: string | null; content: string }>`
        SELECT id, parent_id, content FROM messages ORDER BY created_at, id`,
      tools: ws.sql<{ name: string }>`SELECT name FROM crafted_tools ORDER BY name`,
      chunks: ws.sql<{ id: string; text: string }>`SELECT id, text FROM memory_chunks ORDER BY id`,
      config: ws.sql<{ key: string; value: string }>`SELECT key, value FROM agent_config ORDER BY key`,
      lineage: readForkLineage(ws.sql),
    });
    expect(rowsOf(streamed)).toEqual(rowsOf(direct));
    expect(await streamed.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' })).toBe('key insight');
    // m3 is past the cut and must not have crossed.
    expect(rowsOf(streamed).messages.map((r) => r.id)).not.toContain('m3');
  });

  test('a target mid-transfer holds staged rows and is still not a fork', async () => {
    const src = await source();
    const tgt = fresh();
    const snapshot = await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3');
    const frames = framesFor(snapshot);

    await drain(receiverFor(tgt), frames.slice(0, -1));

    // The rows ARE there — this is staging, not buffering.
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM messages`[0]!.c).toBe(3);
    expect(await tgt.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' })).toBe('key insight');
    // And none of it is a fork.
    expect(isFork(tgt)).toBe(false);
    expect(readForkLineage(tgt.sql)).toBeNull();
  });

  test('a gap is refused and leaves no fork', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3'));
    const receiver = receiverFor(tgt);
    await receiver.accept(frames[0]!);
    await expect(receiver.accept(frames[2]!)).rejects.toThrow(/frame 2 arrived where frame 1 was expected/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a frame delivered twice is refused rather than silently re-staged', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3'));
    const receiver = receiverFor(tgt);
    await receiver.accept(frames[0]!);
    await receiver.accept(frames[1]!);
    await expect(receiver.accept(frames[1]!)).rejects.toThrow(/arrived where frame 2 was expected/);
    expect(isFork(tgt)).toBe(false);
  });

  test('sections out of the order the protocol fixes are refused', async () => {
    const src = await source();
    const tgt = fresh();
    const snapshot = await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3');
    // messages before agentConfig: the elision contract depends on the pane
    // section preceding the plain one, so the order is enforced, not advisory.
    const begin = framesFor(snapshot)[0]!;
    const receiver = receiverFor(tgt);
    await receiver.accept(begin);
    const messagesFirst = sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-1', seq: 1,
      kind: 'messages', rows: snapshot.messages,
    });
    await receiver.accept(messagesFirst);
    const configAfter = sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-1', seq: 2,
      kind: 'agentConfig', rows: snapshot.agentConfig,
    });
    await expect(receiver.accept(configAfter)).rejects.toThrow(/out of the order the protocol fixes/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a foreign transfer id mid-stream is refused', async () => {
    const src = await source();
    const tgt = fresh();
    const snapshot = await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3');
    const mine = framesFor(snapshot, { transferId: 'tx-mine' });
    const theirs = framesFor(snapshot, { transferId: 'tx-theirs' });
    const receiver = receiverFor(tgt);
    await receiver.accept(mine[0]!);
    await expect(receiver.accept(theirs[1]!))
      .rejects.toThrow(/belongs to transfer tx-theirs, and tx-mine is the transfer open here/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a reset clears files the abandoned transfer staged before taking replacement files', async () => {
    const firstSource = await source({ files: [{ path: 'memory/abandoned.md', content: 'old bytes' }] });
    const secondSource = await source({ files: [{ path: 'memory/replacement.md', content: 'new bytes' }] });
    const tgt = fresh();
    const first = framesFor(await snapshotWorkspaceForFork(firstSource.sql, firstSource.vfs, 'm3'), {
      transferId: 'tx-first', fileBytes: 3,
    });
    const second = framesFor(await snapshotWorkspaceForFork(secondSource.sql, secondSource.vfs, 'm1'), {
      transferId: 'tx-second', fileBytes: 3,
    });
    const receiver = receiverFor(tgt);
    const lastFirstFile = first.findIndex((frame) => frame.kind === 'file' && frame.path === 'memory/abandoned.md' && frame.last);
    await drain(receiver, first.slice(0, lastFirstFile + 1));
    expect(await tgt.vfs.readFile('memory/abandoned.md', { encoding: 'utf8' })).toBe('old bytes');

    // Frame 0 is the reset. It clears every exact unpublished path before the
    // replacement starts, so a failed first transfer cannot donate a file to the
    // fork that eventually wins this reserved target.
    await drain(receiver, second);
    expect(await tgt.vfs.exists('memory/abandoned.md')).toBe(false);
    expect(await tgt.vfs.readFile('memory/replacement.md', { encoding: 'utf8' })).toBe('new bytes');
    expect(readForkLineage(tgt.sql)!.sourceMessageId).toBe('m1');
  });

  test('a concurrent transfer takes the target and the abandoned one is refused', async () => {
    const src = await source();
    const tgt = fresh();
    const first = await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3');
    const second = await snapshotWorkspaceForFork(src.sql, src.vfs, 'm1');
    const a = framesFor(first, { transferId: 'tx-a' });
    const b = framesFor(second, { transferId: 'tx-b' });
    const receiver = receiverFor(tgt);

    await drain(receiver, a.slice(0, 3));
    // A second source opens its own transfer into the same target. Its begin
    // clears whatever the abandoned one staged.
    const outcomes = await drain(receiver, b);
    expect(outcomes[outcomes.length - 1]!.status).toBe('published');
    await expect(receiver.accept(a[3]!)).rejects.toThrow(/belongs to transfer tx-a/);

    // The winner's cut, whole, with none of the loser's rows.
    const landed = tgt.sql<{ id: string }>`SELECT id FROM messages WHERE role != 'system' ORDER BY created_at`;
    expect(landed.map((r) => r.id)).toEqual(['m1']);
    expect(readForkLineage(tgt.sql)!.sourceMessageId).toBe('m1');
  });

  test('a file range whose offset does not match what arrived is refused', async () => {
    const src = await source({ files: [{ path: 'memory/big.md', content: 'x'.repeat(64) }] });
    const tgt = fresh();
    const frames = framesFor(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3'), { fileBytes: 16 });
    const firstRange = frames.findIndex((f) => f.kind === 'file');
    const receiver = receiverFor(tgt);
    await drain(receiver, frames.slice(0, firstRange + 1));
    const skewed = frames[firstRange + 1]!;
    if (skewed.kind !== 'file') throw new Error('expected a second file range');
    await expect(receiver.accept(sealForkFrame({ ...skewed, offset: skewed.offset + 1 })))
      .rejects.toThrow(/declares offset \d+ where \d+ bytes have arrived/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a file that reassembles to different bytes is refused before it is written', async () => {
    const src = await source({ files: [{ path: 'memory/big.md', content: 'y'.repeat(40) }] });
    const tgt = fresh();
    const frames = framesFor(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3'), { fileBytes: 16 });
    const receiver = receiverFor(tgt);
    // Corrupt one range and reseal it, so only the whole-file digest can see it.
    const forged = frames.map((f) => {
      if (f.kind !== 'file' || f.path !== 'memory/big.md' || f.offset !== 0) return f;
      const bytes = f.bytes.slice();
      bytes[0] = bytes[0]! ^ 0xff;
      return sealForkFrame({ ...f, bytes });
    });
    const upTo = forged.findIndex((f) => f.kind === 'file' && f.path === 'memory/big.md' && f.last);
    await drain(receiver, forged.slice(0, upTo));
    await expect(receiver.accept(forged[upTo]!))
      .rejects.toThrow(/does not match the digest the source declared/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a dropped row batch is refused at commit by the declared counts', async () => {
    const src = await source();
    const tgt = fresh();
    const snapshot = await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3');
    const frames = framesFor(snapshot, { rowsPerFrame: 1 });
    // Drop one `messages` batch and renumber, so the sequence itself is
    // consistent and only the counts can catch it.
    const dropAt = frames.findIndex((f) => f.kind === 'messages');
    let stream = FORK_STREAM_SEED;
    const kept = frames.filter((_, i) => i !== dropAt).filter((f) => f.kind !== 'commit');
    const renumbered = kept.map((f, i) => {
      const resealed = sealForkFrame({ ...f, seq: i });
      stream = foldForkStream(stream, resealed.digest);
      return resealed;
    });
    const receiver = receiverFor(tgt);
    await drain(receiver, renumbered);
    await expect(receiver.accept(sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-1', seq: renumbered.length,
      kind: 'commit', stream,
    }))).rejects.toThrow(/declared 3 messages and staged 2; refusing to publish an incomplete fork/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a stream whose frames were substituted is refused at commit by the rolling digest', async () => {
    const src = await source();
    const tgt = fresh();
    const snapshot = await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3');
    const frames = framesFor(snapshot);
    // Same counts, same sequence, one batch's CONTENT changed and resealed —
    // only the rolling digest over the frames that actually arrived can see it.
    const forged = frames.map((f) => {
      if (f.kind !== 'agentConfig') return f;
      return sealForkFrame({ ...f, rows: [{ key: 'model', value: 'substituted' }] });
    });
    const receiver = receiverFor(tgt);
    await drain(receiver, forged.slice(0, -1));
    await expect(receiver.accept(forged[forged.length - 1]!))
      .rejects.toThrow(/does not match the sequence of frames that arrived/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a frame re-delivered after publication answers with the fork that landed', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3'));
    const receiver = receiverFor(tgt);
    const outcomes = await drain(receiver, frames);
    const published = outcomes[outcomes.length - 1]!;
    if (published.status !== 'published') throw new Error('expected published');

    const again = await receiver.accept(frames[frames.length - 1]!);
    expect(again.status).toBe('settled');
    if (again.status !== 'settled') throw new Error('expected settled');
    expect(again.result).toEqual(published.result);
    // Exactly one fork, not two.
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM fork_lineage`[0]!.c).toBe(1);
  });

  test('the receiver retains no file ranges', async () => {
    const src = await source({ files: [
      { path: 'memory/a.md', content: 'a'.repeat(100) },
      { path: 'memory/b.md', content: 'b'.repeat(100) },
    ] });
    const tgt = fresh();
    const frames = framesFor(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3'), { fileBytes: 10 });
    const receiver = receiverFor(tgt);
    for (const frame of frames) {
      await receiver.accept(frame);
      expect(receiver.stagingBytes).toBe(0);
    }
  });

  /**
   * One 256 MiB fork, end to end, over generated source bytes and a caller sink.
   * Two measurement planes, on purpose: exact seam counters (frame peaks,
   * receiver staging) catch buffering at the instrumented boundaries, and a
   * GC-forced retained-heap delta catches buffering ANYWHERE in the process,
   * including seams the counters do not wrap. `Bun.gc(true)` before every
   * sample makes the delta a measure of reachable bytes, not of GC timing.
   * The buffering control below proves both planes turn red at file size.
   */
  async function streamHugeFork(sink: ForkFileSink): Promise<{
    peakRead: number; peakFrameBytes: number; peakRetained: number;
    peakRetainedHeapDelta: number; readWholeCalls: number; published: boolean;
  }> {
    let peakRead = 0;
    let readWholeCalls = 0;
    const plane: ForkFileSource = {
      async readFile() { readWholeCalls += 1; throw new Error('the fork sender must not read an inherited file whole'); },
      async readRange(path, offset, length) {
        if (path !== HUGE_PATH) throw new Error(`unexpected ranged read of ${path}`);
        peakRead = Math.max(peakRead, length);
        return hugeForkBytes(offset, length);
      },
      async writeFile() { throw new Error('the fork sender never writes'); },
      async readdir(path) { return path === 'memory' ? ['huge.bin'] : []; },
      async stat(path) {
        if (path === HUGE_PATH) return { size: HUGE_SIZE, mtimeMs: 1, isDir: false };
        if (path === 'memory') return { size: 0, mtimeMs: 1, isDir: true };
        return null;
      },
      async unlink() { throw new Error('the fork sender never unlinks'); },
      async mkdir() { throw new Error('the fork sender never makes directories'); },
      async exists(path) { return path === 'memory'; },
    };

    const src = fresh();
    void src.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'BIG'}, ${'big'}, ${1})`;
    void src.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'m1'}, ${'default'}, ${null}, ${'user'}, ${'only'}, ${1000})`;
    const tgt = fresh();
    const writer = new ForkTargetWriter(tgt.sql, tgt.vfs, { ...OWNER, targetAuthority: 'plain' });
    const receiver = new ForkTransferReceiver(writer, sink);

    let peakRetained = 0;
    let peakFrameBytes = 0;
    let published = false;
    Bun.gc(true);
    // heapUsed + external covers both places a runtime may account ArrayBuffer
    // backing stores. The buffering control proves the domain fires: were the
    // accounting to move somewhere this sum misses, that control turns red.
    const retainedBytesNow = () => {
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.external;
    };
    const baselineRetained = retainedBytesNow();
    let peakRetainedHeapDelta = 0;
    const sampleRetainedHeap = () => {
      Bun.gc(true);
      peakRetainedHeapDelta = Math.max(peakRetainedHeapDelta, retainedBytesNow() - baselineRetained);
    };
    for await (const frame of forkTransferFrames({
      sql: src.sql, vfs: plane, untilMessageId: 'm1', transferId: 'tx-256m',
      targetAuthority: 'plain', frameBytes: HUGE_FRAME,
    })) {
      if (frame.kind === 'file') {
        peakFrameBytes = Math.max(peakFrameBytes, frame.bytes.byteLength);
        const transferred = frame.offset + frame.bytes.byteLength;
        // Sample while accumulated ranges are still reachable, before accept
        // can publish and release them. Halfway detects early accumulation;
        // the final boundary sees 31 retained frames in the buffering control.
        if (transferred === HUGE_SIZE / 2 || transferred === HUGE_SIZE) sampleRetainedHeap();
      }
      const outcome = await receiver.accept(frame);
      published = outcome.status === 'published';
      peakRetained = Math.max(peakRetained, receiver.stagingBytes);
    }
    return { peakRead, peakFrameBytes, peakRetained, peakRetainedHeapDelta, readWholeCalls, published };
  }

  test('a 256 MiB logical file crosses end to end without either side holding it', async () => {
    // The sink keeps counters and a rolling hash, never bytes, so a receiver
    // that buffered a file could not hide inside the fake either.
    const committed = new Map<string, { bytes: number; digest: string }>();
    const temp = new Map<string, { bytes: number; hash: Bun.CryptoHasher }>();
    let peakWrite = 0;
    let peakReadBack = 0;
    const native: ForkNativeFilePort = {
      async truncate(path, size) {
        const staged = temp.get(path);
        if (staged === undefined || size !== staged.bytes) {
          temp.set(path, { bytes: size, hash: new Bun.CryptoHasher('sha256') });
        }
      },
      async writeRange(path, offset, bytes) {
        peakWrite = Math.max(peakWrite, bytes.byteLength);
        if (bytes.byteLength === 0 && offset === 0 && !temp.has(path)) {
          temp.set(path, { bytes: 0, hash: new Bun.CryptoHasher('sha256') });
          return;
        }
        const staged = temp.get(path);
        if (!staged || offset !== staged.bytes) throw new Error('sink received a noncontiguous range');
        staged.bytes += bytes.byteLength;
        staged.hash.update(bytes);
      },
      // Answered from the position rather than from storage, for the same reason
      // the source plane is: a fixture that kept 256 MiB to serve the read-back
      // would be the very thing this test measures against. The BOUND is what is
      // asserted below — one frame per read, never the file.
      async readRange(path, offset, length) {
        const staged = temp.get(path);
        if (!staged || offset + length > staged.bytes) throw new Error('sink read back past its staging');
        peakReadBack = Math.max(peakReadBack, length);
        return hugeForkBytes(offset, length);
      },
      async rename(from, to) {
        const staged = temp.get(from);
        if (!staged) throw new Error('sink committed no temp');
        committed.set(to, { bytes: staged.bytes, digest: staged.hash.digest('hex') });
        temp.delete(from);
      },
      async unlink(path) { temp.delete(path); },
    };

    const run = await streamHugeFork(new NativeSinkPlan(native, '256m'));

    // Neither half ever touches more than one frame of the file: the sender
    // reads ranges and never a whole file, the receiver retains nothing between
    // frames, and the bytes that land still hash to the file that was sent.
    expect(run.readWholeCalls).toBe(0);
    expect(run.peakRead).toBe(HUGE_FRAME);
    expect(run.peakFrameBytes).toBe(HUGE_FRAME);
    expect(peakWrite).toBe(HUGE_FRAME);
    // The whole-file check reads the staging back, and it reads it one bounded
    // range at a time: 256 MiB verified at an 8 MiB peak.
    expect(peakReadBack).toBe(FORK_FRAME_BYTES);
    expect(run.peakRetained).toBe(0);
    // The process-wide plane: reachable bytes above the pre-stream baseline
    // never approach the file. The buffering control below drives this same
    // measurement past 192 MiB, so a pass here is a measured bound, not a
    // sampler that cannot fire.
    expect(run.peakRetainedHeapDelta).toBeLessThan(64 * 1024 * 1024);
    expect(run.published).toBe(true);
    expect(committed.get(HUGE_PATH)).toEqual({ bytes: HUGE_SIZE, digest: hugeForkDigest() });
    expect(temp.size).toBe(0);
  });

  test('the bound is measured, not assumed: a sink that keeps the ranges blows it', async () => {
    // The negative control for the test above. Same source, same 256 MiB, and
    // the ONLY difference is a sink that holds every range. Both detectors
    // must fire: the sink's own exact counter reaches the file size, and the
    // GC-forced retained-heap delta sees the same bytes from outside the
    // instrumented seams — proof the process-wide plane can fail.
    const kept: Uint8Array[] = [];
    let retainedPeak = 0;
    const buffering: ForkFileSink = {
      async beginFile() { kept.length = 0; },
      async writeRange(_path, _offset, bytes) {
        kept.push(bytes);
        const retained = kept.reduce((sum, part) => sum + part.byteLength, 0);
        retainedPeak = Math.max(retainedPeak, retained);
      },
      async stagedDigest() {
        const hash = new Bun.CryptoHasher('sha256');
        for (const part of kept) hash.update(part);
        return hash.digest('hex');
      },
      async commitFile() { return {}; },
      async abortFile() { kept.length = 0; },
    };

    const run = await streamHugeFork(buffering);

    expect(run.published).toBe(true);
    // The keeping sink held the WHOLE file at once; the streaming run's twin
    // assertion is `peakRetained === 0` above. One metric, both directions.
    expect(retainedPeak).toBe(HUGE_SIZE);
    expect(run.peakRetainedHeapDelta).toBeGreaterThanOrEqual(192 * 1024 * 1024);
  });

  test('a native sink abort keeps an existing destination and commit replaces it atomically', async () => {
    const files = new Map<string, Uint8Array>([['memory/existing.md', new TextEncoder().encode('old')]]);
    const temps = new Map<string, Uint8Array>();
    const native: ForkNativeFilePort = {
      async truncate(path, size) {
        const current = temps.get(path);
        temps.set(path, current === undefined ? new Uint8Array(size) : current.slice(0, size));
      },
      async writeRange(path, offset, bytes) {
        const current = temps.get(path) ?? new Uint8Array(0);
        const next = new Uint8Array(Math.max(current.byteLength, offset + bytes.byteLength));
        next.set(current);
        next.set(bytes, offset);
        temps.set(path, next);
      },
      async readRange(path, offset, length) {
        return (temps.get(path) ?? new Uint8Array(0)).subarray(offset, offset + length);
      },
      async rename(from, to) {
        const next = temps.get(from);
        if (!next) throw new Error('missing temp');
        files.set(to, next);
        temps.delete(from);
      },
      async unlink(path) { temps.delete(path); },
    };
    const sink = new NativeSinkPlan(native, 'atomic');
    await sink.beginFile('memory/existing.md', 0);
    await sink.writeRange('memory/existing.md', 0, new TextEncoder().encode('new'), true);
    expect(new TextDecoder().decode(files.get('memory/existing.md'))).toBe('old');
    await sink.abortFile('memory/existing.md');
    expect(new TextDecoder().decode(files.get('memory/existing.md'))).toBe('old');
    expect(temps.size).toBe(0);
    await sink.beginFile('memory/existing.md', 0);
    await sink.writeRange('memory/existing.md', 0, new TextEncoder().encode('new'), true);
    await sink.commitFile('memory/existing.md');
    expect(new TextDecoder().decode(files.get('memory/existing.md'))).toBe('new');
    expect(temps.size).toBe(0);
  });

  test('a refusal mid-file removes the staged temp and leaves the destination alone', async () => {
    const files = new Map<string, Uint8Array>([['memory/keep.md', new TextEncoder().encode('old')]]);
    const temps = new Map<string, Uint8Array>();
    const native: ForkNativeFilePort = {
      async truncate(path, size) {
        const current = temps.get(path);
        temps.set(path, current === undefined ? new Uint8Array(size) : current.slice(0, size));
      },
      async writeRange(path, offset, bytes) {
        const current = temps.get(path) ?? new Uint8Array(0);
        const next = new Uint8Array(Math.max(current.byteLength, offset + bytes.byteLength));
        next.set(current);
        next.set(bytes, offset);
        temps.set(path, next);
      },
      async readRange(path, offset, length) {
        return (temps.get(path) ?? new Uint8Array(0)).subarray(offset, offset + length);
      },
      async rename(from, to) {
        const next = temps.get(from);
        if (!next) throw new Error('missing temp');
        files.set(to, next);
        temps.delete(from);
      },
      async unlink(path) { temps.delete(path); },
    };
    const tgt = fresh();
    const writer = new ForkTargetWriter(tgt.sql, tgt.vfs, { ...OWNER, targetAuthority: 'plain' });
    const receiver = new ForkTransferReceiver(writer, new NativeSinkPlan(native, 'refusal'));
    const begin = sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-refuse', seq: 0, kind: 'begin',
      head: { source: { workspaceId: 'S', workspaceName: 's' }, cut: { messageId: 'm1', createdAtMs: 1 } },
      targetAuthority: 'plain',
      counts: { agentConfig: 0, craftedTools: 0, memoryChunks: 0, assistantMessages: 0, messages: 0, files: 1 },
    });
    await receiver.accept(begin);
    await receiver.accept(sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-refuse', seq: 1, kind: 'file', path: 'memory/keep.md',
      offset: 0, bytes: new TextEncoder().encode('new'), last: false,
    }));
    expect(temps.size).toBe(1);

    // A frame belonging to somebody else's transfer: this transfer will never
    // continue, so its temp must not survive the refusal.
    await expect(receiver.accept(sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-other', seq: 2, kind: 'commit',
      stream: foldForkStream(FORK_STREAM_SEED, begin.digest),
    }))).rejects.toThrow(/belongs to transfer tx-other/);
    expect(temps.size).toBe(0);
    expect(new TextDecoder().decode(files.get('memory/keep.md'))).toBe('old');
    expect(isFork(tgt)).toBe(false);
  });

  test('a new receiver adopts the staging the last one left mid-file, and verifies the whole file', async () => {
    const files = new Map<string, Uint8Array>();
    const temps = new Map<string, Uint8Array>();
    const native: ForkNativeFilePort = {
      async truncate(path, size) {
        const current = temps.get(path);
        temps.set(path, current === undefined ? new Uint8Array(size) : current.slice(0, size));
      },
      async writeRange(path, offset, bytes) {
        const current = temps.get(path) ?? new Uint8Array(0);
        const next = new Uint8Array(Math.max(current.byteLength, offset + bytes.byteLength));
        next.set(current);
        next.set(bytes, offset);
        temps.set(path, next);
      },
      async readRange(path, offset, length) {
        return (temps.get(path) ?? new Uint8Array(0)).subarray(offset, offset + length);
      },
      async rename(from, to) {
        const next = temps.get(from);
        if (!next) throw new Error('missing temp');
        files.set(to, next);
        temps.delete(from);
      },
      async unlink(path) { temps.delete(path); },
    };
    const tgt = fresh();
    const content = new TextEncoder().encode('0123456789abcdefghij');
    const digest = new Bun.CryptoHasher('sha256').update(content).digest('hex');
    const transferId = 'tx-resume';
    // The file plane and the target's SQLite persist; the receiver, the writer
    // and the sink plan do not. That pair is what a Durable Object reset leaves.
    const activation = (): ForkTransferReceiver => new ForkTransferReceiver(
      new ForkTargetWriter(tgt.sql, tgt.vfs, { ...OWNER, targetAuthority: 'plain' }),
      new NativeSinkPlan(native, transferId),
    );
    const range = (seq: number, offset: number, last: boolean): ForkFrame => {
      let frame: Parameters<typeof sealForkFrame>[0] = {
        version: FORK_TRANSFER_VERSION, transferId, seq, kind: 'file', path: 'memory/resume.md',
        offset, bytes: content.subarray(offset, offset + 10), last,
      };
      if (last) frame = { ...frame, fileDigest: digest };
      return sealForkFrame(frame);
    };
    const begin = sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId, seq: 0, kind: 'begin',
      head: { source: { workspaceId: 'S', workspaceName: 's' }, cut: { messageId: 'm1', createdAtMs: 1 } },
      targetAuthority: 'plain',
      counts: { agentConfig: 0, craftedTools: 0, memoryChunks: 0, assistantMessages: 0, messages: 0, files: 1 },
    });

    const first = activation();
    await first.accept(begin);
    await first.accept(range(1, 0, false));
    expect(temps.size).toBe(1);
    expect(files.has('memory/resume.md')).toBe(false);

    // A different receiver, a different sink plan, the same storage: the second
    // range lands at the offset the TARGET counted, and the file's digest is
    // read back out of a staging no single activation wrote whole.
    const second = activation();
    await second.accept(range(2, 10, true));
    expect(new TextDecoder().decode(files.get('memory/resume.md'))).toBe('0123456789abcdefghij');
    expect(temps.size).toBe(0);

    // And the transfer still completes: the file counted once, published once.
    const outcome = await second.accept(sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId, seq: 3, kind: 'commit',
      stream: [begin, range(1, 0, false), range(2, 10, true)]
        .reduce((stream, frame) => foldForkStream(stream, frame.digest), FORK_STREAM_SEED),
    }));
    expect(outcome.status).toBe('published');
    expect(isFork(tgt)).toBe(true);
  });

  test('a protected destination is published from its one frame, with nothing staged on disk', async () => {
    const calls: string[] = [];
    const native: ForkNativeFilePort = {
      async truncate(path) { calls.push(`truncate:${path}`); },
      async writeRange(path) { calls.push(`writeRange:${path}`); },
      async readRange(path) { calls.push(`readRange:${path}`); return new Uint8Array(0); },
      async rename(from, to) { calls.push(`rename:${from}->${to}`); },
      async unlink(path) { calls.push(`unlink:${path}`); },
    };
    let publishedBytes: Uint8Array = new Uint8Array(0);
    const sink = new NativeSinkPlan(native, 'protected', {
      owns: (targetPath) => targetPath === SOUL_PATH,
      async publish(_targetPath, bytes) {
        publishedBytes = bytes;
        return { mission: 'carried by the protected write' };
      },
    });
    const soul = new TextEncoder().encode('## Mission\nship it');
    await sink.beginFile(SOUL_PATH, 0);
    await sink.writeRange(SOUL_PATH, 0, soul, true);
    const commit = await sink.commitFile(SOUL_PATH);

    expect(commit).toEqual({ mission: 'carried by the protected write' });
    expect(publishedBytes).toBe(soul);
    // No temp was created, renamed or removed: the protected write IS the
    // publication, so the plan never touches the filesystem for it.
    expect(calls).toEqual([]);
  });

  test('a protected destination larger than one frame is refused before it is held', async () => {
    const sink = new NativeSinkPlan({
      async truncate() { throw new Error('unused'); },
      async writeRange() { throw new Error('unused'); },
      async readRange() { throw new Error('unused'); },
      async rename() { throw new Error('unused'); },
      async unlink() { throw new Error('unused'); },
    }, 'protected', {
      owns: (targetPath) => targetPath === SOUL_PATH,
      async publish() { throw new Error('a refused protected file must never be published'); },
    });
    await sink.beginFile(SOUL_PATH, 0);
    // The FIRST range already says the file will not fit one frame, so it is
    // refused there — a stalled sender cannot leave a frame held behind it.
    await expect(sink.writeRange(SOUL_PATH, 0, new TextEncoder().encode('first frame'), false))
      .rejects.toThrow(/spans more than one frame/);
  });

  test('a 100 MiB transcript and a large file keep target staging bounded to one file', async () => {
    const src = fresh();
    void src.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'BIG'}, ${'big'}, ${1})`;
    await writeSoul(src.vfs, src.sql, 'p');
    const megabyte = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 100; i += 1) {
      void src.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${`m${i}`}, ${'default'}, ${i === 0 ? null : `m${i - 1}`}, ${'user'}, ${megabyte}, ${1000 + i})`;
    }
    await src.vfs.mkdir('memory', { recursive: true });
    await src.vfs.writeFile('memory/large.md', 'f'.repeat(8 * 1024 * 1024));

    const tgt = fresh();
    const receiver = receiverFor(tgt);
    let peak = 0;
    let frames = 0;
    for await (const frame of forkTransferFrames({
      sql: src.sql, vfs: src.vfs, untilMessageId: 'm99', transferId: 'tx-100m',
      targetAuthority: 'plain', frameBytes: 1024 * 1024,
    })) {
      await receiver.accept(frame);
      peak = Math.max(peak, receiver.stagingBytes);
      frames += 1;
    }
    // The receiver forwards each range immediately. Its transfer state stays
    // constant even while the source emits a 100 MiB logical transcript.
    expect(frames).toBeGreaterThan(100);
    expect(peak).toBe(0);
    expect(receiver.stagingBytes).toBe(0);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM messages WHERE role != 'system'`[0]!.c).toBe(100);
    expect(await tgt.vfs.readFile('memory/large.md', { encoding: 'utf8' })).toHaveLength(8 * 1024 * 1024);
  });

  test('a frame whose content and digest disagree is refused before staging', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3'));
    const frame = frames.find((candidate) => candidate.kind === 'agentConfig');
    if (!frame || frame.kind !== 'agentConfig') throw new Error('expected agent config frame');
    await expect(receiverFor(tgt).accept({ ...frame, rows: [{ key: 'model', value: 'tampered' }] }))
      .rejects.toThrow(/digest does not match its content/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a version this tree does not implement is refused', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3'));
    const receiver = receiverFor(tgt);
    // SAFETY: this is deliberately malformed wire input. The schema rejects
    // it before any staged target state can mutate, which is the behavior under test.
    await expect(receiver.accept({ ...frames[0]!, version: FORK_TRANSFER_VERSION + 1 } as ForkFrame))
      .rejects.toThrow(new RegExp(`not valid for protocol version ${String(FORK_TRANSFER_VERSION)}`));
    expect(isFork(tgt)).toBe(false);
  });

  test('a continuation with no open transfer is refused', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm3'));
    await expect(receiverFor(tgt).accept(frames[1]!))
      .rejects.toThrow(/has no open transfer to continue/);
    expect(isFork(tgt)).toBe(false);
  });
});
