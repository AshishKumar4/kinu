import { describe, expect, test } from 'bun:test';
import { createTestWorkspace, SDK_SESSION_DDL, type TestWorkspace } from './helpers';
import { snapshotWorkspaceForFork, type ForkSnapshot } from '../src/identity/fork';
import { writeSoul } from '../src/identity/soul';
import {
  FORK_ROW_SECTIONS, forkTransferFrames, type ForkFileFrame, type ForkFrame, type ForkRowFrame,
} from '../src/identity/fork-transfer';

function isRowFrame(frame: ForkFrame): frame is ForkRowFrame {
  return 'rows' in frame;
}

function isFileFrame(frame: ForkFrame): frame is ForkFileFrame {
  return frame.kind === 'file';
}

async function seedSource(ws: TestWorkspace, pane = false): Promise<void> {
  void ws.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'SRC'}, ${'origin'}, ${100})`;
  await writeSoul(ws.vfs, ws.sql, 'carry this purpose');
  const messages = [
    { id: 'm1', parent: null, role: 'user', text: 'first' },
    { id: 'm2', parent: 'm1', role: 'assistant', text: 'second' },
    { id: 'm3', parent: 'm2', role: 'user', text: 'third' },
  ] as const;
  for (const [index, message] of messages.entries()) {
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${message.id}, ${'default'}, ${message.parent}, ${message.role}, ${message.text}, ${1000 + index})`;
  }
  if (pane) {
    ws.execRaw(SDK_SESSION_DDL);
    for (const message of messages) {
      const content = JSON.stringify({ id: message.id, role: message.role, parts: [{ type: 'text', text: message.text }] });
      void ws.sql`INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${message.id}, ${''}, ${message.parent}, ${message.role}, ${content}, ${'1970-01-01 00:00:01'})`;
    }
  }
  void ws.sql`INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at)
    VALUES (${'tool'}, ${'description'}, ${null}, ${'return 1'}, ${'local'}, ${10}, ${11})`;
  void ws.sql`INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
    VALUES (${'chunk'}, ${'memory/MEMORY.md'}, ${1}, ${2}, ${'hash'}, ${'remember this'}, ${12})`;
  void ws.sql`INSERT INTO agent_config (key, value) VALUES (${'model'}, ${'test-model'})`;
  void ws.sql`INSERT INTO agent_config (key, value) VALUES (${'shell_approval_mode'}, ${'allow_all'})`;
  await ws.vfs.mkdir('memory', { recursive: true });
  await ws.vfs.writeFile('memory/MEMORY.md', 'remember this');
}

async function framesFor(ws: TestWorkspace, frameBytes = 2048): Promise<ForkFrame[]> {
  return Array.fromAsync(forkTransferFrames({
    sql: ws.sql, vfs: ws.vfs, untilMessageId: 'm3', transferId: 'transfer',
    targetAuthority: 'plain', frameBytes,
  }));
}

interface FramesBySection {
  agentConfig: ForkFrame[];
  craftedTools: ForkFrame[];
  memoryChunks: ForkFrame[];
  assistantMessages: ForkFrame[];
  messages: ForkFrame[];
}

function reassemble(frames: ForkFrame[]): ForkSnapshot {
  const begin = frames[0];
  if (begin?.kind !== 'begin') throw new Error('missing begin frame');
  const files = new Map<string, Uint8Array[]>();
  const sections: FramesBySection = {
    agentConfig: [], craftedTools: [], memoryChunks: [], assistantMessages: [], messages: [],
  };
  for (const frame of frames) {
    if (frame.kind === 'file') {
      const ranges = files.get(frame.path) ?? [];
      ranges.push(frame.bytes);
      files.set(frame.path, ranges);
    } else if (isRowFrame(frame)) {
      sections[frame.kind].push(frame);
    }
  }
  const decoder = new TextDecoder();
  return {
    source: begin.head.source,
    cut: begin.head.cut,
    agentConfig: sections.agentConfig.flatMap((frame) => frame.kind === 'agentConfig' ? frame.rows : []),
    craftedTools: sections.craftedTools.flatMap((frame) => frame.kind === 'craftedTools' ? frame.rows : []),
    memoryChunks: sections.memoryChunks.flatMap((frame) => frame.kind === 'memoryChunks' ? frame.rows : []),
    assistantMessages: sections.assistantMessages.flatMap((frame) => frame.kind === 'assistantMessages' ? frame.rows : []),
    messages: sections.messages.flatMap((frame) => frame.kind === 'messages' ? frame.rows : []),
    files: [...files].map(([path, ranges]) => ({ path, content: decoder.decode(Bun.concatArrayBuffers(ranges)) })),
  };
}

function rowPayloadBytes(frame: ForkFrame): number {
  switch (frame.kind) {
    case 'agentConfig':
      return frame.rows.reduce((total, row) => total + Buffer.byteLength(row.key) + Buffer.byteLength(row.value), 0);
    case 'craftedTools':
      return frame.rows.reduce((total, row) => total + Buffer.byteLength(row.name) + Buffer.byteLength(row.description)
        + (row.params === null ? 0 : Buffer.byteLength(row.params)) + Buffer.byteLength(row.code) + Buffer.byteLength(row.scope), 0);
    case 'memoryChunks':
      return frame.rows.reduce((total, row) => total + Buffer.byteLength(row.id) + Buffer.byteLength(row.path)
        + Buffer.byteLength(row.hash) + Buffer.byteLength(row.text), 0);
    case 'assistantMessages':
      return frame.rows.reduce((total, row) => total + Buffer.byteLength(row.id) + Buffer.byteLength(row.session_id)
        + (row.parent_id === null ? 0 : Buffer.byteLength(row.parent_id)) + Buffer.byteLength(row.role)
        + Buffer.byteLength(row.content) + Buffer.byteLength(row.created_at), 0);
    case 'messages':
      return frame.rows.reduce((total, row) => total + Buffer.byteLength(row.id)
        + (row.parent_id === null ? 0 : Buffer.byteLength(row.parent_id)) + Buffer.byteLength(row.role)
        + (row.content === null ? 0 : Buffer.byteLength(row.content)), 0);
    default:
      return 0;
  }
}
describe('forkTransferFrames source streamer', () => {
  test('reassembles exactly to plain and pane snapshots, with ordered contiguous sections', async () => {
    for (const pane of [false, true]) {
      const ws = createTestWorkspace();
      await seedSource(ws, pane);
      const snapshot = await snapshotWorkspaceForFork(ws.sql, ws.vfs, 'm3');
      expect(snapshot.agentConfig.length).toBeGreaterThan(0);
      expect(snapshot.craftedTools.length).toBeGreaterThan(0);
      expect(snapshot.memoryChunks.length).toBeGreaterThan(0);
      expect(snapshot.files.length).toBeGreaterThan(0);
      expect(snapshot.messages.length).toBeGreaterThan(0);
      expect(snapshot.assistantMessages.length).toBe(pane ? 3 : 0);
      expect(snapshot.messages.some((row) => row.content === null)).toBe(pane);
      expect(snapshot.messages.some((row) => row.content !== null)).toBe(!pane);

      const frames = await framesFor(ws, 24);
      expect(reassemble(frames)).toEqual(snapshot);
      expect(frames[0]?.kind).toBe('begin');
      expect(frames.at(-1)?.kind).toBe('commit');
      expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index));
      const rowKinds = frames.filter(isRowFrame).map((frame) => frame.kind);
      expect(rowKinds).toEqual([...rowKinds].sort((a, b) => FORK_ROW_SECTIONS.indexOf(a) - FORK_ROW_SECTIONS.indexOf(b)));
      expect(frames.filter(isRowFrame).every((frame) => frame.rows.length > 0)).toBe(true);
      const fileIndex = frames.findIndex(isFileFrame);
      const lastRowIndex = frames.length - 1 - [...frames].reverse().findIndex(isRowFrame);
      expect(fileIndex).toBeGreaterThan(lastRowIndex);
    }
  });

  test('bounds every row and file range while sending oversized rows intact', async () => {
    const ws = createTestWorkspace();
    await seedSource(ws);
    const million = 'x'.repeat(1_000_000);
    void ws.sql`UPDATE messages SET content = ${million} WHERE id = ${'m3'}`;
    await ws.vfs.writeFile('memory/large.md', 'y'.repeat(1_000_000));
    const frames = await framesFor(ws, 2048);
    const rowFrames = frames.filter(isRowFrame);
    const fileFrames = frames.filter(isFileFrame);
    expect(rowFrames.every((frame) => frame.rows.length === 1 || rowPayloadBytes(frame) <= 2048)).toBe(true);
    expect(fileFrames.every((frame) => frame.bytes.byteLength <= 2048)).toBe(true);
    expect(frames.length).toBeGreaterThan(FORK_ROW_SECTIONS.length);
    const huge = rowFrames.find((frame) => frame.kind === 'messages' && frame.rows[0]?.id === 'm3');
    expect(huge?.kind).toBe('messages');
    if (huge?.kind === 'messages') {
      expect(huge.rows).toHaveLength(1);
      expect(huge.rows[0]?.content).toBe(million);
    }
  });

  test('ranges files byte-exactly, digests their last range, and emits an empty file once', async () => {
    const ws = createTestWorkspace();
    await seedSource(ws);
    await ws.vfs.writeFile('memory/ranged.md', 'abcdefghij'.repeat(100));
    await ws.vfs.writeFile('memory/empty.md', '');
    const frames = await framesFor(ws, 64);
    const ranged = frames.filter(isFileFrame).filter((frame) => frame.path === 'memory/ranged.md');
    expect(ranged.length).toBeGreaterThan(1);
    const bytes = Bun.concatArrayBuffers(ranged.map((frame) => frame.bytes));
    expect(new TextDecoder().decode(bytes)).toBe('abcdefghij'.repeat(100));
    const last = ranged.at(-1);
    expect(last?.kind).toBe('file');
    if (last?.kind === 'file') expect(last.fileDigest).toBe(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
    const empty = frames.filter(isFileFrame).filter((frame) => frame.path === 'memory/empty.md');
    expect(empty).toHaveLength(1);
    expect(empty[0]?.kind === 'file' && empty[0].last && empty[0].offset === 0).toBe(true);
  });

  test('preserves the unknown fork-point error and self-parent cycle termination', async () => {
    const missing = createTestWorkspace();
    await seedSource(missing);
    await expect(Array.fromAsync(forkTransferFrames({
      sql: missing.sql, vfs: missing.vfs, untilMessageId: 'absent', transferId: 'missing', targetAuthority: 'plain', frameBytes: 2048,
    }))).rejects.toThrow('fork point not found: message id "absent" does not exist in source');

    const cycle = createTestWorkspace();
    await seedSource(cycle);
    void cycle.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'loop'}, ${'default'}, ${'loop'}, ${'user'}, ${'self-parented'}, ${9})`;
    const frames = await Array.fromAsync(forkTransferFrames({
      sql: cycle.sql, vfs: cycle.vfs, untilMessageId: 'loop', transferId: 'cycle', targetAuthority: 'plain', frameBytes: 2048,
    }));
    const messages = frames.filter((frame) => frame.kind === 'messages').flatMap((frame) => frame.rows);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((row) => row.id === 'loop')).toBe(true);
  });
});
