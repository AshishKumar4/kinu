import type * as fs from 'node:fs';

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
