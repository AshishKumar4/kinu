import process from 'node:process';
import * as v from 'valibot';
import type { LeaseProcess } from '@kinu.run/core';
import { toKinuError } from '@kinu.run/core/obs';

const ProcessSignalFailureSchema = v.looseObject({ code: v.optional(v.string()) });

/** ESRCH means gone; EPERM means a live process this caller cannot signal. */
export const OS_LEASE_PROCESS: LeaseProcess = {
  pid: process.pid,
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);

      return true;
    } catch (error) {
      const errno = v.safeParse(ProcessSignalFailureSchema, error);
      const code = errno.success ? errno.output.code : undefined;

      if (code === 'ESRCH') return false;

      if (code === 'EPERM') return true;
      throw toKinuError({
        doing: `test whether process ${String(pid)} is still running`,
        cause: error,
        otherwise: 'unavailable',
      });
    }
  },
};
