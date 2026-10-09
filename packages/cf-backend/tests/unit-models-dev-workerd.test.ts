/**
 * The models.dev catalog read in real workerd (the adjacent fixture): a request never waits on a read another request
 * started. On staging d930f2537 (2026-10-09, 03:09:43 to 03:10:04Z) one isolate's creates and model menus hung up to
 * 270 s: a request that joined another's catalog read waited on it, that request was cancelled, workerd dropped its
 * subrequest, and the joined read never settled; every later request on the isolate joined the same dead read. So
 * each request reads for itself here, and each case waits for the second request's own read to reach models.dev: a
 * read joined across requests never does, and the fixture then waits for good, where the ladder's silence bound
 * names it.
 */
import { describe, expect, test } from 'bun:test';
import { runToExit, scratchDir } from '@kinu.run/test-utils';
import * as v from 'valibot';

const fixture = new URL('./fixtures/models-dev-workerd.ts', import.meta.url).pathname;

const ResultSchema = v.object({
  together: v.object({ result: v.object({ a: v.number(), b: v.number() }), reads: v.number() }),
  cancel: v.object({ result: v.object({ a: v.number(), b: v.number() }), reads: v.number() }),
  after: v.object({ result: v.object({ a: v.number(), c: v.number() }), reads: v.number() }),
});

describe('a models.dev catalog read in workerd', () => {
  test('is each request\'s own: one whose neighbour was cancelled is answered, and so is one that comes after', async () => {
    const ran = await runToExit([process.execPath, fixture, scratchDir('models-dev-workerd')]);

    expect(ran.exitCode, ran.stderr).toBe(0);
    const result = v.parse(ResultSchema, JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? ''));

    // A cancelled client's answer is status 0; every other request is answered 200, from a read of its own.
    expect(result).toEqual({
      together: { result: { a: 200, b: 200 }, reads: 2 },
      cancel: { result: { a: 0, b: 200 }, reads: 2 },
      after: { result: { a: 0, c: 200 }, reads: 2 },
    });
  });
});
