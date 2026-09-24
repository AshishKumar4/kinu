/**
 * One process named across time: the boot, the pid and the pid's start time. A reused pid or a
 * reboot reads as a process that has ended, so whatever a process leaves behind is judged by
 * whether its owner still runs, never by its age. The bench teardown manifests
 * (`fixtures/storage-matrix/cleanup.ts`) and the test scratch homes judge their owners with it.
 */
import { tolerate } from '@kinu.run/core/obs';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';

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
