/**
 * A save is conditioned on what was read on every plane: one that checks neither a revision nor a digest itself (a
 * hosted session's) has what it holds compared here first, so a stale read is refused, never written over.
 */
import { describe, expect, test } from 'bun:test';
import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { writeConditionally } from '../src/vfs/conditional-write';
import { sha256Hex } from '../src/safety/argument-digest';

const bytes = (text: string) => new TextEncoder().encode(text);

/** A plane with no revision or digest check of its own, as a hosted session's file plane is. */
const uncheckedPlane = () => createMemoryVfs().vfs;

// 2026-10-12 security review: such a plane wrote over whatever was there, and the editor reported ok.
describe('a plane that checks nothing itself', () => {
  test('refuses a write over bytes that changed since they were read, and keeps them', async () => {
    const plane = uncheckedPlane();
    await writeText(plane, '/notes.md', 'read by the agent');
    const read = await plane.readFile('/notes.md');
    await writeText(plane, '/notes.md', 'saved by the owner');

    await expect(writeConditionally(plane, '/notes.md', bytes('the agent\'s rewrite'), { kind: 'read', bytes: read }))
      .rejects.toMatchObject({ verdict: 'stale' });
    expect(await readText(plane, '/notes.md')).toBe('saved by the owner');
  });

  test('refuses an editor\'s stale digest, and writes over the digest it was shown', async () => {
    const plane = uncheckedPlane();
    await writeText(plane, '/notes.md', 'saved by the owner');

    await expect(writeConditionally(plane, '/notes.md', bytes('from a stale tab'), { kind: 'digest', sha256: sha256Hex(bytes('an older save')) }))
      .rejects.toMatchObject({ verdict: 'stale' });
    expect(await readText(plane, '/notes.md')).toBe('saved by the owner');
    await writeConditionally(plane, '/notes.md', bytes('from the current tab'), { kind: 'digest', sha256: sha256Hex(bytes('saved by the owner')) });
    expect(await readText(plane, '/notes.md')).toBe('from the current tab');
  });

  test('refuses a create where a file already is', async () => {
    const plane = uncheckedPlane();
    await writeText(plane, '/notes.md', 'already here');

    await expect(writeConditionally(plane, '/notes.md', bytes('new'), { kind: 'absent' })).rejects.toMatchObject({ verdict: 'stale' });
    expect(await readText(plane, '/notes.md')).toBe('already here');
    await writeConditionally(plane, '/fresh.md', bytes('new'), { kind: 'absent' });
    expect(await readText(plane, '/fresh.md')).toBe('new');
  });
});
