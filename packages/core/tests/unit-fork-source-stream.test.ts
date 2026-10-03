import { Effect } from 'effect';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
/** Frames must carry the cut's conversation, stay within the frame budget, and carry an oversized row alone. */

import { describe, expect, test } from 'bun:test';
import { createTestWorkspace, type TestWorkspace } from './helpers';
import {
  seedForkSource, SOURCE_ARTIFACTS, SPILLED_BYTES, INLINE_PAYLOAD_BYTES, type ForkConversation,
} from './helpers/fork-conversation';
import { reassemble, sourceFrames } from './helpers/fork-stream';
import {
  FORK_ROW_SECTIONS, type ForkChunksFrame, type ForkFrame, type ForkPageFrame, type ForkRowFrame,
} from '../src/identity/fork-transfer';
import { SessionHistory } from '../src/session/history';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';

function isRowFrame(frame: ForkFrame): frame is ForkRowFrame {
  return 'rows' in frame;
}

function isChunksFrame(frame: ForkFrame): frame is ForkChunksFrame {
  return frame.kind === 'chunks';
}

function isPageFrame(frame: ForkFrame): frame is ForkPageFrame {
  return frame.kind === 'page';
}

async function seedChain(ws: TestWorkspace): Promise<ForkConversation> {
  const chat = await seedForkSource(ws, {
    craftedTools: [{ name: 'tool', description: 'description', code: 'return 1' }],
  });

  await chat.say({ id: 'm1', role: 'user', text: 'first' });
  await chat.say({ id: 'm2', role: 'assistant', text: 'second' });
  await chat.say({ id: 'm3', role: 'user', text: 'third' });
  chat.actor.config.setShellApprovalMode('allow_all');

  return chat;
}

/** The frames of a fork of `ws` at `untilMessageId`, as they cross to a target that holds nothing yet. */
function framesFor(ws: TestWorkspace, frameBytes = 2048, untilMessageId = 'm3'): Promise<ForkFrame[]> {
  return sourceFrames(ws, untilMessageId, { artifactDirectory: SOURCE_ARTIFACTS, transferId: 'transfer', frameBytes });
}

function rowPayloadBytes(frame: ForkFrame): number {
  const bytes = (value: string | null): number => (value === null ? 0 : Buffer.byteLength(value));

  switch (frame.kind) {
    case 'agentConfig':
      return frame.rows.reduce((total, row) => total + bytes(row.key) + bytes(row.value), 0);
    case 'craftedTools':
      return frame.rows.reduce((total, row) => total + bytes(row.name) + bytes(row.description)
        + bytes(row.code), 0);
    case 'memoryChunks':
      return frame.rows.reduce((total, row) => total + bytes(row.id) + bytes(row.path)
        + bytes(row.hash) + bytes(row.text), 0);
    case 'sessionMessages':
      return frame.rows.reduce((total, row) => total + bytes(row.message_id) + bytes(row.role)
        + bytes(row.native_content_kind) + bytes(row.origin) + bytes(row.envelope_json)
        + bytes(row.content_json) + bytes(row.content_path) + bytes(row.content_digest), 0);
    case 'conversationEntries':
      return frame.rows.reduce((total, row) => total + bytes(row.id) + bytes(row.role)
        + bytes(row.turn_id) + bytes(row.run_id)
        + bytes(row.metadata_json) + bytes(row.metadata_path) + bytes(row.metadata_digest), 0);
    case 'conversationEntryParts':
      return frame.rows.reduce((total, row) => total + bytes(row.entry_id) + bytes(row.message_id), 0);
    case 'contextMembers':
      return frame.rows.reduce((total, row) => total + bytes(row.entry_id) + bytes(row.message_id), 0);
    case 'begin':
    case 'soul':
    case 'chunks':
    case 'page':
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
    // One sequence number a frame taken; a page the target wanted chunks for gives its number to the next frame.
    expect(frames.slice(1).every((frame, index) => {
      const before = frames[index];

      return before !== undefined && (frame.seq === before.seq + 1 || (before.kind === 'page' && frame.seq === before.seq));
    })).toBe(true);
    const rowKinds = frames.filter(isRowFrame).map((frame) => frame.kind);
    expect(rowKinds).toEqual([...rowKinds].sort((a, b) => FORK_ROW_SECTIONS.indexOf(a) - FORK_ROW_SECTIONS.indexOf(b)));
    expect(frames.filter(isRowFrame).every((frame) => frame.rows.length > 0)).toBe(true);
    const fileIndex = frames.findIndex((frame) => frame.kind === 'soul' || frame.kind === 'page');
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
      // SOUL.md, and one import a name under the home or a payload.
      files: frames.filter((frame) => frame.kind === 'soul').length
        + new Set(frames.filter(isPageFrame).map((frame) => JSON.stringify(frame.target))).size,
    });
  });

  test('bounds every row batch and frame of chunks while sending an oversized row intact', async () => {
    const ws = createTestWorkspace();
    const chat = await seedChain(ws);
    // An unsplittable inline row crosses alone rather than being refused.
    const inline = 'x'.repeat(INLINE_PAYLOAD_BYTES - 200);
    await chat.say({ id: 'm4', role: 'user', text: inline });
    await writeText(ws.vfs, 'memory/large.md', 'y'.repeat(1_000_000));

    const frames = await framesFor(ws, 2048, 'm4');
    const rowFrames = frames.filter(isRowFrame);
    expect(rowFrames.every((frame) => frame.rows.length === 1 || rowPayloadBytes(frame) <= 2048)).toBe(true);
    // At least one chunk a frame: a chunk past the budget crosses alone.
    expect(frames.filter(isChunksFrame).every((frame) => frame.chunks.length === 1
      || frame.chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0) <= 2048)).toBe(true);
    expect(reassemble(frames).files).toContainEqual({ path: 'memory/large.md', content: 'y'.repeat(1_000_000) });

    const huge = rowFrames.find((frame) => frame.kind === 'sessionMessages'
      && frame.rows.some((row) => row.content_json !== null && row.content_json.includes(inline)));

    expect(huge?.rows).toHaveLength(1);
  });

  test('carries a spilled payload as an import relative to the artifact directory', async () => {
    const ws = createTestWorkspace();
    const chat = await seedChain(ws);
    const spilled = 'p'.repeat(SPILLED_BYTES);
    await chat.say({ id: 'm4', role: 'user', text: spilled });

    const frames = await framesFor(ws, 64 * 1024, 'm4');
    const payloads = [...new Set(frames.filter(isPageFrame).flatMap((frame) => (frame.target.in === 'artifacts' ? [frame.target.path] : [])))];

    expect(payloads).toHaveLength(1);
    // Relative: the receiver re-roots paths under its own plane.
    expect(payloads.every((path) => !path.startsWith('/'))).toBe(true);
    const [carried] = reassemble(frames).artifacts;
    expect(JSON.parse(carried?.content ?? '')).toEqual([{ partNo: 0, kind: 'text', streamOrder: 0, replyTo: null, value: { type: 'text', text: spilled } }]);

    const referenced = frames.filter(isRowFrame).flatMap(
      (frame) => (frame.kind === 'sessionMessages' ? frame.rows : []),
    ).flatMap((row) => (row.content_path === null ? [] : [row.content_path]));

    expect(referenced).toContain(payloads[0]);
  });

  test('a file past one frame of chunks crosses in several, byte-exactly, and an empty file crosses', async () => {
    const ws = createTestWorkspace();
    await seedChain(ws);
    // Distinct bytes throughout, so no two chunks are one.
    const ranged = Array.from({ length: 40_000 }, (_, index) => `line ${index}`).join('\n');
    await writeText(ws.vfs, 'memory/ranged.md', ranged);
    await writeText(ws.vfs, 'memory/empty.md', '');
    const frames = await framesFor(ws, 64 * 1024);

    expect(frames.filter(isChunksFrame).length).toBeGreaterThan(1);
    expect(reassemble(frames).files).toEqual(expect.arrayContaining([
      { path: 'memory/ranged.md', content: ranged },
      { path: 'memory/empty.md', content: '' },
    ]));
  });

  test('a chunk the target already holds never crosses again', async () => {
    const ws = createTestWorkspace();
    await seedChain(ws);
    const shared = Array.from({ length: 20_000 }, (_, index) => `shared ${index}`).join('\n');
    await writeText(ws.vfs, 'memory/a.md', shared);
    await writeText(ws.vfs, 'notes/b.md', shared);
    const frames = await framesFor(ws, 64 * 1024);
    const crossed = frames.filter(isChunksFrame).flatMap((frame) => frame.chunks.map((chunk) => chunk.hash));

    expect(new Set(crossed).size).toBe(crossed.length);
    expect(reassemble(frames).files).toEqual(expect.arrayContaining([
      { path: 'memory/a.md', content: shared },
      { path: 'notes/b.md', content: shared },
    ]));
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

  // Owner 2026-09-28: a rewind deletes what it rewound, so a fork can neither land on it nor carry it.
  test('a fork of a rewound chat carries what remained and refuses a rewound cut', async () => {
    const ws = createTestWorkspace();
    const chat = await seedChain(ws);

    const history = new SessionHistory({
      sql: ws.sql, actor: chat.actor, transactionSync: (write) => ws.db.transaction(write)(),
      files: async () => ({ vfs: ws.vfs, artifactDirectory: SOURCE_ARTIFACTS }),
    });

    history.revertTo(CHAT_SESSION_ID, 'm2', () => Effect.void);
    await chat.say({ id: 'm4', role: 'user', text: 'fourth' });

    await expect(framesFor(ws, 2048, 'm3'))
      .rejects.toThrow('fork point not found: message id "m3" does not exist in source');

    const entries = (await framesFor(ws, 2048, 'm4')).filter(isRowFrame)
      .flatMap((frame) => (frame.kind === 'conversationEntries' ? frame.rows : []))
      .map((row) => [row.id, row.position]);

    expect(entries).toEqual([['m1', 0], ['m4', 1]]);
  });
});
