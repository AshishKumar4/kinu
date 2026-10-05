// One reading of a written path: `root://path`, `~`, relative and absolute, and the reference a person reads back.
import { describe, expect, test } from 'bun:test';
import {
  cloudPlanes, findPlaneReferences, formatPath, localPlanes, referencePrefixes, RESERVED_ROOTS, resolvePath, shellReference,
  type PathPlanes,
} from '../src/vfs/resolve';
import { deviceMountSegment } from '../src/execution/device-tunnel-executor';
import type { DeviceFleetEntry } from '../src/execution/device-status';

const CF = cloudPlanes('/home/main');

const CLI = localPlanes({ space: '/home/ana/.kinu/acme', folder: '/home/ana/acme', home: '/home/ana', views: ['skills'] });

describe('a written path resolves to the machine path its plane serves', () => {
  test('every root: the own space, the container and a device on the cloud; the own space and the folder locally', () => {
    const cases: Array<[PathPlanes, string, string | null, string]> = [
      [CF, 'vfs://home/main/report.txt', 'vfs', '/home/main/report.txt'],
      [CF, 'vfs://', 'vfs', '/'],
      [CF, 'sandbox://workspace/build.log', 'sandbox', '/sandbox/workspace/build.log'],
      [CF, 'ashish@studio://home/dev/a.txt', 'ashish@studio', '/pc/ashish@studio/home/dev/a.txt'],
      [CLI, 'vfs://slates/board/index.ts', 'vfs', '/home/ana/.kinu/acme/slates/board/index.ts'],
      [CLI, 'local://src/app.ts', 'local', '/home/ana/acme/src/app.ts'],
      [CLI, 'local:///src//./app.ts', 'local', '/home/ana/acme/src/app.ts'],
    ];

    for (const [planes, written, plane, absolute] of cases) expect(resolvePath(written, planes)).toEqual({ plane, absolute });
  });

  test('a plain path is the machine\'s: relative from cwd, `~` from the home, absolute as it is', () => {
    expect(resolvePath('notes/a.md', CF)).toEqual({ plane: 'vfs', absolute: '/home/main/notes/a.md' });
    expect(resolvePath('', CF)).toEqual({ plane: 'vfs', absolute: '/home/main' });
    expect(resolvePath('~', CLI)).toEqual({ plane: null, absolute: '/home/ana' });
    expect(resolvePath('~/notes/../a.md', CLI)).toEqual({ plane: null, absolute: '/home/ana/a.md' });
    expect(resolvePath('src/../README.md', CLI)).toEqual({ plane: 'local', absolute: '/home/ana/acme/README.md' });
    expect(resolvePath('/etc/hosts', CLI)).toEqual({ plane: null, absolute: '/etc/hosts' });
    expect(resolvePath('~other/x', CF)).toEqual({ plane: 'vfs', absolute: '/home/main/~other/x' });
  });

  test('a reference never climbs above its root, and a plane this workspace lacks is refused by name', () => {
    expect(() => resolvePath('vfs://../etc/passwd', CLI)).toThrow(expect.objectContaining({ code: 'EPERM' }));
    expect(() => resolvePath('local://src/../../x', CLI)).toThrow(expect.objectContaining({ code: 'EPERM' }));
    expect(() => resolvePath('sandbox://x', CLI)).toThrow('sandbox:// is no prefix here; this workspace\'s are vfs://, local://');
    expect(() => resolvePath('pc://studio/x', CF)).toThrow('pc:// is no prefix here; this workspace\'s are vfs://, local://, sandbox://, <device>://');
    expect(() => resolvePath('https://example.com/a', CF)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});

describe('a machine path formats to the reference of the plane that holds it', () => {
  test('the shortest prefix wins; a device is named by its segment; outside every subtree stays a machine path', () => {
    const cases: Array<[PathPlanes, string, string]> = [
      [CF, '/home/main/report.txt', 'vfs://home/main/report.txt'],
      [CF, '/sandbox', 'sandbox://'],
      [CF, '/pc/ashish@studio', 'ashish@studio://'],
      [CF, '/pc/dev-rig/etc/hosts', 'dev-rig://etc/hosts'],
      [CF, '/pc', 'vfs://pc'],
      [CLI, '/home/ana/acme/src/app.ts', 'local://src/app.ts'],
      [CLI, '/home/ana/.kinu/acme/home/main/n.md', 'vfs://home/main/n.md'],
      [CLI, '/etc/hosts', '/etc/hosts'],
    ];

    for (const [planes, absolute, reference] of cases) expect(formatPath(absolute, planes)).toBe(reference);
  });

  test('a reference reads back to the path it was printed from', () => {
    for (const [planes, absolute] of [[CF, '/pc/dev-rig/x'], [CF, '/sandbox/w/a'], [CLI, '/home/ana/acme/a'], [CLI, '/home/ana/.kinu/acme/slates/s']] as const) {
      expect(resolvePath(formatPath(absolute, planes), planes).absolute).toBe(absolute);
    }
  });

  test('a reserved name never becomes a device root, and the fleet mounts such a machine under its id', () => {
    expect(formatPath('/pc/sandbox/x', CF)).toBe('vfs://pc/sandbox/x');

    for (const name of ['local', 'pc', 'https']) {
      const named: DeviceFleetEntry = { id: 'dev-9', name, os: 'linux', hostname: 'l', connected: true };
      expect(deviceMountSegment(named, [named])).toBe('dev-9');
    }
  });

  // Release review, 2026-10-05: a machine named "Work Laptop" printed as Work Laptop://x, which reads back as a relative path.
  test('a machine whose name no prefix can carry is mounted under its id, and every reference to it reads back', () => {
    for (const name of ['Work Laptop', 'ashish:mac', 'tab\there']) {
      const named: DeviceFleetEntry = { id: 'dev-9', name, os: 'linux', hostname: 'l', connected: true };
      expect(deviceMountSegment(named, [named])).toBe('dev-9');
    }

    const spaced = '/pc/Work Laptop/home/user/report.txt';
    expect(formatPath(spaced, CF)).toBe('vfs://pc/Work Laptop/home/user/report.txt');
    expect(resolvePath(formatPath(spaced, CF), CF).absolute).toBe(spaced);
  });
});

describe('a shell takes its machine\'s paths', () => {
  test('a reference to a plane is refused with its real path; a view has none; any other word passes', () => {
    expect(shellReference('vfs://slates/board/index.ts', CLI)).toBe('the shell takes this machine\'s paths: vfs://slates/board/index.ts is /home/ana/.kinu/acme/slates/board/index.ts here');
    expect(shellReference('local://src/a.ts', CLI)).toContain('is /home/ana/acme/src/a.ts here');
    expect(shellReference('vfs://skills/slates/SKILL.md', CLI)).toBe('vfs://skills/slates/SKILL.md is in the skills view, which the file tool and workspace.* read; the shell has no path for it');
    expect(shellReference('sandbox://w/a', CF)).toContain('is /sandbox/w/a here');
    expect(shellReference('vfs://../x', CLI)).toContain('names no file');

    for (const word of ['https://example.com', 'postgres://db/app', 'notes/vfs://x', 'sandbox://x', '/etc/hosts']) {
      expect(shellReference(word, CLI)).toBeNull();
    }
  });
});

// 2026-10-04: chat named files as plain text. A reference to one of the workspace's planes is found in prose to be
// linked; any other scheme, and the punctuation that ends a sentence, is not part of it.
describe('a reference in prose', () => {
  test('is found by its root, without the sentence punctuation after it', () => {
    const text = 'Wrote vfs://home/main/report.md, see (sandbox://w/build.log). Not postgres://db/x, https://x.io or avfs://y.';

    expect(findPlaneReferences(text, ['vfs', 'sandbox'])).toEqual([
      { index: 6, reference: 'vfs://home/main/report.md' },
      { index: 38, reference: 'sandbox://w/build.log' },
    ]);
    expect(findPlaneReferences('vfs:// alone, and vfs://a/b/', ['vfs'])).toEqual([
      { index: 0, reference: 'vfs://' },
      { index: 18, reference: 'vfs://a/b/' },
    ]);
    expect(findPlaneReferences('ashish@studio://home/x.', ['ashish@studio'])).toEqual([{ index: 0, reference: 'ashish@studio://home/x' }]);
    expect(findPlaneReferences('local://a', [])).toEqual([]);
  });
});

// 2026-10-04: `vfs://` is the one tree an agent sees, and every other prefix is an alias for a subtree of it. The cloud's
// `local://` was refused, and a local `vfs://local/x` named the own space rather than the folder.
describe('every prefix is an alias for a vfs:// subtree', () => {
  test('on both backends, each prefix and its vfs:// long form name the same file, and the shorter is printed', () => {
    const cases: Array<[PathPlanes, string, string, string]> = [
      [CF, 'local://home/main/a.md', 'vfs://home/main/a.md', '/home/main/a.md'],
      [CF, 'sandbox://w/build.log', 'vfs://sandbox/w/build.log', '/sandbox/w/build.log'],
      [CF, 'studio://home/dev/a.txt', 'vfs://pc/studio/home/dev/a.txt', '/pc/studio/home/dev/a.txt'],
      [CLI, 'local://src/app.ts', 'vfs://local/src/app.ts', '/home/ana/acme/src/app.ts'],
    ];

    for (const [planes, short, long, absolute] of cases) {
      expect(resolvePath(short, planes).absolute).toBe(absolute);
      expect(resolvePath(long, planes).absolute).toBe(absolute);
      expect(formatPath(absolute, planes)).toBe(planes === CF && short.startsWith('local://') ? long : short);
      expect(findPlaneReferences(`${short} and ${long}`, referencePrefixes(planes, ['studio'])).map(({ reference }) => reference)).toEqual([short, long]);
    }

    expect(formatPath('/home/ana/acme', CLI)).toBe('local://');
    expect(resolvePath('vfs://home/main/n.md', CLI).absolute).toBe('/home/ana/.kinu/acme/home/main/n.md');
  });

  test('a prefix the table gains resolves, prints, links, is refused by the shell and is no machine name, with no other edit', () => {
    const drive = { prefix: 'drive', subtree: '/shared' };
    const planes = { ...CF, prefixes: [...CF.prefixes, drive] };

    expect(resolvePath('drive://a/b.md', planes).absolute).toBe('/shared/a/b.md');
    expect(resolvePath('vfs://shared/a/b.md', planes).absolute).toBe('/shared/a/b.md');
    expect(formatPath('/shared/a/b.md', planes)).toBe('drive://a/b.md');
    expect(referencePrefixes(planes)).toContain('drive');
    expect(shellReference('drive://a/b.md', planes)).toBe('the shell takes this machine\'s paths: drive://a/b.md is /shared/a/b.md here');
    // Every row of the table, and the subtree machines mount under, is a name no machine takes.
    expect(RESERVED_ROOTS).toEqual(expect.arrayContaining(['vfs', 'local', 'sandbox', 'pc']));
  });

  test('a machine is linked by its own name only when it is one, never any scheme', () => {
    expect(referencePrefixes(CF, ['studio', 'https', 'local'])).toEqual(['vfs', 'local', 'sandbox', 'studio']);
    expect(referencePrefixes(CLI, ['studio'])).toEqual(['vfs', 'local']);
    expect(shellReference('postgres://db/app', CF)).toBeNull();
  });
});
