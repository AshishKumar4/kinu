/**
 * The source half of the fork wire: one workspace read into sealed, bounded
 * frames.
 *
 * The central property is EQUIVALENCE — the frames reassemble to exactly the
 * value the in-process snapshot materializes — plus the two bounds the framing
 * exists for: no row batch and no file range exceeds the frame budget, and a
 * single oversized row crosses alone rather than being refused.
 */

import { describe, expect, test } from 'bun:test';
import { createTestWorkspace, type TestWorkspace } from './helpers';
import {
  seedForkSource, SOURCE_ARTIFACTS, SPILLED_BYTES, INLINE_PAYLOAD_BYTES, type ForkConversation,
} from './helpers/fork-conversation';
import { snapshotWorkspaceForFork } from '../src/identity/fork';
import type { ForkFile, ForkSnapshot } from '../src/identity/fork-rows';
import {
  FORK_ROW_SECTIONS, forkTransferFrames, type ForkFileFrame, type ForkFrame, type ForkRowFrame,
} from '../src/identity/fork-transfer';
import { openWorkspaceMainActor } from '../src/identity/workspace-actors';

function isRowFrame(frame: ForkFrame): frame is ForkRowFrame {
  return 'rows' in frame;
}

function isFileFrame(frame: ForkFrame): frame is ForkFileFrame {
  return frame.kind === 'file';
}

async function seedChain(ws: TestWorkspace): Promise<ForkConversation> {
  const chat = await seedForkSource(ws, {
    craftedTools: [{ name: 'tool', description: 'description', code: 'return 1' }],
  });

  await chat.say({ id: 'm1', role: 'user', text: 'first', parentId: null });
  await chat.say({ id: 'm2', role: 'assistant', text: 'second' });
  await chat.say({ id: 'm3', role: 'user', text: 'third' });
  chat.actor.config.setShellApprovalMode('allow_all');

  return chat;
}

function framesFor(ws: TestWorkspace, frameBytes = 2048, untilMessageId = 'm3'): Promise<ForkFrame[]> {
  return Array.fromAsync(forkTransferFrames({
    // The OWNER of the conversation being forked: entries and memberships are
    // keyed on it, so a snapshot taken under any other handle carries a
    // sibling's transcript — or, here, none at all.
    sql: ws.sql, actor: openWorkspaceMainActor(ws.sql), vfs: ws.vfs,
    artifactDirectory: SOURCE_ARTIFACTS,
    untilMessageId, transferId: 'transfer', frameBytes,
  }));
}

/** The snapshot a stream carries, rebuilt from its frames — so the comparison
 *  below is against the in-process value rather than against a restatement of
 *  what the streamer happens to emit. */
function reassemble(frames: ForkFrame[]): ForkSnapshot {
  const begin = frames[0];

  if (begin?.kind !== 'begin') throw new Error('missing begin frame');
  const files = new Map<string, Uint8Array[]>();
  const artifacts = new Map<string, Uint8Array[]>();

  for (const frame of frames) {
    if (!isFileFrame(frame)) continue;
    const into = frame.artifact ? artifacts : files;
    const ranges = into.get(frame.path) ?? [];
    ranges.push(frame.bytes);
    into.set(frame.path, ranges);
  }

  const decoder = new TextDecoder();

  const decode = (carried: Map<string, Uint8Array[]>): ForkFile[] => [...carried]
    .map(([path, ranges]) => ({ path, content: decoder.decode(Bun.concatArrayBuffers(ranges)) }));

  return {
    source: begin.head.source,
    cut: begin.head.cut,
    agentConfig: frames.flatMap((frame) => (frame.kind === 'agentConfig' ? frame.rows : [])),
    craftedTools: frames.flatMap((frame) => (frame.kind === 'craftedTools' ? frame.rows : [])),
    memoryChunks: frames.flatMap((frame) => (frame.kind === 'memoryChunks' ? frame.rows : [])),
    sessionMessages: frames.flatMap((frame) => (frame.kind === 'sessionMessages' ? frame.rows : [])),
    messageParts: frames.flatMap((frame) => (frame.kind === 'messageParts' ? frame.rows : [])),
    messageUpdates: frames.flatMap((frame) => (frame.kind === 'messageUpdates' ? frame.rows : [])),
    conversationEntries: frames.flatMap((frame) => (frame.kind === 'conversationEntries' ? frame.rows : [])),
    conversationEntryParts: frames.flatMap((frame) => (frame.kind === 'conversationEntryParts' ? frame.rows : [])),
    contextMembers: frames.flatMap((frame) => (frame.kind === 'contextMembers' ? frame.rows : [])),
    files: decode(files),
    artifacts: decode(artifacts),
  };
}

/** The same measure the sender batches by, restated per section so a frame that
 *  exceeded the budget with more than one row is visible here. */
function rowPayloadBytes(frame: ForkFrame): number {
  const bytes = (value: string | null): number => (value === null ? 0 : Buffer.byteLength(value));

  switch (frame.kind) {
    case 'agentConfig':
      return frame.rows.reduce((total, row) => total + bytes(row.key) + bytes(row.value), 0);
    case 'craftedTools':
      return frame.rows.reduce((total, row) => total + bytes(row.name) + bytes(row.description)
        + bytes(row.params) + bytes(row.code) + bytes(row.scope), 0);
    case 'memoryChunks':
      return frame.rows.reduce((total, row) => total + bytes(row.id) + bytes(row.path)
        + bytes(row.hash) + bytes(row.text), 0);
    case 'sessionMessages':
      return frame.rows.reduce((total, row) => total + bytes(row.message_id) + bytes(row.role)
        + bytes(row.native_content_kind) + bytes(row.origin), 0);
    case 'messageParts':
      return frame.rows.reduce((total, row) => total + bytes(row.message_id) + bytes(row.kind)
        + bytes(row.reply_to_message_id), 0);
    case 'messageUpdates':
      return frame.rows.reduce((total, row) => total + bytes(row.message_id) + bytes(row.operation)
        + bytes(row.payload_json) + bytes(row.payload_path) + bytes(row.payload_digest), 0);
    case 'conversationEntries':
      return frame.rows.reduce((total, row) => total + bytes(row.id) + bytes(row.parent_id) + bytes(row.role)
        + bytes(row.turn_id) + bytes(row.run_id)
        + bytes(row.metadata_json) + bytes(row.metadata_path) + bytes(row.metadata_digest), 0);
    case 'conversationEntryParts':
      return frame.rows.reduce((total, row) => total + bytes(row.entry_id) + bytes(row.message_id), 0);
    case 'contextMembers':
      return frame.rows.reduce((total, row) => total + bytes(row.entry_id) + bytes(row.message_id), 0);
    case 'begin':
    case 'file':
    case 'commit':
      return 0;
  }
}

describe('forkTransferFrames source streamer', () => {
  test('reassembles exactly to the in-process snapshot', async () => {
    const ws = createTestWorkspace();
    await seedChain(ws);

    const snapshot = await snapshotWorkspaceForFork({
      sql: ws.sql, vfs: ws.vfs, untilMessageId: 'm3', artifactDirectory: SOURCE_ARTIFACTS,
    });

    expect(snapshot.sessionMessages.length).toBe(3);
    expect(snapshot.conversationEntries.map((row) => row.id)).toEqual(['m1', 'm2', 'm3']);
    expect(snapshot.contextMembers.map((row) => row.entry_id)).toEqual(['m1', 'm2', 'm3']);
    expect(reassemble(await framesFor(ws, 24))).toEqual(snapshot);
  });

  test('sections cross contiguously in the protocol order, and files follow them', async () => {
    const ws = createTestWorkspace();
    await seedChain(ws);
    const frames = await framesFor(ws, 24);

    expect(frames[0]?.kind).toBe('begin');
    expect(frames.at(-1)?.kind).toBe('commit');
    expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index));
    const rowKinds = frames.filter(isRowFrame).map((frame) => frame.kind);
    expect(rowKinds).toEqual([...rowKinds].sort((a, b) => FORK_ROW_SECTIONS.indexOf(a) - FORK_ROW_SECTIONS.indexOf(b)));
    expect(frames.filter(isRowFrame).every((frame) => frame.rows.length > 0)).toBe(true);
    const fileIndex = frames.findIndex(isFileFrame);
    const lastRowIndex = frames.length - 1 - [...frames].reverse().findIndex(isRowFrame);
    expect(fileIndex).toBeGreaterThan(lastRowIndex);
  });

  test('declares per-section counts equal to what the stream carries', async () => {
    const ws = createTestWorkspace();
    await seedChain(ws);
    const frames = await framesFor(ws, 24);
    const begin = frames[0];

    if (begin?.kind !== 'begin') throw new Error('missing begin frame');
    const carried = reassemble(frames);

    expect(begin.counts).toEqual({
      agentConfig: carried.agentConfig.length,
      craftedTools: carried.craftedTools.length,
      memoryChunks: carried.memoryChunks.length,
      sessionMessages: carried.sessionMessages.length,
      messageParts: carried.messageParts.length,
      messageUpdates: carried.messageUpdates.length,
      conversationEntries: carried.conversationEntries.length,
      conversationEntryParts: carried.conversationEntryParts.length,
      contextMembers: carried.contextMembers.length,
      files: carried.files.length + carried.artifacts.length,
    });
  });

  test('bounds every row batch and file range while sending an oversized row intact', async () => {
    const ws = createTestWorkspace();
    const chat = await seedChain(ws);
    // The largest payload the store keeps inline is one update row that cannot
    // be split, so it crosses alone rather than being refused.
    const inline = 'x'.repeat(INLINE_PAYLOAD_BYTES - 2);
    await chat.say({ id: 'm4', role: 'user', text: inline });
    await ws.vfs.writeFile('memory/large.md', 'y'.repeat(1_000_000));

    const frames = await framesFor(ws, 2048, 'm4');
    const rowFrames = frames.filter(isRowFrame);
    expect(rowFrames.every((frame) => frame.rows.length === 1 || rowPayloadBytes(frame) <= 2048)).toBe(true);
    expect(frames.filter(isFileFrame).every((frame) => frame.bytes.byteLength <= 2048)).toBe(true);

    const huge = rowFrames.find((frame) => frame.kind === 'messageUpdates'
      && frame.rows.some((row) => row.payload_json === JSON.stringify(inline)));

    expect(huge?.rows).toHaveLength(1);
  });

  test('carries a spilled payload as a file frame relative to the artifact directory', async () => {
    const ws = createTestWorkspace();
    const chat = await seedChain(ws);
    const spilled = 'p'.repeat(SPILLED_BYTES);
    await chat.say({ id: 'm4', role: 'user', text: spilled });

    const frames = await framesFor(ws, 64 * 1024, 'm4');
    const payloads = frames.filter(isFileFrame).filter((frame) => frame.artifact);

    expect(payloads.length).toBeGreaterThan(0);
    // Relative: an absolute path would name the SOURCE's plane, and the
    // receiver re-roots it under its own.
    expect(payloads.every((frame) => !frame.path.startsWith('/'))).toBe(true);
    const bytes = Bun.concatArrayBuffers(payloads.map((frame) => frame.bytes));
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(spilled));

    const referenced = frames.filter(isRowFrame).flatMap(
      (frame) => (frame.kind === 'messageUpdates' ? frame.rows : []),
    ).flatMap((row) => (row.payload_path === null ? [] : [row.payload_path]));

    expect(referenced).toContain(payloads[0]?.path);
  });

  test('ranges files byte-exactly, digests their last range, and emits an empty file once', async () => {
    const ws = createTestWorkspace();
    await seedChain(ws);
    await ws.vfs.writeFile('memory/ranged.md', 'abcdefghij'.repeat(100));
    await ws.vfs.writeFile('memory/empty.md', '');
    const frames = await framesFor(ws, 64);
    const ranged = frames.filter(isFileFrame).filter((frame) => frame.path === 'memory/ranged.md');
    expect(ranged.length).toBeGreaterThan(1);
    const bytes = Bun.concatArrayBuffers(ranged.map((frame) => frame.bytes));
    expect(new TextDecoder().decode(bytes)).toBe('abcdefghij'.repeat(100));
    expect(ranged.at(-1)?.fileDigest).toBe(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
    const empty = frames.filter(isFileFrame).filter((frame) => frame.path === 'memory/empty.md');
    expect(empty).toHaveLength(1);
    expect(empty[0]?.last).toBe(true);
    expect(empty[0]?.offset).toBe(0);
  });

  test('a payload outside the artifact directory refuses the fork rather than carrying it', async () => {
    const ws = createTestWorkspace();
    const chat = await seedChain(ws);
    await chat.say({ id: 'm4', role: 'user', text: 'p'.repeat(SPILLED_BYTES) });
    // A reference into another plane: re-rooting it would name a file this
    // fork does not have, copying it verbatim a directory it does not own.
    void ws.sql`UPDATE message_updates SET payload_path = '/other/plane/escape.json' WHERE payload_path IS NOT NULL`;

    await expect(framesFor(ws, 64 * 1024, 'm4')).rejects.toThrow(/outside the artifact directory/);
  });

  test('an unknown cut point is refused before a frame is produced', async () => {
    const ws = createTestWorkspace();
    await seedChain(ws);

    await expect(framesFor(ws, 2048, 'absent'))
      .rejects.toThrow('fork point not found: message id "absent" does not exist in source');
  });

  test('a cut past the tip of one branch does not carry the other branch', async () => {
    const ws = createTestWorkspace();
    const chat = await seedChain(ws);
    await chat.say({ id: 'sib', role: 'assistant', text: 'sibling', parentId: 'm1' });
    const frames = await framesFor(ws, 2048, 'm3');

    const entries = frames.filter(isRowFrame)
      .flatMap((frame) => (frame.kind === 'conversationEntries' ? frame.rows : []))
      .map((row) => row.id);

    expect(entries).toEqual(['m1', 'm2', 'm3']);
  });
});
