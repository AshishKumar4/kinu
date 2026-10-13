/**
 * A save is conditioned on what was read, on the plane itself: one that checks neither a revision nor a digest is
 * refused, and writes nothing.
 */
import { describe, expect, test } from 'bun:test';
import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { MemoryVFS } from '@nimbus-sh/core/vfs/memory.js';
import { writeConditionally, type ObservedFile } from '../src/vfs/conditional-write';
import { sha256Hex } from '../src/safety/argument-digest';

const bytes = (text: string) => new TextEncoder().encode(text);

// 2026-10-13: such a plane was read and compared here, then written in a second call, so a write between was lost.
describe('a plane that checks nothing itself', () => {
  test('refuses a save over what was read, an editor\'s digest and a create, and writes none of them', async () => {
    const plane = new MemoryVFS();
    await writeText(plane, '/notes.md', 'read by the agent');
    const read = await plane.readFile('/notes.md');
    const observed: readonly ObservedFile[] = [{ kind: 'read', bytes: read }, { kind: 'digest', sha256: sha256Hex(read) }];

    for (const what of observed) {
      await expect(writeConditionally(plane, '/notes.md', bytes('a rewrite'), what)).rejects.toMatchObject({ code: 'unsupported' });
    }

    await expect(writeConditionally(plane, '/fresh.md', bytes('new'), { kind: 'absent' })).rejects.toMatchObject({ code: 'unsupported' });
    expect([await readText(plane, '/notes.md'), await plane.stat('/fresh.md')]).toEqual(['read by the agent', null]);
  });
});
