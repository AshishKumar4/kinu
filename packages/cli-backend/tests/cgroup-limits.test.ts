// Behaviour tests for the cgroup reader — the truth `nproc` cannot tell the
// model. A benchmark task OOM-died running `make -j$(nproc)` in a 1-CPU/2GB
// container, so what matters here is (a) both hierarchies are actually read,
// and (b) an environment with no limit says NOTHING rather than guessing.
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCgroupLimits } from '../src/cgroup-limits';

const roots: string[] = [];

/** A cgroupfs fixture: paths relative to the mount, contents verbatim. */
function cgroupfs(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'proteus-cgroup-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

/** A /proc/self/cgroup fixture. Its own file, outside the mount. */
function procSelf(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'proteus-procself-'));
  roots.push(dir);
  const path = join(dir, 'cgroup');
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const NAMESPACED = '0::/\n';

describe('cgroup v2', () => {
  test('a 1-CPU / 2GB container reports exactly that', () => {
    const root = cgroupfs({
      'cpu.max': '100000 100000\n',
      'memory.max': `${2 * 1024 ** 3}\n`,
    });
    expect(readCgroupLimits({ root, procSelfCgroup: procSelf(NAMESPACED) }))
      .toEqual({ cpus: 1, memBytes: 2 * 1024 ** 3 });
  });

  test('a fractional quota still runs one worker — never zero', () => {
    const root = cgroupfs({ 'cpu.max': '50000 100000\n' });
    expect(readCgroupLimits({ root, procSelfCgroup: procSelf(NAMESPACED) })).toEqual({ cpus: 1 });
    // …and 2.5 CPUs rounds up too: quota throttles, so the cap is not wasted.
    const wide = cgroupfs({ 'cpu.max': '250000 100000\n' });
    expect(readCgroupLimits({ root: wide, procSelfCgroup: procSelf(NAMESPACED) })).toEqual({ cpus: 3 });
  });

  test('"max" is not a limit — an uncapped controller is simply absent', () => {
    const root = cgroupfs({ 'cpu.max': 'max 100000\n', 'memory.max': 'max\n' });
    expect(readCgroupLimits({ root, procSelfCgroup: procSelf(NAMESPACED) })).toBeNull();
  });

  test('one capped controller reports alone', () => {
    const root = cgroupfs({ 'cpu.max': 'max 100000\n', 'memory.max': `${512 * 1024 ** 2}\n` });
    expect(readCgroupLimits({ root, procSelfCgroup: procSelf(NAMESPACED) }))
      .toEqual({ memBytes: 512 * 1024 ** 2 });
  });

  test('without a cgroup namespace the limits are read at the process\'s own path', () => {
    // The mount root is the HOST's cgroup here (uncapped); the container's
    // real limits live at the path /proc/self/cgroup names.
    const root = cgroupfs({
      'cpu.max': 'max 100000\n',
      'memory.max': 'max\n',
      'docker/abc123/cpu.max': '200000 100000\n',
      'docker/abc123/memory.max': `${4 * 1024 ** 3}\n`,
    });
    expect(readCgroupLimits({ root, procSelfCgroup: procSelf('0::/docker/abc123\n') }))
      .toEqual({ cpus: 2, memBytes: 4 * 1024 ** 3 });
  });
});

describe('cgroup v1', () => {
  test('quota/period and limit_in_bytes are read from the controller mounts', () => {
    const root = cgroupfs({
      'cpu/cpu.cfs_quota_us': '100000\n',
      'cpu/cpu.cfs_period_us': '100000\n',
      'memory/memory.limit_in_bytes': `${2 * 1024 ** 3}\n`,
    });
    expect(readCgroupLimits({ root, procSelfCgroup: procSelf('7:cpu,cpuacct:/\n9:memory:/\n') }))
      .toEqual({ cpus: 1, memBytes: 2 * 1024 ** 3 });
  });

  test('a -1 quota and the INT64_MAX memory sentinel are both "no limit"', () => {
    const root = cgroupfs({
      'cpu/cpu.cfs_quota_us': '-1\n',
      'cpu/cpu.cfs_period_us': '100000\n',
      'memory/memory.limit_in_bytes': '9223372036854771712\n',
    });
    expect(readCgroupLimits({ root, procSelfCgroup: procSelf('7:cpu:/\n9:memory:/\n') })).toBeNull();
  });

  test('a v1 process outside the root reads its own controller path', () => {
    const root = cgroupfs({
      'cpu/cpu.cfs_quota_us': '-1\n',
      'cpu/cpu.cfs_period_us': '100000\n',
      'cpu/docker/abc/cpu.cfs_quota_us': '400000\n',
      'cpu/docker/abc/cpu.cfs_period_us': '100000\n',
      'memory/docker/abc/memory.limit_in_bytes': `${1024 ** 3}\n`,
    });
    expect(readCgroupLimits({
      root, procSelfCgroup: procSelf('7:cpu,cpuacct:/docker/abc\n9:memory:/docker/abc\n'),
    })).toEqual({ cpus: 4, memBytes: 1024 ** 3 });
  });
});

describe('no cgroup at all', () => {
  test('an empty mount and a missing mount both report nothing', () => {
    expect(readCgroupLimits({ root: cgroupfs({}), procSelfCgroup: procSelf(NAMESPACED) })).toBeNull();
    expect(readCgroupLimits({
      root: '/nonexistent/cgroup', procSelfCgroup: '/nonexistent/proc/self/cgroup',
    })).toBeNull();
  });

  test('garbage never becomes a number', () => {
    const root = cgroupfs({ 'cpu.max': 'not a quota\n', 'memory.max': 'wat\n' });
    expect(readCgroupLimits({ root, procSelfCgroup: procSelf(NAMESPACED) })).toBeNull();
    const zero = cgroupfs({ 'cpu.max': '0 0\n', 'memory.max': '0\n' });
    expect(readCgroupLimits({ root: zero, procSelfCgroup: procSelf(NAMESPACED) })).toBeNull();
  });
});
