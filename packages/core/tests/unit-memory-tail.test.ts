// The MEMORY.md tail woven into every turn is a bounded read of an append-only
// file that only grows. Two things are pinned over the real SQLite-backed plane:
// what comes back is byte-identical to slicing the whole file, and the store is
// asked for the window rather than the file.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createWorkspaceBundle, createMemoryMemory } from './helpers';
import { readMemoryTail, MEMORY_TAIL_MAX_CHARS } from '../src/memory/note';
import type { WorkspaceVFS } from '../src/vfs/nimbus-workspace';

const PATH = 'memory/MEMORY.md';

function seeded(content: string | null) {
  const db = new Database(':memory:');
  const files = createWorkspaceBundle(db).vfs;
  let bytesRead = 0;

  const counted: WorkspaceVFS = {
    ...files,
    async readFile(path, opts) {
      const raw = await files.readFile(path, opts);
      bytesRead += raw instanceof Uint8Array ? raw.byteLength : new TextEncoder().encode(raw).byteLength;

      return raw;
    },
    async readRange(path, offset, length) {
      const raw = await files.readRange(path, offset, length);
      bytesRead += raw.byteLength;

      return raw;
    },
  };

  const memory = createMemoryMemory(db, counted);

  const ready = content === null
    ? Promise.resolve()
    : files.mkdir('memory', { recursive: true }).then(() => files.writeFile(PATH, content));

  return { memory, ready, bytesRead: () => bytesRead };
}

describe('readMemoryTail', () => {
  test('reads the window off the store, not the file', async () => {
    const line = `${'lesson '.repeat(13)}\n`;
    const lines = 400;
    const { memory, ready, bytesRead } = seeded(line.repeat(lines));
    await ready;
    expect(line.length * lines).toBeGreaterThan(MEMORY_TAIL_MAX_CHARS * 4);

    const tail = await readMemoryTail(memory);

    expect(tail).toHaveLength(MEMORY_TAIL_MAX_CHARS);
    // A tail of N UTF-16 units spans at most 3N bytes of UTF-8; one line over
    // that is the slack a windowed read may take. The whole file is not.
    expect(bytesRead()).toBeLessThanOrEqual(MEMORY_TAIL_MAX_CHARS * 3 + line.length);
  });

  test('the ranged tail is the whole-file tail at every bound', async () => {
    // 1-, 2-, 3- and 4-byte sequences, so every window start that can land
    // inside a code point does at some bound, and astral characters put a
    // surrogate pair on both sides of the slice.
    const content = [
      '### Note (2026-09-10)',
      'café résumé naïve — ünïcödé',
      '中文笔记：记住这一点',
      'ship it 🚀🎉 done ✅',
      'plain ascii last line',
    ].join('\n');

    const { memory, ready } = seeded(content);
    await ready;
    const whole = await memory.read(PATH);
    expect(whole).toBe(content);

    for (let bound = 1; bound <= content.length + 2; bound++) {
      expect(await readMemoryTail(memory, bound)).toBe(content.slice(-bound));
    }
  });

  test('absent and empty memory are both no tail', async () => {
    const absent = seeded(null);
    expect(await readMemoryTail(absent.memory)).toBeUndefined();
    const empty = seeded('');
    await empty.ready;
    expect(await readMemoryTail(empty.memory)).toBeUndefined();
  });
});
