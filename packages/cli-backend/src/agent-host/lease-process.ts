import process from 'node:process';
import * as v from 'valibot';
import type { LeaseProcess } from '@kinu.run/core';
import { toKinuError } from '@kinu.run/core/obs';
import { hostGenerationReader } from '../process-generation';

const ProcessSignalFailureSchema = v.looseObject({ code: v.optional(v.string()) });

/**
 * Process `pid` as a lease or job holder records it: its pid and the generation this host reads for it. A holder
 * still runs while its pid runs the generation it recorded; where either side has none, the pid alone answers.
 */
export function osLeaseProcess(pid: number): LeaseProcess {
  const reader = hostGenerationReader();
  const self = reader?.read(pid);

  return {
    pid,
    generation: self?.state === 'read' ? self.identity : '',
    isAlive: (holder) => {
      const probe = holder.generation === '' ? undefined : reader?.read(holder.pid);

      if (probe?.state === 'read') return probe.identity === holder.generation;

      return probe?.state === 'absent' ? false : pidRuns(holder.pid);
    },
  };
}

/** ESRCH means gone; EPERM means a live process this caller cannot signal. */
function pidRuns(pid: number): boolean {
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
}
