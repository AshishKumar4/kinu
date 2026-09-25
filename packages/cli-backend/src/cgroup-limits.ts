/**
 * Resource limits from this process's own cgroup: `nproc`/`free` report the host, not the container.
 * Unlimited or unreadable controllers yield nothing rather than a guess. v1 and v2, with or without
 * a cgroup namespace: the process's own path is tried before the mount root.
 */

import { readFileSync } from 'node:fs';
import type { ResourceLimits } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';

interface CgroupSource {
  root?: string;
  procSelfCgroup?: string;
}

const DEFAULT_ROOT = '/sys/fs/cgroup';

const DEFAULT_PROC_SELF = '/proc/self/cgroup';

/** An unlimited v1 memory.limit_in_bytes is a page-aligned INT64_MAX, not a sentinel word. */
const V1_UNLIMITED_FLOOR = 2 ** 62;

function read(path: string): string | null {
  return tolerate(() => readFileSync(path, 'utf8'), 'enoent')?.trim() ?? null;
}

/** The process's path from `/proc/self/cgroup` (`0::/p` v2, `7:cpu,cpuacct:/p` v1); empty for root or absent. */
function selfPath(procSelfCgroup: string, controller: string | null): string {
  const content = read(procSelfCgroup);

  if (content === null) return '';

  for (const line of content.split('\n')) {
    const [, controllers, path] = line.split(':');

    if (path === undefined || path === '/') continue;
    const names = (controllers ?? '').split(',').filter(Boolean);
    const matches = controller === null ? names.length === 0 : names.includes(controller);

    if (matches) return path;
  }

  return '';
}

function candidates(base: string, self: string): string[] {
  return self ? [`${base}${self}`, base] : [base];
}

/** Quota over period, rounded up: a 0.5-CPU cgroup still runs one job, and CPU quota throttles rather than kills. */
function parseCpus(quota: string | undefined, period: string | undefined): number | undefined {
  const q = Number(quota);
  const p = Number(period);

  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return undefined;

  return Math.ceil(q / p);
}

function parseMemory(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const bytes = Number(raw);

  if (!Number.isFinite(bytes) || bytes <= 0 || bytes >= V1_UNLIMITED_FLOOR) return undefined;

  return bytes;
}

function readCpus(root: string, procSelfCgroup: string): number | undefined {
  for (const dir of candidates(root, selfPath(procSelfCgroup, null))) {
    const unified = read(`${dir}/cpu.max`);

    if (unified !== null) {
      const [quota, period] = unified.split(/\s+/);

      return parseCpus(quota, period);
    }
  }

  // v1: quota and period must come from the SAME controller directory.
  for (const dir of candidates(`${root}/cpu`, selfPath(procSelfCgroup, 'cpu'))) {
    const quota = read(`${dir}/cpu.cfs_quota_us`);
    const period = read(`${dir}/cpu.cfs_period_us`);

    if (quota !== null && period !== null) return parseCpus(quota, period);
  }

  return undefined;
}

function readMemory(root: string, procSelfCgroup: string): number | undefined {
  for (const dir of candidates(root, selfPath(procSelfCgroup, null))) {
    const unified = read(`${dir}/memory.max`);

    if (unified !== null) return parseMemory(unified);
  }

  for (const dir of candidates(`${root}/memory`, selfPath(procSelfCgroup, 'memory'))) {
    const v1 = read(`${dir}/memory.limit_in_bytes`);

    if (v1 !== null) return parseMemory(v1);
  }

  return undefined;
}

export function readCgroupLimits(source: CgroupSource = {}): ResourceLimits | null {
  const root = source.root ?? DEFAULT_ROOT;
  const procSelfCgroup = source.procSelfCgroup ?? DEFAULT_PROC_SELF;
  const cpus = readCpus(root, procSelfCgroup);
  const memBytes = readMemory(root, procSelfCgroup);

  if (cpus === undefined && memBytes === undefined) return null;

  if (cpus !== undefined && memBytes !== undefined) return { cpus, memBytes };

  if (cpus !== undefined) return { cpus };

  if (memBytes !== undefined) return { memBytes };

  return null;
}

let memoized: ResourceLimits | null | undefined;

/** Read at most once per process; a container's limits do not change under it. */
export function hostResourceLimits(): ResourceLimits | null {
  if (memoized === undefined) memoized = readCgroupLimits();

  return memoized;
}
