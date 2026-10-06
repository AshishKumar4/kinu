// Kinu's local patch of @nimbus-sh/core (NIMBUS-ASKS #23 and #24): CompositeVFS says where a path lands, and tells
// an observer what each landed write replaced. Both go when Nimbus ships them; these cases are the asks' own.
import { describe, expect, test } from 'bun:test';
import { CompositeVFS, type CompositeWriteEvent } from '@nimbus-sh/core/vfs/composite.js';
import { MemoryVFS } from '@nimbus-sh/core/vfs/memory.js';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const text = (value: Uint8Array | null | undefined): string | null | undefined => (value instanceof Uint8Array ? new TextDecoder().decode(value) : value);

describe('routeOf', () => {
  test('names the mount, the backend and the path asked of it, after lexical ..', () => {
    const root = new MemoryVFS();
    const device = new MemoryVFS();
    const plane = new CompositeVFS(root);
    plane.mount('/pc', device, { resolvesPaths: true });

    expect(plane.routeOf('/pc/a/../b')).toEqual({ point: '/pc', path: '/b', source: device, readOnly: false });
    expect(plane.routeOf('/home/x')).toEqual({ point: '/', path: '/home/x', source: root, readOnly: false });
  });

  test('an absent source answers null with its mount\'s reason, and a read-only mount says so', () => {
    const plane = new CompositeVFS(new MemoryVFS());
    plane.mount('/pc', () => null, { resolvesPaths: true, absentReason: () => 'no device connected' });
    plane.mount('/skills', new MemoryVFS(), { readOnly: true });

    expect(plane.routeOf('/pc/x')).toMatchObject({ point: '/pc', source: null, absentReason: expect.stringContaining('no device connected') });
    expect(plane.routeOf('/skills/a.md')).toMatchObject({ point: '/skills', readOnly: true });
  });
});

describe('observeWrites', () => {
  function watched(needsBaseline = true) {
    const plane = new CompositeVFS(new MemoryVFS());
    const events: Array<Omit<CompositeWriteEvent, 'before' | 'after'> & { before?: string | null; after: string | null }> = [];

    plane.observeWrites({
      needsBaseline: () => needsBaseline,
      record: ({ before, after, ...rest }) => {
        const event: (typeof events)[number] = { ...rest, after: text(after) ?? null };

        if (before !== undefined) event.before = text(before) ?? null;
        events.push(event);
      },
    });

    return { plane, events };
  }

  test('a write over a file reports its old bytes, a new file reports null, and a removal reports what went', async () => {
    const { plane, events } = watched();
    await writeText(plane, '/a.txt', 'one');
    await writeText(plane, '/a.txt', 'two');
    await plane.unlink('/a.txt');

    expect(events.map(({ path, before, after }) => ({ path, before, after }))).toEqual([
      { path: '/a.txt', before: null, after: 'one' },
      { path: '/a.txt', before: 'one', after: 'two' },
      { path: '/a.txt', before: 'two', after: null },
    ]);
  });

  test('a rename reports both paths, and the bytes that moved', async () => {
    const { plane, events } = watched();
    await writeText(plane, '/from.txt', 'moved');
    events.length = 0;
    await plane.rename('/from.txt', '/to.txt');

    expect(events.map(({ path, before, after }) => ({ path, before, after }))).toEqual([
      { path: '/from.txt', before: 'moved', after: null },
      { path: '/to.txt', before: null, after: 'moved' },
    ]);
  });

  test('a write that fails, or loses its revision, reports nothing', async () => {
    const { plane, events } = watched();
    plane.mount('/ro', new MemoryVFS(), { readOnly: true });

    await expect(plane.writeFile('/ro/x', bytes('x'))).rejects.toMatchObject({ code: 'EROFS' });
    await expect(plane.unlink('/absent.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events).toEqual([]);
  });

  test('each event names the principal whose view wrote it; an unasked baseline is not read', async () => {
    const { plane, events } = watched(false);
    const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
    await plane.as(cred).writeFile('/tmp-a', bytes('x'));

    expect(events).toEqual([{ path: '/tmp-a', after: 'x', principal: { cred } }]);
  });
});
