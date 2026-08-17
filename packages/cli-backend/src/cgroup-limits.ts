/**
 * What this process is REALLY allowed to use — read from its own cgroup.
 *
 * `nproc`, `/proc/cpuinfo` and `free` report the machine, not the container.
 * A benchmark task died exactly there: the agent ran `make -j$(nproc)` inside a
 * 1-CPU / 2GB cgroup, `nproc` answered with the host's core count, and the
 * compilers OOM-killed the build. Doctrine alone cannot fix that — the honest
 * number has to be in front of the model. This reads it once per session and
 * hands it to the executors whose processes actually live under that cgroup;
 * the prompt renders it in the live execution-status block.
 *
 * Honest or silent, never a guess: an unlimited controller (`max`, a negative
 * v1 quota, the v1 no-limit sentinel) or an unreadable one yields nothing at
 * all, so a bare-metal run says nothing rather than reporting the host as a
 * "limit".
 *
 * Both hierarchies, and both container shapes. With a cgroup namespace (the
 * usual container) `/proc/self/cgroup` reads `0::/` and the limits sit at the
 * mount root; without one it reads the path the process occupies inside the
 * host's hierarchy, so that path is tried first and the mount root second.
 */

import { readFileSync } from 'node:fs';
import type { ResourceLimits } from '@proteus/core';
import { tolerate } from '@proteus/core/obs';

export interface CgroupSource {
  /** cgroupfs mount point. */
  root?: string;
  /** The process's own place in the hierarchy. */
  procSelfCgroup?: string;
}

const DEFAULT_ROOT = '/sys/fs/cgroup';
const DEFAULT_PROC_SELF = '/proc/self/cgroup';

/** memory.limit_in_bytes on an unlimited v1 cgroup is a page-aligned INT64_MAX
 *  rather than a sentinel word — anything near it means "no limit". */
const V1_UNLIMITED_FLOOR = 2 ** 62;

function read(path: string): string | null {
  return tolerate(() => readFileSync(path, 'utf8'), 'enoent')?.trim() ?? null;
}

/**
 * The process's path within one hierarchy, from `/proc/self/cgroup`:
 * `0::/some/path` for v2, `7:cpu,cpuacct:/some/path` for a v1 controller.
 * Empty string when it is the root or absent; an unreadable one propagates.
 */
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

/** Directories to try for one controller, most specific first. */
function candidates(base: string, self: string): string[] {
  return self ? [`${base}${self}`, base] : [base];
}

/** `cpu.max` is "<quota|max> <period>"; v1 splits it across two files. Quota
 *  over period is CPUs, rounded UP to a whole worker: a 0.5-CPU cgroup still
 *  runs one job, and CPU quota throttles rather than kills, so the rounding
 *  costs latency at worst — where rounding DOWN would waste the cap outright. */
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

/** The cgroup limits in force here, or null when the environment declares none. */
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

/** The host cgroup's limits, read at most once per process — a container's
 *  limits do not change under it, and a turn must not pay the file reads to
 *  re-learn that. */
export function hostResourceLimits(): ResourceLimits | null {
  if (memoized === undefined) memoized = readCgroupLimits();
  return memoized;
}
