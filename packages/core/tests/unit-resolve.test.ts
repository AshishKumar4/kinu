// One reading of a written path: `root://path`, `~`, relative and absolute, and the reference a person reads back.
import { describe, expect, test } from 'bun:test';
import { cloudPlanes, formatPath, resolvePath, type PathPlanes } from '../src/vfs/resolve';
import { deviceMountSegment } from '../src/execution/device-tunnel-executor';
import type { DeviceFleetEntry } from '../src/execution/device-status';

const CF = cloudPlanes('/home/main');

const CLI: PathPlanes = {
  cwd: '/home/ana/acme', home: '/home/ana', devices: null,
  roots: [{ root: 'vfs', at: '/home/ana/.kinu/acme' }, { root: 'local', at: '/home/ana/acme' }],
};

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
    expect(() => resolvePath('sandbox://x', CLI)).toThrow('sandbox:// is no plane here; this workspace\'s are vfs://, local://');
    expect(() => resolvePath('pc://studio/x', CF)).toThrow('pc:// is no plane here; this workspace\'s are vfs://, sandbox://, <device>://');
    expect(() => resolvePath('https://example.com/a', CF)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});

describe('a machine path formats to the reference of the plane that holds it', () => {
  test('the deepest root wins; a device is named by its segment; outside every root stays a machine path', () => {
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
});
