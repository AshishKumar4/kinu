// Byte fidelity of the workspace filesystem under bun:sqlite. The store binds
// BLOBs the Cloudflare-DO way (ArrayBuffer) while bun:sqlite binds TypedArrays
// only and returns BLOBs as Uint8Array, so without the runtime's coercion every
// local file write/read silently failed. Guards the coercion on both sides.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createCLIRuntime } from '../src/runtime.js';
import { scratchPath } from '@proteus/test-utils';

function freshVfs() {
  const db = new Database(':memory:');
  const rt = createCLIRuntime(db, {
    dbPath: scratchPath('vfs-blob', 'agent.db'),
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
