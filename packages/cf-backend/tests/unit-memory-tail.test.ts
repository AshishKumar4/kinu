// The cf Memory adapter's tail answers off the workspace plane it indexes,
// over the real SQLite-backed filesystem: the newest bytes as whole code
// points, and null for a file that is not there.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createWorkspaceBundle, createTestActor, makeExecRaw, makeSql } from '../../core/tests/helpers';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import type { VectorStore } from '@kinu.run/core';
import { adaptMemory } from '../src/memory-sync';

const PATH = 'memory/MEMORY.md';

function memoryOver(content: string) {
  const database = new Database(':memory:');
  const sql = makeSql(database);
  const files = createWorkspaceBundle(database).vfs;
  const store = new MemoryStore(files, sql);
  store.ensureSchema();
  const config = createTestActor(sql, makeExecRaw(database), crypto.randomUUID(), 'memory-tail').config;
  const vectors: VectorStore = {
    available: false,
    async upsertChunk() {}, async upsertChunks() {}, async deleteChunks() {}, async search() { return []; },
  };
  const memory = adaptMemory(store, files, vectors, config);
  return { memory, ready: memory.write(PATH, content) };
}

describe('cf adaptMemory.tail', () => {
  test('hands back the newest bytes as whole code points', async () => {
    const { memory, ready } = memoryOver('héllo 你好 🎉 end');
    await ready;
    expect(await memory.tail(PATH, 4)).toBe(' end');
    // A window opening on the last byte of the 4-byte 🎉 sheds that byte.
    expect(await memory.tail(PATH, 5)).toBe(' end');
    expect(await memory.tail(PATH, 8)).toBe('🎉 end');
    // The 3-byte 好 opens whole at 12 and is cut at 11.
    expect(await memory.tail(PATH, 12)).toBe('好 🎉 end');
    expect(await memory.tail(PATH, 11)).toBe(' 🎉 end');
    // Wider than the file is the file.
    expect(await memory.tail(PATH, 1 << 20)).toBe('héllo 你好 🎉 end');
  });

  test('an absent file is null, as read answers', async () => {
    const { memory, ready } = memoryOver('x');
    await ready;
    expect(await memory.tail('memory/nothing.md', 16)).toBeNull();
    expect(await memory.read('memory/nothing.md')).toBeNull();
  });
});
