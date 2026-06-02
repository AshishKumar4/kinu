// SqliteFS BLOB round-trip under bun:sqlite. SqliteFS stores file data as BLOBs
// the Cloudflare-DO way (ArrayBuffer); bun:sqlite only BINDS TypedArrays and
// RETURNS BLOBs as Uint8Array, so without the runtime's coercion + the encoding's
// Uint8Array read-path, every local file write/read silently failed. Guards both.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createCLIRuntime } from '../src/runtime.js';

function freshVfs() {
  const db = new Database(':memory:');
  const rt = createCLIRuntime(db as never, {
    dbPath: `/tmp/proteus-vfs-${Math.floor(performance.now())}.db`,
    llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
  });
  return rt.storage.vfs;
}

describe('SqliteFS BLOB round-trip (bun:sqlite)', () => {
  test('utf8 text (incl. multibyte) round-trips', async () => {
    const vfs = freshVfs();
    await vfs.writeFile('/workspace/a.md', 'hello — world 🚀 ✦');
    expect(await vfs.readFile('/workspace/a.md', { encoding: 'utf8' })).toBe('hello — world 🚀 ✦');
  });

  test('binary bytes round-trip exactly', async () => {
    const vfs = freshVfs();
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64, 0, 7]);
    await vfs.writeFile('/workspace/blob.bin', bytes);
    const back = await vfs.readFile('/workspace/blob.bin');
    expect(back instanceof Uint8Array ? Array.from(back) : []).toEqual(Array.from(bytes));
  });

  test('large content spanning multiple chunks round-trips', async () => {
    const vfs = freshVfs();
    const big = 'x'.repeat(200_000) + 'END';
    await vfs.writeFile('/workspace/big.txt', big);
    expect(await vfs.readFile('/workspace/big.txt', { encoding: 'utf8' })).toBe(big);
  });

  test('recursive mkdir + readdir lists written files', async () => {
    const vfs = freshVfs();
    await vfs.mkdir('/workspace/skills', { recursive: true });
    await vfs.writeFile('/workspace/skills/one.md', 'a');
    await vfs.writeFile('/workspace/skills/two.md', 'b');
    expect((await vfs.readdir('/workspace/skills')).sort()).toEqual(['one.md', 'two.md']);
  });
});
