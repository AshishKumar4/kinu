/**
 * Where a computer's process run as a job ends (`ComputerProcessEnds`): told while its job waits, it settles it; told
 * while none does (the workspace restarted and its job is not yet resumed), it is kept for the resume; told of a job that
 * no longer runs, nothing is kept.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { ComputerProcessEnds } from '@kinu.run/core';

function ends(running: (jobId: string) => boolean) {
  const db = new Database(':memory:');

  return {
    // As a Durable Object's SQL: each statement runs as it is issued, and its rows are read after.
    ends: new ComputerProcessEnds({
      exec: (query, ...bindings) => {
        const rows = db.query<Record<string, string | number | null>, (string | number | null)[]>(query).all(...bindings);

        return { toArray: () => rows };
      },
    }, running),
    kept: () => db.query('SELECT job FROM computer_process_ends').all(),
  };
}

describe("a computer process's end", () => {
  test('told while its job waits, settles it at once', async () => {
    const { ends: register, kept } = ends(() => true);
    const waiting = register.ended('bgjob-dev');

    register.record('bgjob-dev', { exitCode: 1, tail: 'EADDRINUSE' });

    expect(await waiting).toEqual({ exitCode: 1, tail: 'EADDRINUSE' });
    expect(kept()).toEqual([]);
  });

  test('told while none waits, is kept, and given once to the resume that asks', async () => {
    const { ends: register, kept } = ends(() => true);

    register.record('bgjob-api', { tail: 'lost' });

    expect(await register.ended('bgjob-api')).toEqual({ tail: 'lost' });
    expect(kept()).toEqual([]);
  });

  test('told of a job that no longer runs, keeps nothing', () => {
    const { ends: register, kept } = ends(() => false);

    register.record('bgjob-gone', { exitCode: 143, tail: '' });

    expect(kept()).toEqual([]);
  });
});
