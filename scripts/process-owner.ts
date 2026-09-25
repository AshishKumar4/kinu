/**
 * One process named across time: the boot, the pid and the pid's start time. A reused pid or a
 * reboot reads as a process that has ended, so whatever a process leaves behind is judged by
 * whether its owner still runs, never by its age. The bench teardown manifests
 * (`fixtures/storage-matrix/cleanup.ts`) and the test scratch homes judge their owners with it.
 */
import { tolerate } from '@kinu.run/core/obs';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { SCRATCH_ROOT_PREFIX } from '../packages/test-utils/src/scratch';

export interface ProcessOwner {
  readonly bootId: string;
  readonly pid: number;
  readonly startTicks: number;
}

export const ProcessOwnerSchema = v.object({ bootId: v.string(), pid: v.number(), startTicks: v.number() });

/** This process; null where `/proc` cannot say. */
export function currentOwner(): ProcessOwner | null {
  const bootId = readBootId();
  const startTicks = processStartTicks(process.pid);

  return bootId === undefined || startTicks === undefined ? null : { bootId, pid: process.pid, startTicks };
}

/** True while the recorded process runs: same boot, and the pid still started at the same tick. */
export function ownerAlive(owner: ProcessOwner): boolean {
  return owner.bootId === readBootId() && processStartTicks(owner.pid) === owner.startTicks;
}

function readBootId(): string | undefined {
  return tolerate(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'), 'enoent')?.trim();
}

/** `/proc/<pid>/<name>`, or undefined once the process is gone: ENOENT after it exits, ESRCH when it exits mid-read. */
export function procFile(pid: number | string, name: string): string | undefined {
  return tolerate(() => tolerate(() => readFileSync(`/proc/${String(pid)}/${name}`, 'utf8'), 'esrch'), 'enoent');
}

/** Field 22 of `/proc/<pid>/stat`, counted after the parenthesised command name, which may hold
 *  spaces; undefined once the process is gone. */
export function processStartTicks(pid: number): number | undefined {
  const stat = procFile(pid, 'stat');

  return stat === undefined ? undefined : Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
}

/** Whether a process of `group` still runs; a zombie has ended and only waits for its parent to collect it. */
export function groupRuns(group: number): boolean {
  return readdirSync('/proc').some((pid) => {
    const stat = /^\d+$/u.test(pid) ? procFile(pid, 'stat') : undefined;
    // After the parenthesised command name, which may hold spaces: state, ppid, process group.
    const [state, , member] = stat?.slice(stat.lastIndexOf(')') + 2).split(' ') ?? [];

    return state !== undefined && state !== 'Z' && Number(member) === group;
  });
}

/** Who minted a scratch root, so a later run judges it by whether that process still runs. */
export const OWNER_RECORD = 'owner.json';

/** Record this process as `root`'s owner; where `/proc` cannot say, nothing is recorded. */
export function recordOwner(root: string): void {
  const owner = currentOwner();

  if (owner !== null) writeFileSync(join(root, OWNER_RECORD), JSON.stringify(owner));
}

/**
 * Remove every scratch root under `parent` whose recorded owner has ended; `keep` is the caller's own. Age says
 * nothing: an eval episode runs 30 minutes by design and an eval tier for hours, and the 30-minute bound this
 * replaced reaped live roots out from under them. A root with no readable record (minted before records existed,
 * or killed mid-write) is left to `scripts/preflight.ts --reclaim` rather than guessed at.
 */
export function reapAbandonedRoots(parent: string, keep: string): string[] {
  const reaped: string[] = [];

  for (const name of readdirSync(parent)) {
    const path = join(parent, name);

    if (!name.startsWith(SCRATCH_ROOT_PREFIX) || path === keep) continue;

    // A root is a directory; `kinu-scratch-held.json`, the release report, shares the prefix.
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    // Absent, or taken by a racing peer: nothing to judge.
    const text = tolerate(() => readFileSync(join(path, OWNER_RECORD), 'utf8'), 'enoent');
    const recorded = text === undefined ? undefined : v.safeParse(v.pipe(v.string(), v.parseJson(), ProcessOwnerSchema), text);

    if (!recorded?.success || ownerAlive(recorded.output)) continue;
    // A racing peer may remove it between the read and the rm; `force` covers that.
    rmSync(path, { recursive: true, force: true });
    reaped.push(path);
  }

  return reaped;
}
