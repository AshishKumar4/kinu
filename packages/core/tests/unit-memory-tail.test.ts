// The MEMORY.md tail is a bounded read: byte-identical to slicing the whole file,
// and the store is asked for the window only.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createWorkspaceBundle, createMemoryMemory } from './helpers';
import { readMemoryTail, MEMORY_TAIL_MAX_CHARS } from '../src/memory/note';
import type { WorkspaceVFS } from '../src/vfs/nimbus-workspace';

/** The file as the agent's shell and the owner's Files view address it; the product names it relative to the workspace. */
const PATH = '/home/user/memory/MEMORY.md';

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
    // N UTF-16 units span at most 3N UTF-8 bytes; one extra line is the allowed slack.
    expect(bytesRead()).toBeLessThanOrEqual(MEMORY_TAIL_MAX_CHARS * 3 + line.length);
  });

  test('the ranged tail is the whole-file tail at every bound', async () => {
    // Multi-byte and astral characters so window starts land inside code points.
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
