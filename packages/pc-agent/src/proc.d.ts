import type * as fs from 'node:fs';

// The CLI imports this module twice: its BYTES, to install beside the daemon (the default export, a
// text import), and its API, which the repository runners share (the named exports).
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
