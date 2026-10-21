/**
 * Where a computer's process run as a job ends (`ComputerProcessEnds`): told while its job waits, it settles it; told
 * while none does (the workspace restarted and its job is not yet resumed), the job's row settles with it, so nothing
 * else keeps the fact; a resume after that returns at once.
 */
import { describe, expect, test } from 'bun:test';
import { ComputerProcessEnds, type ComputerProcessEnd } from '@kinu.run/core';

/** Job rows as a runner settles them: running until completed with an end. */
function rows(running: readonly string[]) {
  const live = new Set(running);
  const completed = new Map<string, ComputerProcessEnd>();

  const ends = new ComputerProcessEnds({
    running: (jobId) => live.has(jobId),
    complete: async (jobId, end) => {
      if (!live.delete(jobId)) return;
      completed.set(jobId, end);
    },
  });

  return { ends, completed, live };
}

describe("a computer process's end", () => {
  test('told while its job waits, settles it through the waiting promise, and no row is written apart', async () => {
    const { ends, completed } = rows(['bgjob-dev']);
    const waiting = ends.ended('bgjob-dev');

    await ends.record('bgjob-dev', { exitCode: 1, tail: 'EADDRINUSE' });

    expect(await waiting).toEqual({ exitCode: 1, tail: 'EADDRINUSE' });
    expect(completed.size).toBe(0);
  });

  test('told while none waits, settles the job row with it; a resume after that returns at once', async () => {
    const { ends, completed } = rows(['bgjob-api']);

    await ends.record('bgjob-api', { tail: 'lost' });

    expect(completed.get('bgjob-api')).toEqual({ tail: 'lost' });
    expect(await ends.ended('bgjob-api')).toEqual({ tail: '' });
  });

  test('told of a job that no longer runs, settles nothing', async () => {
    const { ends, completed } = rows([]);

    await ends.record('bgjob-gone', { exitCode: 143, tail: '' });

    expect(completed.size).toBe(0);
  });
});
