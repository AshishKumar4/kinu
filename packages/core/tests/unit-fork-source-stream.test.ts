/** Frames must carry the cut's conversation, stay within the frame budget, and carry an oversized row alone. */

import { describe, expect, test } from 'bun:test';
import { createTestWorkspace, type TestWorkspace } from './helpers';
import {
  seedForkSource, SOURCE_ARTIFACTS, SPILLED_BYTES, INLINE_PAYLOAD_BYTES, type ForkConversation,
} from './helpers/fork-conversation';
import { reassemble } from './helpers/fork-stream';
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
    // Entries and memberships are keyed on the conversation owner; any other handle snapshots the wrong transcript.
    sql: ws.sql, actor: openWorkspaceMainActor(ws.sql), vfs: ws.vfs,
    artifactDirectory: SOURCE_ARTIFACTS,
    untilMessageId, transferId: 'transfer', frameBytes,
  }));
}

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
        + bytes(row.native_content_kind) + bytes(row.origin) + bytes(row.envelope_json)
        + bytes(row.content_json) + bytes(row.content_path) + bytes(row.content_digest), 0);
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
  test('carries the cut\'s conversation whole, however small the frames', async () => {
    const ws = createTestWorkspace();
    await seedChain(ws);

    const carried = reassemble(await framesFor(ws, 24));

    expect(carried.sessionMessages.length).toBe(3);
    expect(carried.conversationEntries.map((row) => row.id)).toEqual(['m1', 'm2', 'm3']);
    expect(carried.contextMembers.map((row) => row.entry_id)).toEqual(['m1', 'm2', 'm3']);
    // Frame size decides only how the rows are cut, never which rows cross.
    expect(carried).toEqual(reassemble(await framesFor(ws)));
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
      conversationEntries: carried.conversationEntries.length,
      conversationEntryParts: carried.conversationEntryParts.length,
      contextMembers: carried.contextMembers.length,
      files: carried.files.length + carried.artifacts.length,
    });
  });

  test('bounds every row batch and file range while sending an oversized row intact', async () => {
    const ws = createTestWorkspace();
    const chat = await seedChain(ws);
    // An unsplittable inline row crosses alone rather than being refused.
    const inline = 'x'.repeat(INLINE_PAYLOAD_BYTES - 200);
    await chat.say({ id: 'm4', role: 'user', text: inline });
    await ws.vfs.writeFile('memory/large.md', 'y'.repeat(1_000_000));

    const frames = await framesFor(ws, 2048, 'm4');
    const rowFrames = frames.filter(isRowFrame);
    expect(rowFrames.every((frame) => frame.rows.length === 1 || rowPayloadBytes(frame) <= 2048)).toBe(true);
    expect(frames.filter(isFileFrame).every((frame) => frame.bytes.byteLength <= 2048)).toBe(true);

    const huge = rowFrames.find((frame) => frame.kind === 'sessionMessages'
      && frame.rows.some((row) => row.content_json !== null && row.content_json.includes(inline)));

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
    // Relative: the receiver re-roots paths under its own plane.
    expect(payloads.every((frame) => !frame.path.startsWith('/'))).toBe(true);
    const bytes = Bun.concatArrayBuffers(payloads.map((frame) => frame.bytes));
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual([{ partNo: 0, kind: 'text', streamOrder: 0, replyTo: null, value: { type: 'text', text: spilled } }]);

    const referenced = frames.filter(isRowFrame).flatMap(
      (frame) => (frame.kind === 'sessionMessages' ? frame.rows : []),
    ).flatMap((row) => (row.content_path === null ? [] : [row.content_path]));

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
    // A reference into another plane can be neither re-rooted nor copied verbatim.
    void ws.sql`UPDATE session_messages SET content_path = '/other/plane/escape.json' WHERE content_path IS NOT NULL`;

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
