// Kinu's two uses of Nimbus's namespace that carry its own rules: a head's writes heard where they land
// (observeNamespace over `observeWrites`), and the path a gate decides on (`resolve` over `route`).
import { describe, expect, test } from 'bun:test';
import { CompositeVFS } from '@nimbus-sh/core/vfs/composite.js';
import { MemoryVFS } from '@nimbus-sh/core/vfs/memory.js';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { observeNamespace, type WriteEvent } from '../src/vfs/write-events';
import { withMountTable } from '../src/vfs/mounts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const text = (value: string | Uint8Array | null | undefined): string | null | undefined => (value instanceof Uint8Array ? new TextDecoder().decode(value) : value);

describe('observeNamespace', () => {
  function watched(needsBaseline = true, mine = () => true) {
    const plane = new CompositeVFS(new MemoryVFS());
    const events: Array<{ path: string; before?: string | null; after: string | null; unread?: WriteEvent['unread'] }> = [];

    observeNamespace(plane, {
      needsBaseline: () => needsBaseline,
      record: ({ path, before, after, unread }) => {
        events.push({ path, ...(before !== undefined && { before: text(before) ?? null }), after: text(after) ?? null, ...(unread !== undefined && { unread }) });
      },
    }, mine);

    return { plane, events };
  }

  test('a write over a file reports its old bytes, a new file reports null, and a removal reports what went', async () => {
    const { plane, events } = watched();
    await writeText(plane, '/a.txt', 'one');
    await writeText(plane, '/a.txt', 'two');
    await plane.unlink('/a.txt');

    expect(events).toEqual([
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

    expect(events).toEqual([
      { path: '/from.txt', before: 'moved', after: null },
      { path: '/to.txt', before: null, after: 'moved' },
    ]);
  });

  // A head's report asks no baseline for a name it already touched, yet the name a rename fills still holds bytes.
  test('a rename between names the observer stopped asking about still reports the bytes that moved', async () => {
    const { plane, events } = watched(false);
    await writeText(plane, '/a.txt', 'kept');
    await writeText(plane, '/b.txt', 'gone');
    await plane.unlink('/b.txt');
    events.length = 0;
    await plane.rename('/a.txt', '/b.txt');

    expect(events).toEqual([{ path: '/a.txt', after: null }, { path: '/b.txt', after: 'kept' }]);
  });

  test('a write that fails reports nothing, and neither does a directory made or removed', async () => {
    const { plane, events } = watched();
    plane.mount('/ro', new MemoryVFS(), { readOnly: true });

    await expect(plane.writeFile('/ro/x', bytes('x'))).rejects.toMatchObject({ code: 'EROFS' });
    await expect(plane.unlink('/absent.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    await plane.mkdir('/dir/deeper', { recursive: true });
    await plane.rmdir('/dir/deeper');
    expect(events).toEqual([]);
  });

  test('only the views it names are heard', async () => {
    const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
    const { plane, events } = watched(true, () => false);
    await plane.as(cred).writeFile('/tmp-a', bytes('x'));

    expect(events).toEqual([]);
  });
});

describe('withMountTable resolve', () => {
  // A link in one backend can lead into another mount: a gate that judges the lexical path judges the wrong one.
  test('follows a root link into a mount, keeps the last link when asked, and lets missing directories pass as named', async () => {
    const namespace = new CompositeVFS(new MemoryVFS());

    namespace.mount('/pc', new MemoryVFS(), { resolvesPaths: true });

    const plane = withMountTable({ namespace: async () => namespace, home: '/home/main' }, [
      { name: 'pc', files: () => null, absentReason: () => 'no device', filesOwner: 'user' },
    ]);

    await namespace.mkdir('/home/main', { recursive: true });
    await namespace.symlink('/pc/laptop', '/home/main/pc-link');

    expect(await plane.resolve('/home/main/pc-link/notes.md')).toBe('/pc/laptop/notes.md');
    expect(await plane.resolve('/home/main/pc-link', { follow: false })).toBe('/home/main/pc-link');
    expect(await plane.resolve('/home/main/missing/deeper/new.txt')).toBe('/home/main/missing/deeper/new.txt');
    expect(await plane.resolve('/home/main/pc-link/missing/new.txt')).toBe('/pc/laptop/missing/new.txt');
  });

  // A write makes its parents through a link whose target is not there yet: the gate must judge where it lands.
  test('a link whose target is not there yet is followed to where the write would land', async () => {
    const namespace = new CompositeVFS(new MemoryVFS());
    const plane = withMountTable({ namespace: async () => namespace, home: '/home/main' }, []);

    await namespace.mkdir('/home/main', { recursive: true });
    await namespace.mkdir('/outside', { recursive: true });
    await namespace.symlink('/outside/missing/deeper', '/home/main/link');
    await namespace.symlink('relative/target', '/home/main/near');

    expect(await plane.resolve('/home/main/link/file.txt')).toBe('/outside/missing/deeper/file.txt');
    expect(await plane.resolve('/home/main/link/a/b.txt')).toBe('/outside/missing/deeper/a/b.txt');
    expect(await plane.resolve('/home/main/near/file.txt')).toBe('/home/main/relative/target/file.txt');
    expect(await plane.resolve('/home/main/link', { follow: false })).toBe('/home/main/link');
  });
});
