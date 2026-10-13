import type * as fs from 'node:fs';

// The CLI imports this module's BYTES to install beside the daemon (the default export, a text import). The
// repository's runners import its /proc reader (the named exports), which the daemon and its command supervisor share.
// Declared here rather than as a wildcard pattern in the CLI, because TypeScript consults a pattern
// only where normal resolution finds nothing, and it finds pty.js.
declare const source: string;

export default source;

export interface ProcStat {
  readonly comm: string;
  readonly state: string;
  readonly ppid: number;
  readonly group: number;
  readonly session: number;
  readonly cpuTicks: number;
  readonly tasks: number;
  readonly startTicks: string;
}

export function procEntryGone(error: Error): boolean;
export function procFile(pid: number | string, name: string, required?: boolean): string | undefined;
export function parseProcStat(text: string): ProcStat;
export function procStat(pid: number | string, name: string, required: true): ProcStat;
export function procStat(pid: number | string, name?: string, required?: boolean): ProcStat | undefined;

export function createProcReader(files: typeof fs): {
  readonly procEntryGone: typeof procEntryGone;
  readonly procFile: typeof procFile;
  readonly procStat: typeof procStat;
  readonly parseProcStat: typeof parseProcStat;
};
