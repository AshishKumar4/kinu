// Byte fidelity under bun:sqlite: the store binds BLOBs the Cloudflare-DO way (ArrayBuffer) while bun:sqlite binds
// TypedArrays only and returns Uint8Array. Guards the runtime's coercion on both sides.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { createCLIRuntime, localTransactions, nimbusSql } from '../src/runtime';
import { scratchPath } from '@kinu.run/test-utils';

function freshVfs() {
  const db = new Database(scratchPath('vfs-blob', 'agent.db'), { create: true });

  const rt = createCLIRuntime(db, {
    dbPath: db.filename,
    llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
  });

  return rt.storage.vfs;
}

describe('workspace filesystem byte round-trip (bun:sqlite)', () => {
  test('utf8 text (incl. multibyte) round-trips', async () => {
    const vfs = freshVfs();
    await vfs.writeFile('a.md', 'hello — world 🚀 ✦');
    expect(await vfs.readFile('a.md', { encoding: 'utf8' })).toBe('hello — world 🚀 ✦');
  });

  test('binary bytes round-trip exactly', async () => {
    const vfs = freshVfs();
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64, 0, 7]);
    await vfs.writeFile('blob.bin', bytes);
    const back = await vfs.readFile('blob.bin');
    expect(back instanceof Uint8Array ? Array.from(back) : []).toEqual(Array.from(bytes));
  });

  test('large content spanning multiple chunks round-trips', async () => {
    const vfs = freshVfs();
    const big = 'x'.repeat(200_000) + 'END';
    await vfs.writeFile('big.txt', big);
    expect(await vfs.readFile('big.txt', { encoding: 'utf8' })).toBe(big);
  });

  test('recursive mkdir + readdir lists written files', async () => {
    const vfs = freshVfs();
    await vfs.mkdir('skills', { recursive: true });
    await vfs.writeFile('skills/one.md', 'a');
    await vfs.writeFile('skills/two.md', 'b');
    expect((await vfs.readdir('skills')).sort()).toEqual(['one.md', 'two.md']);
  });
});

describe('workspace filesystem over a read-only handle', () => {
  // Core writes each schema row only when absent (core 0.12.0 `src/vfs/sqlite-vfs.ts:781`, `:792`, `:937`, `:1014`, `:1047`);
  // each guard is load-bearing on its own, see docs/DEVBOX-DECISIONS.md D21, D22 and D23-N.
  test('a current filesystem opens read-only and reads what a writer left', async () => {
    const path = scratchPath('vfs-readonly', 'agent.db');
    const writer = new Database(path, { create: true });

    await new SqliteVFS(nimbusSql(writer), localTransactions(writer)).as(CRED_KERNEL).writeFile('/note.txt', 'kept');
    writer.close();

    const reader = new Database(path, { readonly: true });

    try {
      const vfs = new SqliteVFS(nimbusSql(reader), localTransactions(reader)).as(CRED_KERNEL);

      expect(new TextDecoder().decode(await vfs.readFile('/note.txt'))).toBe('kept');
    } finally {
      reader.close();
    }
  });
});
