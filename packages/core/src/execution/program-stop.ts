/**
 * A program's run, ended by its caller's signal or its deadline: it answers then, with an error that says which, and
 * whatever the program was awaiting is not waited for. A sandbox that can end the program itself is given the deadline
 * as well (`Executor.execute`'s `deadlineMs`); a run in this process cannot be preempted, only no longer awaited.
 */
import type { ExecuteResult, ProgramStop } from '../types/primitives';
import { abortableSleep, abortCause } from '../utils/abort';
import { NO_TIMER_DEADLINE_MS } from './types';

export async function stoppedProgram(run: () => Promise<ExecuteResult>, stop: ProgramStop = {}): Promise<ExecuteResult> {
  const { signal, deadlineMs } = stop;

  if (signal === undefined && deadlineMs === undefined) return run();

  if (signal?.aborted === true) return { result: undefined, error: `the program was stopped: ${abortCause(signal).message}` };

  // Aborted once the run settles too, so the wait's timer never outlives it.
  const settled = new AbortController();
  const ended = abortableSleep(deadlineMs ?? NO_TIMER_DEADLINE_MS, AbortSignal.any([settled.signal, ...(signal === undefined ? [] : [signal])]), 'resolve');

  const stopped = ended.then((): ExecuteResult => ({
    result: undefined,
    error: signal?.aborted === true
      ? `the program was stopped: ${abortCause(signal).message}`
      : `the program did not finish within ${String((deadlineMs ?? 0) / 1000)} s, so it was ended`,
  }));

  try {
    return await Promise.race([run(), stopped]);
  } finally {
    settled.abort();
  }
}
