/**
 * A file download that breaks off midway, in real workerd over real HTTP (the adjacent fixture): the client's read of
 * the body fails, never answering short or empty. On production 914ae51e8 (2026-11-04) a read of a 15-byte file lost
 * its connection at the second chunk, the files route had answered 200, and Bun read the body as "": the first-run case
 * every-tool counted the file as never written.
 */
import { describe, expect, test } from 'bun:test';
import { runToExit, scratchDir } from '@kinu.run/test-utils';
import * as v from 'valibot';

const fixture = new URL('./fixtures/file-download-workerd.ts', import.meta.url).pathname;

const ReadSchema = v.object({ status: v.number(), body: v.nullable(v.string()), refused: v.boolean() });

describe('a file download in workerd', () => {
  test('that breaks off midway fails the client\'s read, and a whole one reads whole', async () => {
    const ran = await runToExit([process.execPath, fixture, scratchDir('file-download-workerd')]);

    expect(ran.exitCode, ran.stderr).toBe(0);
    const result = v.parse(v.object({ whole: ReadSchema, broken: ReadSchema }), JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? ''));

    expect(result).toEqual({
      whole: { status: 200, body: 'KINU-EVERY-TOOL', refused: false },
      broken: { status: 200, body: null, refused: true },
    });
  });
});
