// References: `root://path` over the live mount table; a reserved root is never a machine segment.
import { describe, expect, test } from 'bun:test';
import { formatReference, referenceRoots } from '../src/vfs/references';
import { deviceMountSegment } from '../src/execution/device-tunnel-executor';
import type { DeviceFleetEntry } from '../src/execution/device-status';

const CF = referenceRoots({ devices: ['ashish@studio', 'dev-rig'], sandbox: true, local: false });

const CLI = referenceRoots({ devices: [], sandbox: false, local: true });

describe('the roots are the live mount table', () => {
  test('the workspace, the container and each machine by its segment; local only where the machine is the workspace', () => {
    expect(CF.map((root) => [root.root, root.mount])).toEqual([
      ['vfs', '/'], ['sandbox', '/sandbox'], ['ashish@studio', '/pc/ashish@studio'], ['dev-rig', '/pc/dev-rig'],
    ]);
    expect(CLI.map((root) => [root.root, root.mount])).toEqual([['vfs', '/'], ['local', '/']]);
  });

  test('a reserved name never becomes a device root, and the fleet mounts such a machine under its id', () => {
    expect(referenceRoots({ devices: ['local', 'vfs', 'sandbox'], sandbox: false, local: false }).map((root) => root.root)).toEqual(['vfs']);

    const named: DeviceFleetEntry = { id: 'dev-9', name: 'local', os: 'linux', hostname: 'l', connected: true };
    expect(deviceMountSegment(named, [named])).toBe('dev-9');
  });
});

describe('a mounted path formats to the reference of the plane that serves it', () => {
  test('every root: the workspace, the container, each machine by its segment', () => {
    const cases: Array<[string, string]> = [
      ['/home/user/report.txt', 'vfs://home/user/report.txt'],
      ['/sandbox/workspace/build.log', 'sandbox://workspace/build.log'],
      ['/pc/ashish@studio/home/dev/a.txt', 'ashish@studio://home/dev/a.txt'],
      ['/pc/dev-rig/etc/hosts', 'dev-rig://etc/hosts'],
    ];

    for (const [mountPath, reference] of cases) expect(formatReference(mountPath, CF)).toBe(reference);
  });

  test('the longest live mount serves a path; the mount point alone is the plane\'s root', () => {
    expect(formatReference('/pc/ashish@studio', CF)).toBe('ashish@studio://');
    expect(formatReference('/pc/toaster/x', CF)).toBe('vfs://pc/toaster/x');
    expect(formatReference('/sandbox', CF)).toBe('sandbox://');
    expect(formatReference('home/user/x', CF)).toBe('vfs://home/user/x');
  });

  test('in the CLI the machine is the workspace: local names the directory', () => {
    expect(formatReference('/src/app.ts', CLI)).toBe(`${'local'}://src/app.ts`);
  });
});
