/**
 * Where a computer's process run as a job ends (`ComputerProcessEnds`): told, it settles the job's row before anything
 * else, then releases a waiting promise; a promise asked of a settled job answers at once, one asked before the row
 * exists waits.
 */
import { describe, expect, test } from 'bun:test';
import { ComputerProcessEnds, type ComputerProcessEnd } from '@kinu.run/core';

/** Job rows as a runner settles them: running until completed with an end. */
function rows(running: readonly string[]) {
  const live = new Set(running);
  const completed = new Map<string, ComputerProcessEnd>();

  const ends = new ComputerProcessEnds({
    state: (jobId) => {
      if (live.has(jobId)) return 'running';

      return completed.has(jobId) ? 'settled' : 'missing';
    },
    complete: async (jobId, end) => {
      if (!live.delete(jobId)) return;
      completed.set(jobId, end);
    },
  });

  return { ends, completed, live };
}

describe("a computer process's end", () => {
  test('told while its job waits, is on its row first, then releases the waiting promise', async () => {
    const { ends, completed } = rows(['bgjob-dev']);
    const waiting = ends.ended('bgjob-dev');

    await ends.record('bgjob-dev', { exitCode: 1, tail: 'EADDRINUSE' });

    expect(completed.get('bgjob-dev')).toEqual({ exitCode: 1, tail: 'EADDRINUSE' });
    expect(await waiting).toEqual({ exitCode: 1, tail: 'EADDRINUSE' });
  });

  test('asked before its row exists (the job is still being adopted), waits for the end', async () => {
    const { ends, live } = rows([]);
    let answered = false;

    const waiting = ends.ended('bgjob-new').then((end) => {
      answered = true;

      return end;
    });

    await Promise.resolve();
    expect(answered).toBe(false);
    live.add('bgjob-new');
    await ends.record('bgjob-new', { exitCode: 0, tail: 'done' });

    expect(await waiting).toEqual({ exitCode: 0, tail: 'done' });
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
